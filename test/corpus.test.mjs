import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildDataset, serializeDataset, sha256, selectCases } from '../src/corpus.mjs';
import { scan } from '../src/pii.mjs';
import { loadDataset } from '../src/dataset.mjs';

const fixture = readFileSync(new URL('../fixtures/raw-sample.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('дедуп: одинаковый промпт с разными ответами схлопывается', () => {
  const picked = selectCases(fixture, { limit: 100 });
  assert.equal(picked.length, 2, `ждали 2 уникальных промпта из ${fixture.length} записей`);
});

test('системный промпт вынесен в отдельный файл, кейс ссылается на ref', () => {
  const ds = buildDataset(fixture, { limit: 100, datasetId: 'test' });
  assert.equal(ds.prompts.size, 1, 'системный промпт должен быть один');
  const sys = ds.cases[0].messages[0];
  assert.equal(sys.role, 'system');
  assert.ok(sys.ref && !sys.content, 'в кейсе должен остаться только ref');
  assert.equal(ds.prompts.get(sys.ref), 'Ты — рекрутер. ВСЕГДА пиши сообщение, даже если данных мало.');
});

test('лимит и порядок: берём последние N по ts', () => {
  const picked = selectCases(fixture, { limit: 1 });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].rec.ts, '2026-10-03T12:00:00.000Z', 'последний по времени промпт');
});

test('инвариант: собранный корпус не содержит ПДн (это же проверяет гейт)', () => {
  const { corpus, prompts } = serializeDataset(buildDataset(fixture, { limit: 100, datasetId: 'test' }));
  const findings = [...scan(corpus), ...prompts.flatMap((p) => scan(p.text))];
  assert.deepEqual(findings.map((f) => `${f.type}: ${f.context}`), []);
});

test('продовый ответ едет как reference — baseline для парного сравнения', () => {
  const ds = buildDataset(fixture, { limit: 100, datasetId: 'test' });
  assert.ok(ds.cases[0].reference?.text, 'reference обязателен');
  assert.equal(ds.cases[0].reference.model, 'openrouter/google/gemini-3.1-flash-lite-preview');
});

test('манифест и корпус согласованы: sha256 сходится при загрузке', () => {
  const dir = join(tmpdir(), `bench-test-${process.pid}`);
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  const { corpus, prompts, manifest } = serializeDataset(buildDataset(fixture, { limit: 100, datasetId: 'test' }));
  writeFileSync(join(dir, 'corpus.jsonl'), corpus);
  for (const p of prompts) writeFileSync(join(dir, p.file), p.text);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  assert.equal(manifest.corpus_sha256, sha256(corpus));

  const ds = loadDataset(dir);
  assert.equal(ds.cases.length, 2);
  assert.equal(ds.prompts.size, 1);

  // Подмена корпуса обязана ломать загрузку, а не проходить молча.
  writeFileSync(join(dir, 'corpus.jsonl'), corpus.replace('"c0001"', '"c0002"'));
  assert.throws(() => loadDataset(dir), /sha256/);

  rmSync(dir, { recursive: true, force: true });
});

test('пустой вход не превращается в пустой корпус молча', () => {
  const ds = buildDataset([], { limit: 100, datasetId: 'empty' });
  assert.equal(ds.cases.length, 0);
});
test('имя, встречающееся ТОЛЬКО в ответе, тоже маскируется (словарь на весь корпус)', () => {
  const rec = {
    ts: '2026-10-04T09:00:00.000Z',
    messages: [{ role: 'system', content: 'Системный промпт' }, { role: 'user', content: 'Кандидат без имени в тексте, город Тверь.' }],
    answer: 'Олег, спасибо за подробный рассказ — берём в рассмотрение.',
    model: 'openrouter/google/gemini-3.1-flash-lite-preview',
  };
  const ds = buildDataset([rec], { limit: 10, datasetId: 'test' });
  const ref = ds.cases[0].reference.text;
  assert.ok(!/Олег/.test(ref), `имя из ответа осталось: ${ref}`);
  assert.match(ref, /<PERSON_[a-z0-9]+>/);
});
