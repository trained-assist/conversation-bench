// Регрессы на реальном падении этапа оценки (04.10, прогон 4 пар на бесплатных ступенях):
//
//  1. blindPair() не получал id кейса и дергал `r.case` из чужой области видимости →
//     ReferenceError на ПЕРВОЙ записи, judge.mjs не мог завершиться физически.
//     Теперь id передаётся аргументом и приходит из c.id датасета.
//  2. Порядок A/B считался как charCodeAt(1) от id. На продовом корпусе все id вида
//     `c0001` — второй символ всегда '0', поэтому flip был всегда false: продовое письмо
//     уезжало в «A» ВСЕГДА. Судья со врождённым предпочтением первой стороны стабильно
//     голосовал против моделей-кандидатов — это тихая порча всего замера, а не «шум».
//
// Тест закрывает оба: порядок воспроизводим (детерминирован), но реально перемешан
// (на 100 продовых id обе стороны встречаются), и не падает на границах (пустой id).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flipFor } from '../src/blind.mjs';
import { deterministicChecks } from '../src/checks.mjs';

// Ровно тот формат id, что даёт extract-corpus на проде.
const prodIds = Array.from({ length: 100 }, (_, i) => `c${String(i + 1).padStart(4, '0')}`);

test('порядок A/B воспроизводим: один и тот же id — всегда одна сторона', () => {
  for (const id of prodIds) {
    const first = flipFor(id);
    for (let i = 0; i < 5; i++) assert.equal(flipFor(id), first, `id ${id} «плавает» между прогонами`);
  }
});

test('порядок A/B перемешан на продовых id, а не вырожден в «прод всегда A»', () => {
  const flips = prodIds.filter(flipFor).length;
  assert.ok(flips > 20 && flips < 80, `из ${prodIds.length} id кандидат уехал в A в ${flips} случаях — это не перемешивание`);
});

test('соседние id дают разные стороны (старый charCodeAt(1) давал одинаковые)', () => {
  // Регресс именно на исходный баг: у c0001..c0100 второй символ = '0'.
  assert.equal('c0001'.charCodeAt(1) % 2 === 1, false, 'старый способ всегда давал false — тест должен ловить это');
  const sides = prodIds.slice(0, 20).map(flipFor);
  assert.ok(sides.includes(true) && sides.includes(false), 'на первых 20 id обе стороны должны встречаться');
});

test('короткий и пустой id не роняют и не вырождают сторону', () => {
  for (const id of ['', 'x', 'c']) {
    const v = flipFor(id);
    assert.ok(v === true || v === false, `id=${JSON.stringify(id)} дал не-булево`);
  }
});

test('judge.mjs больше не ссылается на переменную из чужой области видимости', () => {
  const src = readFileSync(new URL('../scripts/judge.mjs', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function blindPair'));
  assert.ok(!/\(r\.case\b/.test(body), 'внутри blindPair больше нет обращения к r.case из внешнего цикла');
  assert.match(src, /blindPair\(c\.id,/, 'id кейса должен передаваться в blindPair явным аргументом');
});

test('детерминированные проверки по-прежнему работают на письме (судья не подменяет их)', () => {
  const det = deterministicChecks('Здравствуйте! Подскажите, когда удобно созвониться?', { isFirstTouch: true });
  assert.ok(Array.isArray(det.checks) && det.checks.length > 0);
});