import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { buildDataset, serializeDataset } from '../src/corpus.mjs';

// Скрипты прогоняются на верхнем уровне модуля (top-level await, запуск воркеров), поэтому
// ошибка вроде TDZ или опечатки в пути не ловится юнит-тестами модулей — CI звал только `node --test`,
// и run-bench падал на ПЕРВОМ же ответе. Здесь каждый скрипт реально запускается в --dry-run.
const ROOT = new URL('..', import.meta.url).pathname;
const fixture = readFileSync(join(ROOT, 'fixtures/raw-sample.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

const dir = join(tmpdir(), `bench-scripts-${process.pid}`);
mkdirSync(join(dir, 'prompts'), { recursive: true });
const { corpus, prompts, manifest } = serializeDataset(buildDataset(fixture, { limit: 100, datasetId: 'scripts' }));
writeFileSync(join(dir, 'corpus.jsonl'), corpus);
for (const p of prompts) writeFileSync(join(dir, p.file), p.text);
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const run = (script, args) =>
  execFileSync('node', [join(ROOT, 'scripts', script), '--dataset', dir, ...args], { encoding: 'utf8' });

test('run-bench --dry-run печатает план по всем ступеням', () => {
  const out = run('run-bench.mjs', ['--models', join(ROOT, 'models-free.json'), '--dry-run']);
  assert.match(out, /План: \d+ вызовов/);
  assert.match(out, /nemotron-3\.5-lightning-free/);
});

test('budget считает вход по собранному корпусу', () => {
  const results = join(dir, 'empty.jsonl');
  writeFileSync(results, '');
  const out = run('budget.mjs', ['--results', results]);
  assert.match(out, /доли входа/);
});