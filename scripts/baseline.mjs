#!/usr/bin/env node
// Строка «эталон» для отчёта: продовые ответы из корпуса как будто их написала модель
// prod-reference. Зачем:
//
//   1) это база, которую обязан набрать кандидат, — видно в одной таблице с кандидатами;
//   2) по ней видно, сколько ложных срабатываний у самих проверок: если эталон валится по
//      language_ru, виновата проверка, а не модель;
//   3) в отчёте сразу видно, где качество сверху (и почему «у всех 100%» — плохой знак).
//
// Судью эту строку судить нельзя (сравнение с самой собой даёт 100% ничьих) — judge.mjs
// исключает её через --skip-judge-models prod-reference.
//
//   node scripts/baseline.mjs --dataset datasets/prod-2026-10 --out results/run-baseline.jsonl
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { loadDataset } from '../src/dataset.mjs';

const args = parseArgs(process.argv.slice(2));
const ds = loadDataset(args.dataset ?? 'datasets/current');
const out = args.out ?? 'results/run-baseline.jsonl';
mkdirSync(dirname(out), { recursive: true });

const stream = createWriteStream(out);
let n = 0;
for (const c of ds.cases) {
  const text = c.reference?.text ?? '';
  if (!text.trim()) continue;
  stream.write(JSON.stringify({
    case: c.id,
    model: 'prod-reference',
    ladder: null,
    rung: null,
    role: 'baseline',
    text,
    finish: 'stop',
    usage: null,
    reported_model: c.reference.model ?? null,
    latency_ms: null,
    attempt: 1,
    temperature: c.prod?.temperature ?? null,
    note: 'продовый ответ из корпуса, не вызов модели',
  }) + '\n');
  n++;
}
stream.end();
await new Promise((r) => stream.on('finish', r));
console.log(`Эталонных строк: ${n} → ${out}`);

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith('--')) { o[k] = v; i++; } else o[k] = true;
  }
  return o;
}