#!/usr/bin/env node
// Две оценки за один проход:
//  1) детерминированные проверки (бесплатно) — см. src/checks.mjs;
//  2) слепой судья: продовый ответ и ответ кандидата подаются без имён, порядок определяется
//     детерминированно от case id — судья не знает, кто автор, и привязка воспроизводима.
//
//   node scripts/judge.mjs --results results/run.jsonl --dataset datasets/current --out results/run.judged.jsonl [--concurrency 3]
import { readFileSync, writeFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { deterministicChecks, repeatedQuestion, scoreChecks } from '../src/checks.mjs';
import { loadDataset } from '../src/dataset.mjs';
import { detectFirstTouch } from '../src/corpus.mjs';
import { ladderChat, ladderToken } from '../src/ladder.mjs';
import { flipFor } from '../src/blind.mjs';
import { parseJudgeJson } from '../src/judge-parse.mjs';
import { readModelConfig } from '../src/config.mjs';

const args = parseArgs(process.argv.slice(2));
const resultsFile = args.results;
const out = args.out ?? resultsFile.replace(/\.jsonl$/, '.judged.jsonl');

// Судья — тоже ступень НАШЕЙ лестницы, зафиксированная явно: температура 0 и одна и та же
// ступень во всех прогонах, иначе «слепой» судья начинает плавать между прогонами.
// По умолчанию берём блок judge из models.json, если он там есть.
const judgeCfg = args['judge-rung']
  ? { ladder: args['judge-ladder'] ?? 'conversation', rung: args['judge-rung'] }
  : readJudgeCfg(args.models ?? 'models.json');

const ds = loadDataset(args.dataset ?? 'datasets/current');
const byCase = new Map(ds.cases.map((c) => [c.id, c]));
const results = readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Строка, которая сама является эталоном (продовые ответы как «модель prod-reference»), судить
// бессмысленно: судья сравнил бы ответ с самим собой и нарисовал 100% ничьих. Такие строки
// проходят только детерминированный слой — а он по эталону показывает, сколько ложных
// срабатываний у самих проверок.
const skipJudge = new Set(
  String(args['skip-judge-models'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
);

mkdirSync(dirname(out), { recursive: true });

// Судья — сетевой вызов на каждый ответ, поэтому строки считаются пулом воркеров, а не по одной:
// на 700 ответах последовательный проход занимал больше часа. Порядок строк на выходе — как во
// входном файле (судья идёт по case id, но файл результатов должен оставаться воспроизводимым),
// поэтому ответы пишем в буфер и сливаем в конце, а не по мере готовности.
const concurrency = Math.max(1, Number(args.concurrency ?? 3) || 3);
const entries = new Array(results.length);
let next = 0;
let done = 0;

async function worker() {
  while (next < results.length) {
    const i = next++;
    entries[i] = await scoreOne(results[i]);
    if (++done % 50 === 0 || done === results.length) {
      console.error(`  ${done}/${results.length}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, results.length) }, () => worker()));

const stream = createWriteStream(out);
for (const e of entries) if (e) stream.write(JSON.stringify(e) + '\n');
stream.end();
await new Promise((r) => stream.on('finish', r));
console.log(`Оценено ${entries.filter(Boolean).length} из ${results.length} → ${out}`);

async function scoreOne(r) {
  const c = byCase.get(r.case);
  if (!c) return null;
  const prevCandidates = c.messages
    .filter((m) => m.role !== 'system')
    .map((m) => m.content ?? '');
  const isFirst = detectFirstTouch(c);

  // Промпт и эталонный ответ нужны самим проверкам: плейсхолдеры, которые есть в них, —
  // законные (корпус обезличен), а сочиненные моделью — нет.
  const det = deterministicChecks(r.text, {
    isFirstTouch: isFirst,
    promptText: prevCandidates.join('\n'),
    referenceText: c.reference?.text ?? '',
  });
  if (repeatedQuestion(r.text, prevCandidates)) det.checks.push({ name: 'no_repeat_question', pass: false, detail: 'вопрос уже был в истории' });
  else det.checks.push({ name: 'no_repeat_question', pass: true, detail: '' });

  const entry = { ...r, deterministic: { ...scoreChecks(det.checks), checks: det.checks } };

  if (!r.error && c.reference?.text && ladderToken() && !skipJudge.has(r.model)) {
    entry.judge = await blindPair(c.id, c.reference.text, r.text, prevCandidates, judgeCfg);
  }
  return entry;
}

async function blindPair(caseId, prodText, candText, history, cfg) {
  const model = `${cfg.ladder}/${cfg.rung}`;
  // Стабильный порядок: бит из всего id → A/B. Перемешивание есть, воспроизводимо,
  // и не вырождается в «прод всегда A» (см. src/blind.mjs).
  const flip = flipFor(caseId);
  const A = flip ? candText : prodText;
  const B = flip ? prodText : candText;
  const rubric = `Ты оцениваешь письма рекрутера кандидату (рубрика 0–2 по каждому пункту).
Пункты: goal — цель достигнута (есть приветствие при первом касании, понятное предложение или вопрос);
facts — факты не выдуманы (нет компаний/дат/условий, которых нет в истории);
repeats — нет повторов (не переспрашивает уже известное, не повторяет предыдущее письмо);
tone — тон деловой, вежливый, без навязчивости; natural — звучит как человек, не как шаблон.

История переписки (системные роли скрыты):
${history.join('\n---\n').slice(0, 6000)}

Письмо A:
${A}

Письмо B:
${B}

Ответь строго JSON: по каждому пункту — массив из двух чисел 0–2 (первое для письма A, второе для B).
{"goal":[0,0],"facts":[0,0],"repeats":[0,0],"tone":[0,0],"natural":[0,0],"winner":"A"|"B"|"tie","comment":"до 200 символов"}`;

// Судья отвечает через же лестницу, и она иногда отдаёт 502 (у суточной квоты relay
  // и у rate limit провайдера такое бывает). Без повтора кейс выпадал из оценки молча:
  // в отчёте он выглядел как «не измерен», а причина была в транспорте, а не в модели.
  const call = async () => {
    let last;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await ladderChat({
          messages: [{ role: 'user', content: rubric }],
          ladder: cfg.ladder,
          rung: cfg.rung,
          temperature: 0,
          maxTokens: 1200,
          responseFormat: { type: 'json_object' },
          source: 'conversation-bench-judge',
        });
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    throw last;
  };

  try {
    const raw = (await call()).content;
    // Модель часто дописывает хвост после объекта — вынимаем первый валидный JSON,
    // иначе кейс выпадал из оценки (см. src/judge-parse.mjs).
    const parsed = parseJudgeJson(raw);
    // Судья выносит вердикт про A/B; возвращаем, кто выиграл у ПРОДА.
    const winner = parsed.winner;
    const prodWon = winner === (flip ? 'B' : 'A');
    return {
      model,
      winner_raw: winner,
      vs_prod: winner === 'tie' ? 'tie' : prodWon ? 'prod' : 'candidate',
      scores: { A: pickScores(parsed, 0), B: pickScores(parsed, 1) },
      comment: parsed.comment ?? '',
    };
  } catch (e) {
    return { error: String(e.message ?? e), model };
  }
}

function pickScores(parsed, i) {
  const out = {};
  for (const k of ['goal', 'facts', 'repeats', 'tone', 'natural']) {
    const v = Array.isArray(parsed[k]) ? parsed[k][i] : parsed[k];
    if (typeof v === 'number') out[k] = v;
  }
  return out;
}

// Блок judge из models.json: { "ladder": …, "rung": … }. Без него — дефолт лестницы
// conversation (та ступень, которой прод пишет письма кандидатам).
function readJudgeCfg(modelsFile) {
  try {
    const cfg = readModelConfig(modelsFile).judge;
    if (cfg?.ladder && cfg?.rung) return { ladder: cfg.ladder, rung: cfg.rung };
  } catch { /* нет файла или блока — дефолт ниже */ }
  return { ladder: 'conversation', rung: 'openrouter/google/gemini-2.5-flash' };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const n = argv[i + 1];
    if (n && !n.startsWith('--')) { o[k] = n; i++; } else o[k] = true;
  }
  return o;
}