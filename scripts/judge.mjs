#!/usr/bin/env node
// Две оценки за один проход:
//  1) детерминированные проверки (бесплатно) — см. src/checks.mjs;
//  2) слепой судья: продовый ответ и ответ кандидата подаются без имён, порядок определяется
//     детерминированно от case id — судья не знает, кто автор, и привязка воспроизводима.
//
//   node scripts/judge.mjs --results results/run.jsonl --dataset datasets/current --out results/run.judged.jsonl
import { readFileSync, writeFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { deterministicChecks, repeatedQuestion, scoreChecks } from '../src/checks.mjs';
import { loadDataset } from '../src/dataset.mjs';

const args = parseArgs(process.argv.slice(2));
const resultsFile = args.results;
const judgeModel = args['judge-model'] ?? 'openrouter/google/gemini-2.5-flash';
const out = args.out ?? resultsFile.replace(/\.jsonl$/, '.judged.jsonl');
const apiKey = process.env.OPENROUTER_API_KEY;

const ds = loadDataset(args.dataset ?? 'datasets/current');
const byCase = new Map(ds.cases.map((c) => [c.id, c]));
const results = readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

mkdirSync(dirname(out), { recursive: true });
const stream = createWriteStream(out);

for (const r of results) {
  const c = byCase.get(r.case);
  if (!c) continue;
  const prevCandidates = c.messages
    .filter((m) => m.role !== 'system')
    .map((m) => m.content ?? '');
  const isFirst = prevCandidates.length <= 1;

  const det = deterministicChecks(r.text, { isFirstTouch: isFirst });
  if (repeatedQuestion(r.text, prevCandidates)) det.checks.push({ name: 'no_repeat_question', pass: false, detail: 'вопрос уже был в истории' });
  else det.checks.push({ name: 'no_repeat_question', pass: true, detail: '' });

  const entry = { ...r, deterministic: { ...scoreChecks(det.checks), checks: det.checks } };

  if (!r.error && c.reference?.text && apiKey) {
    entry.judge = await blindPair(c.reference.text, r.text, prevCandidates, judgeModel);
  }
  stream.write(JSON.stringify(entry) + '\n');
}
stream.end();
await new Promise((r) => stream.on('finish', r));
console.log(`Оценено ${results.length} → ${out}`);

async function blindPair(prodText, candText, history, model) {
  // Стабильный порядок: первая буква case id → A/B. Перемешивание есть, но воспроизводимо.
  const flip = (r.case ?? '').charCodeAt(1) % 2 === 1;
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

  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, temperature: 0,
        messages: [{ role: 'user', content: rubric }],
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) return { error: `${res.status}`, model };
    const json = await res.json();
    const raw = json.choices?.[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw);
    // Судья выносит вердикт про A/B; возвращаем, кто выиграл у ПРОДА.
    const winner = parsed.winner;
    const prodWon = winner === (flip ? 'B' : 'A');
    const candWon = winner === (flip ? 'A' : 'B');
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