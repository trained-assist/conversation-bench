// Регресс на реальном падении судьи (04.10): свободная модель дописывает хвост после
// объекта, JSON.parse падает — кейс выпадал из оценки, ошибка была нечитаемой.
// Контракт: первый валидный JSON-объект в тексте разбирается, мусор вокруг игнорируется,
// скобки внутри строк не путают границы, а отсутствие объекта — явная ошибка с цитатой.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJudgeJson } from '../src/judge-parse.mjs';

test('чистый JSON проходит как есть', () => {
  const p = parseJudgeJson('{"goal":[1,2],"winner":"A","comment":"ok"}');
  assert.equal(p.winner, 'A');
  assert.deepEqual(p.goal, [1, 2]);
});

test('хвост после объекта не ломает разбор', () => {
  const p = parseJudgeJson('{"goal":[1,2],"winner":"B","comment":"так лучше"}\n\nНадеюсь, помог!');
  assert.equal(p.winner, 'B');
});

test('подпись и преамбула перед объектом игнорируются', () => {
  const p = parseJudgeJson('Вот оценка:\n{"goal":[2,2],"facts":[1,1],"repeats":[2,2],"tone":[2,2],"natural":[2,2],"winner":"tie","comment":"равно"}');
  assert.equal(p.winner, 'tie');
});

test('множественные объекты: берётся первый, хвост отбрасывается', () => {
  const p = parseJudgeJson('{"winner":"A"} и ещё {"winner":"B"}');
  assert.equal(p.winner, 'A');
});

test('фигурные скобки внутри строк не обрывают объект', () => {
  const p = parseJudgeJson('{"winner":"A","comment":"смайлик {и} скобки \\"внутри\\" завершены"} хвост');
  assert.equal(p.winner, 'A');
  assert.match(p.comment, /скобки/);
});

test('без объекта — явная ошибка, а не тихий пропуск', () => {
  assert.throws(() => parseJudgeJson('не буду отвечать'), /нет JSON-объекта/);
  assert.throws(() => parseJudgeJson(''), /пустой ответ/);
});

test('незакрытый объект — ошибка с цитатой для диагностики', () => {
  assert.throws(() => parseJudgeJson('{"winner":"A"'), /не закрыт/);
});
