import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { discoverNames, pseudonymize, scan } from '../src/pii.mjs';

const raw = readFileSync(new URL('../fixtures/raw-sample.jsonl', import.meta.url), 'utf8');
const first = JSON.parse(raw.split('\n')[0]);
const userText = first.messages[1].content;
const answerText = first.answer;

test('discoverNames находит имя из обращения и полное имя', () => {
  const names = discoverNames(userText + ' ' + answerText);
  assert.ok(names.includes('Иван'), `нет «Иван» в ${JSON.stringify(names)}`);
  assert.ok(names.includes('Петров'), `нет «Петров» в ${JSON.stringify(names)}`);
  assert.ok(!names.includes('Москва'), 'город не должен считаться именем');
});

test('pseudonymize убирает контакты, имя и приводит зарплату к шагу', () => {
  const clean = pseudonymize(userText + ' ' + answerText);
  assert.ok(!/ivan\.petrov@mail\.ru/.test(clean), 'почта осталась');
  assert.ok(!/\+7 916 123-45-67/.test(clean), 'телефон остался'); // pii-allow: синтетический телефон в тесте
  assert.ok(!/t\.me\//.test(clean), 'telegram остался');
  assert.ok(!/\bИван Петров\b/.test(clean), 'полное имя осталось');
  assert.ok(!/(?<![\p{L}])Иван(?![\p{L}])/u.test(clean), 'имя осталось');
  assert.ok(!/185000/.test(clean), 'точная зарплата осталась');
  assert.match(clean, /190000|180000\s+руб/, 'зарплата должна остаться, но с шагом 10к');
});

test('скан обезличенного текста не находит ПДн (инвариант гейта)', () => {
  const clean = pseudonymize(userText + ' ' + answerText);
  const findings = scan(clean);
  assert.deepEqual(findings.map((f) => f.type), [], JSON.stringify(findings, null, 2));
});

test('скан находит ПДн в сырье (гейт не слепой)', () => {
  const findings = scan(userText);
  const types = new Set(findings.map((f) => f.type));
  assert.ok(types.has('email'), 'не нашёл email');
  assert.ok(types.has('phone'), 'не нашёл телефон');
  assert.ok(types.has('telegram'), 'не нашёл telegram');
  assert.ok(types.has('full_name'), 'не нашёл полное имя');
});

test('идентичные замены детерминированы: повторное имя — тот же токен', () => {
  const clean = pseudonymize('Ивану Петрову писал Иван. Ивану — снова.'); // pii-allow: синтетическое ФИО
  const tokens = [...new Set(clean.match(/<PERSON_[^>]+>/g) ?? [])];
  const occurrences = clean.match(/<PERSON_[^>]+>/g) ?? [];
  assert.equal(occurrences.length, 4, `ожидал 4 замены (Иван×3, Петров×1), получено: ${clean}`);
  assert.equal(tokens.length, 2, `ожидал 2 разных токена (Иван, Петров), получено: ${JSON.stringify(tokens)}`);
});

test('зарплата: шаг 10к, но сам факт зарплаты остаётся', () => {
  assert.match(pseudonymize('жду 178000 руб'), /180000|170000/);
  assert.match(pseudonymize('жду 210 000 ₽'), /210000|200000/);
});
test('ИНН не ищется внутри хешей и ref-строк (регрессия: \p{L} без флага u)', () => {
  const withRef = '{"role":"system","ref":"8c75510960347dff"}';
  assert.deepEqual(scan(withRef), [], 'цифры внутри hex-ref не должны читаться как ИНН');
  assert.equal(scan('ИНН 7707083893 у клиента').length, 1, 'настоящий ИНН должен ловиться'); // pii-allow: юрлицо, не ПДн
});

test('кириллические границы работают: соседние буквы не позволяют.match', () => {
  assert.deepEqual(scan('Иван Петров'), [{ type: 'full_name', at: 0, context: 'Иван Петров' }]); // pii-allow: синтетическое ФИО
  assert.deepEqual(scan('ИванПетров'), [], 'слитное слово — не ФИО');
});
