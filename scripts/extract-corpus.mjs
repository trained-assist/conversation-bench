#!/usr/bin/env node
// Сбор корпуса из СЫРОГО jsonl прода. Читает stdin — чтобы сырьё не пришлось копировать на диск:
//
//   ssh vm "cat /home/vova/agent-data/hh/conversation-history.jsonl" \
//     | node scripts/extract-corpus.mjs --limit 100 --out datasets/prod-2026-10
//
// Наружу уходит только обезличенное. Остатки ПДн — ошибка (exit 1), а не предупреждение.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { buildDataset, serializeDataset } from '../src/corpus.mjs';

const args = parseArgs(process.argv.slice(2));
const outDir = args.out ?? 'datasets/current';
const limit = Number(args.limit ?? 100);
const datasetId = args.dataset ?? `prod-${new Date().toISOString().slice(0, 10)}`;
const pii = {
  salaryMode: args.salary ?? 'bucket',   // bucket | keep | drop
  urlMode: args.urls ?? 'hash',           // hash | keep
};

const source = args.file ?? 0;
const raw = readFileSync(source, 'utf8');
const records = [];
for (const line of raw.split('\n')) {
  const t = line.trim();
  if (!t) continue;
  try { records.push(JSON.parse(t)); } catch { /* битая строка — пропускаем, считаем ниже */ }
}
if (records.length === 0) {
  console.error('Не разобралось ни одной записи — проверь формат stdin.');
  process.exit(2);
}

const ds = buildDataset(records, { limit, datasetId, pii, strict: true });
const { corpus, prompts, manifest } = serializeDataset(ds);

if (args.dryRun) {
  console.log(JSON.stringify({ manifest, leaks: ds.leaks.length }, null, 2));
  process.exit(ds.leaks.length ? 1 : 0);
}

mkdirSync(join(outDir, 'prompts'), { recursive: true });
for (const p of prompts) {
  const target = join(outDir, p.file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, p.text);
}
writeFileSync(join(outDir, manifest.corpus_file), corpus);
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const corpusKb = Math.round(corpus.length / 1024);
const promptsKb = Math.round(prompts.reduce((a, p) => a + p.text.length, 0) / 1024);
console.log(`Готово: ${manifest.cases} кейсов, корпус ${corpusKb} КБ, промпты ${promptsKb} КБ → ${outDir}`);
console.log(`sha256 корпуса: ${manifest.corpus_sha256}`);

if (ds.leaks.length) {
  console.error(`\nОСТАтки ПДн: ${ds.leaks.length}. Датасет НЕ пригоден к публикации.`);
  for (const leak of ds.leaks.slice(0, 10)) {
    console.error(`  ${leak.case} ${leak.where}: ${leak.findings.map((f) => f.type).join(', ')}`);
  }
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}