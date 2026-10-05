// Регрессы, найденные на живом прогоне 04.10:
//  1) models.json в формате лестницы обязателен — без пары ladder+rung прогон падал на старте;
//  2) цена в отчёте ищется по id, а не по исчезнувшему полю model (иначе колонка «$/письмо» — «—»);
//  3) блок judge читается из того же конфига, а не из дефолта;
//  4) scripts/budget.mjs считает доли входа на синтетическом датасете и печатает калибровку.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readModelConfig, priceById } from '../src/config.mjs';

const REPO = new URL('..', import.meta.url).pathname;

test('models.json и models-free.json читаются: у каждой модели id + ladder + rung', () => {
  for (const file of ['models.json', 'models-free.json']) {
    const cfg = readModelConfig(join(REPO, file));
    assert.ok(cfg.models.length >= 3, `${file}: подозрительно мало моделей`);
    const ids = new Set();
    for (const m of cfg.models) {
      assert.ok(m.id, `${file}: модель без id`);
      assert.ok(m.ladder && m.rung, `${file}: у ${m.id} нет пары ladder+rung`);
      assert.match(m.rung, /^(openrouter|opencode-go|opencode-zen)\/[^/]+(?:\/.+)?$/, `${file}: rung ${m.rung} не похож на ступень лестницы`);
      assert.ok(!ids.has(m.id), `${file}: id ${m.id} повторяется`);
      ids.add(m.id);
      assert.equal(m.model, m.id, `${file}: поле model должно совпадать с id — по нему пишутся результаты`);
    }
  }
});

test('цены платных ступеней доступны по id (иначе отчёт молча показывает «—»)', () => {
  const { models } = readModelConfig(join(REPO, 'models.json'));
  const prices = priceById(models);
  for (const m of models) {
    assert.ok(prices[m.id], `нет цены для ${m.id}`);
    assert.ok(Number.isFinite(prices[m.id].input) && Number.isFinite(prices[m.id].output), `цена ${m.id} не числа`);
  }
});

test('блок judge задан явно парой ladder+rung', () => {
  const { judge } = readModelConfig(join(REPO, 'models.json'));
  assert.ok(judge, 'в models.json нет блока judge — судья молча уедет на дефолт');
  assert.ok(judge.ladder && judge.rung, 'блок judge без пары ladder+rung игнорируется readJudgeCfg');
});

test('битый конфиг падает с внятной ошибкой, а не молча', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-cfg-'));
  const bad = (obj, name) => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(obj));
    return p;
  };
  assert.throws(() => readModelConfig(bad({ models: [{ id: 'a' }] }, 'no-ladder.json')), /ladder\+rung/);
  assert.throws(
    () => readModelConfig(bad({ models: [{ id: 'a', ladder: 'conversation', rung: 'openrouter/x/y' }, { id: 'a', ladder: 'conversation', rung: 'openrouter/x/z' }] }, 'dup.json')),
    /id "a"/,
  );
  assert.throws(
    () => readModelConfig(bad({ models: [{ id: 'a', ladder: 'conversation', rung: 'gemini' }] }, 'bare-rung.json')),
    /ступень лестницы/,
  );
});

test('scripts/budget.mjs печатает доли входа, экономию и калибровку по прогону', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-budget-'));
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  const sysPrompt = 'Системный промпт. '.repeat(200);
  writeFileSync(join(dir, 'prompts', 'sys.txt'), sysPrompt);
  const user =
    'Сжатый профиль кандидата: 5 лет опыта, стек XYZ.\n\n' +
    'История переписки:\n— Кандидат: когда готовы начать?\n— Рекрутер: в понедельник.\n\n' +
    'Задача письма: уточнить размер команды.\n\n' +
    'Доступность: сегодня до 18:00\n\nДействие воронки: ответить';
  const corpus =
    JSON.stringify({
      id: 'c1',
      messages: [
        { role: 'system', ref: 'sys' },
        { role: 'user', content: user },
      ],
      reference: { text: 'Добрый день! Подскажите, сколько человек в команде?' },
    }) + '\n';
  writeFileSync(join(dir, 'corpus.jsonl'), corpus);
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      dataset: 'test-fixture',
      cases: 1,
      corpus_file: 'corpus.jsonl',
      corpus_sha256: createHash('sha256').update(corpus).digest('hex'),
      pii: { level: 'de-identified' },
    }),
  );

  const resultsPath = join(dir, 'run.jsonl');
  writeFileSync(
    resultsPath,
    JSON.stringify({ case: 'c1', model: 'm', text: 'x', usage: { prompt_tokens: 9000, completion_tokens: 120 } }) + '\n',
  );

  const out = execFileSync(process.execPath, [join(REPO, 'scripts', 'budget.mjs'), '--dataset', dir, '--results', resultsPath], { encoding: 'utf8' });
  assert.match(out, /системный промпт \d/);
  assert.match(out, /сжатая история \d/);
  assert.match(out, /экономия входа платной модели в двухшаговой схеме/);
  assert.match(out, /деньги на 1000 писем/);
  assert.match(out, /калибровка «оценка → факт»/);
});
test('строка эталона (role: baseline) не требует пары ladder+rung', async () => {
  const { readModelConfig } = await import('../src/config.mjs');
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'bench-cfg-'));
  const file = join(dir, 'models.json');
  writeFileSync(file, JSON.stringify({
    models: [
      { id: 'prod-reference', role: 'baseline', note: 'продовые ответы из корпуса' },
      { id: 'mimo', ladder: 'conversation', rung: 'opencode-go/mimo-v2.6-flash' },
    ],
  }));
  const cfg = readModelConfig(file);
  assert.equal(cfg.models.length, 2);
  assert.equal(cfg.models[0].id, 'prod-reference');
  rmSync(dir, { recursive: true, force: true });
});
