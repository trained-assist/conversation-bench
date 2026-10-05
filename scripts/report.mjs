#!/usr/bin/env node
// Сводная таблица: качество / цена / скорость по каждой модели. На выходе markdown —
// его же можно публиковать владельцу без пересказа.
//
//   node scripts/report.mjs --results results/run.judged.jsonl --models models.json --out results/report.md
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readModelConfig, priceById } from '../src/config.mjs';

const sumScores = (j) => {
  const s = j.scores?.A ?? {};
  const v = Object.values(s).reduce((a, b) => a + (Number(b) || 0), 0);
  return v;
};
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

// Колонки отчёта называются так, как их читает человек, а не как они зовутся в коде:
// «Дет. проверки 71%» не отвечает на вопрос «что чинить», а «Без иероглифов 97%» отвечает.
const CHECK_LABELS = {
  language_ru: 'По-русски',
  length_120_1500: 'Длина ок',
  no_refusal: 'Без отказа',
  no_service_noise: 'Без служебного шума',
  greeting: 'Приветствие',
  asks_question: 'Есть вопрос',
  no_repeat_question: 'Без повторов вопроса',
  no_cjk: 'Без иероглифов',
  no_markdown: 'Без разметки',
  no_placeholder_leak: 'Без плейсхолдеров',
  no_symbol_spam: 'Без мусора',
};
// Легенда под таблицей: что именно ловит каждая проверка, одной строкой.
const CHECK_LEGEND = [
  ['По-русски', 'доля кириллицы в ответе > 0.5; токены обезличивания <PERSON_…> не считаются'],
  ['Длина ок', '120–1500 символов'],
  ['Без отказа', 'нет «не могу помочь», «как языковая модель» и подобных'],
  ['Без служебного шума', 'нет «кандидат», «промпт», «system:», «ats» — служебный слой в письме'],
  ['Приветствие / Есть вопрос', 'только для первого касания'],
  ['Без повторов вопроса', 'не переспрашивает то, что кандидат уже назвал'],
  ['Без иероглифов', 'нет кандзи, кана, хангля, полноширинных форм'],
  ['Без разметки', 'письмо — plain text: нет **, #, буллетов, «Тема:», разделителей'],
  ['Без плейсхолдеров', 'нет [Название компании] и подобных, которых нет в промпте и в эталоне'],
  ['Без мусора', '≤ 2 эмодзи, нет разделителей из одинаковых символов'],
];
// Отчёт может печатать и наш id, и «сырую» ступень лестницы (provider/model) — убираем
// префикс провайдера, чтобы колонка читалась: opencode-go/mimo → mimo.
const short = (m) => m.replace(/^(openrouter|opencode-go|opencode-zen|zen-pool)\//, '');
const sorted = (a) => [...a].sort((x, y) => x - y);
const median = (a) => (a.length ? sorted(a)[Math.floor(a.length / 2)] : null);
const quant = (a, q) => (a.length ? sorted(a)[Math.min(sorted(a).length - 1, Math.floor(a.length * q))] : null);
const p50 = (a) => quant(a, 0.5);
const p95 = (a) => quant(a, 0.95);

const args = parseArgs(process.argv.slice(2));
const rows = readFileSync(args.results, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const models = readModelConfig(args.models ?? 'models.json').models;
// Ключ цены — id модели: в models.json после перехода на формат лестницы поля `model` уже нет,
// и цена молча превратилась бы в «—». Старое поле `model` держим как фолбэк.
const price = priceById(models);

const groups = new Map();
for (const r of rows) {
  if (!groups.has(r.model)) groups.set(r.model, []);
  groups.get(r.model).push(r);
}

const table = [...groups.entries()].map(([model, rs]) => {
  const ok = rs.filter((r) => !r.error);
  const detPass = ok.filter((r) => r.deterministic?.all_pass);
  const judged = ok.filter((r) => r.judge && !r.judge.error);
  const candWins = judged.filter((r) => r.judge.vs_prod === 'candidate');
  const ties = judged.filter((r) => r.judge.vs_prod === 'tie');

  const tin = median(ok.map((r) => r.usage?.prompt_tokens).filter(Number));
  const tout = median(ok.map((r) => r.usage?.completion_tokens).filter(Number));
  const reason = median(ok.map((r) => r.usage?.completion_tokens_details?.reasoning_tokens).filter(Number)) ?? 0;
  const p = price[model] ?? {};
  // Цена и сумма судьи считаются только когда есть чем считать: у строки «эталон» нет usage
  // (это не вызов модели), а $0.00000 в отчёте читается как «бесплатно», а не «не измерено».
  const cost = ok.some((r) => r.usage)
    ? ok.reduce((a, r) => {
        const u = r.usage ?? {};
        return a + ((u.prompt_tokens ?? 0) * (p.input ?? 0) + (u.completion_tokens ?? 0) * (p.output ?? 0)) / 1e6;
      }, 0) / ok.length
    : null;

  return {
    model: short(model),
    n: rs.length,
    errors: rs.length - ok.length,
    det: pct(detPass.length, ok.length),
    win: pct(candWins.length, judged.length),
    tie: pct(ties.length, judged.length),
    tin, tout, reason,
    // Рассуждения съедают лимит ответа: у nemotron 356 из 664 токенов. Без этой колонки
    // ступень с большим thinking выглядит дороже и длиннее, чем ступень, которая реально
    // потратила лимит на текст письма.
    maxTok: median(ok.map((r) => r.max_tokens).filter(Number)) ?? null,
    cost: cost == null ? '—' : `$${cost.toFixed(5)}`,
    p50: p50(ok.map((r) => r.latency_ms)),
    p95: p95(ok.map((r) => r.latency_ms)),
    judgeSum: judged.length ? judged.reduce((a, r) => a + sumScores(r.judge), 0) / judged.length : null,
    perCheck: perCheckRates(ok),
  };
});

table.sort((a, b) => b.win.localeCompare(a.win) || b.det.localeCompare(a.det));

// Порядок колонок — как в CHECK_LABELS: сначала язык и форма, потом мусор.
const checkOrder = Object.keys(CHECK_LABELS);
const checkNames = [...new Set(table.flatMap((t) => Object.keys(t.perCheck)))]
  .sort((a, b) => checkOrder.indexOf(a) - checkOrder.indexOf(b));

const md = [
  '# Отчёт бенчмарка писем кандидатам',
  '',
  `Прогон: ${args.results} · кейсов: ${rows.length} · дата: ${new Date().toISOString().slice(0, 16)}Z`,
  '',
  `| Модель | Ответов | Ошибок вызова | Годных писем | ${checkNames.map((c) => CHECK_LABELS[c] ?? c).join(' | ')} | Побед vs прод | Ничьи | Токены в | Токены out | Из них рассуждения | Лимит ответа | $/письмо | p50 мс | p95 мс | Сумма судьи |`,
  `|---|---|---|---|${checkNames.map(() => '---').join('|')}|---|---|---|---|---|---|---|---|---|`,
  ...table.map((t) =>
    `| ${t.model} | ${t.n} | ${t.errors} | ${t.det} | ${checkNames.map((c) => t.perCheck[c] ?? '—').join(' | ')} | ${t.win} | ${t.tie} | ${t.tin ?? '—'} | ${t.tout ?? '—'} | ${t.reason || '—'} | ${t.maxTok ?? '—'} | ${t.cost} | ${t.p50 ?? '—'} | ${t.p95 ?? '—'} | ${t.judgeSum == null ? '—' : `${t.judgeSum.toFixed(1)}/10`} |`),
  '',
  '**Годных писем** — доля ответов, прошедших все проверки сразу. **Ошибок вызова** — транспорт',
  '(429/401/502, пустой ответ), а не качество письма: ступень не ответила, и кейс не измерен.',
  'Колонки ниже — доля ответов, прошедших каждую проверку по отдельности.',
  '',
  ...CHECK_LEGEND.map(([name, what]) => `- **${name}** — ${what}`),
  '',
  'Судья слепой: продовый ответ и кандидат перемешаны, автор неизвестен. Проверки — бесплатно и до судьи.',
  'Лимит ответа в проде — 800 (hh-142-chain/src/conversation-generation.js); в бенче он выше у reasoning-ступеней, иначе ответ приходит пустым. Сравнивать лимиты надо по колонке «Лимит ответа».',
  'Решение о перестановке лестницы принимается по quality floor, затем Pareto «цена/качество» — не «дешёвый = победитель».',
].join('\n');

if (args.out) {
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, md);
  console.log(`→ ${args.out}`);
}
console.log(md);

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

/** Доля ответов, прошедших каждую проверку поимённо: {language_ru: '96%', …}. */
function perCheckRates(ok) {
  const out = {};
  for (const r of ok) {
    for (const c of r.deterministic?.checks ?? []) {
      if (!out[c.name]) out[c.name] = { pass: 0, total: 0 };
      out[c.name].total++;
      if (c.pass) out[c.name].pass++;
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, pct(v.pass, v.total)]));
}