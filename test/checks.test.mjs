import test from 'node:test';
import assert from 'node:assert/strict';
import { deterministicChecks } from '../src/checks.mjs';
import { detectFirstTouch } from '../src/corpus.mjs';

const check = (name, text, opts) =>
  deterministicChecks(text, opts).checks.find((c) => c.name === name);

// Письмо продового вида: обращение по имени, два абзаца, вопрос в конце. Таких ответов
// в эталонном корпусе 100 из 100, и ни одна проверка на них не должна срабатывать —
// иначе проверка измеряет не дефект модели, а свой же порог.
const prodLike =
  'Дмитрий, здравствуйте!\n\n' +
  'Ваш опыт работы с маркетплейсами и аналитика карточек выглядит убедительно, поэтому мы хотели бы ' +
  'рассмотреть вашу кандидатуру. У нас открыта позиция менеджера по продвижению, бюджет обсуждаем.\n\n' +
  'Готовы ли вы выполнить небольшое тестовое задание на этой неделе?';

test('эталонное письмо проходит все проверки', () => {
  const { checks } = deterministicChecks(prodLike, { isFirstTouch: true });
  const failed = checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`);
  assert.deepEqual(failed, [], `эталон не должен валиться: ${failed.join('; ')}`);
});

test('иероглифы ловятся отдельной проверкой, а не долей кириллицы', () => {
  // Доля кириллицы тут 0.7 — language_ru такой ответ пропускает.
  const withCjk = 'Дмитрий, здравствуйте! Мы рассматриваем вашу позицию. akia さんは友人です。 Ещё вопрос?';
  assert.equal(check('language_ru', withCjk, {}).pass, true, 'кириллицы достаточно — проверка языка молчит');
  assert.equal(check('no_cjk', withCjk, {}).pass, false, 'иероглифы должны ловиться');
  assert.match(check('no_cjk', withCjk, {}).detail, /8 шт: さ/);
  assert.equal(check('no_cjk', prodLike, {}).pass, true);
});

test('markdown в письме ловится: разметка уходит кандидату как есть', () => {
  const md = '**Тема:** Предложение о позиции\n\nУважаемый Дмитрий,\n\n- опыт с WB\n- аналитика\n- автоматизация\n- цены';
  const c = check('no_markdown', md, {});
  assert.equal(c.pass, false);
  assert.match(c.detail, /жирный/);
  assert.match(c.detail, /«Тема:»/);
  assert.equal(check('no_markdown', prodLike, {}).pass, true);
});

test('плейсхолдеры ловятся только когда модель их сочинила сама', () => {
  // Обезличенный корпус: <PERSON_…> есть и в промпте, и в эталонном ответе — законный токен.
  const allowed = '<PERSON_1abcde>, спасибо за рассказ. Готовы ли вы к тестовому заданию?';
  assert.equal(
    check('no_placeholder_leak', allowed, { promptText: 'Кандидат: <PERSON_1abcde>', referenceText: allowed }).pass,
    true,
  );
  // Тот же токен, но эталонного ответа нет (корпус без обезличивания) — модель его выдумала.
  assert.equal(check('no_placeholder_leak', allowed, { promptText: 'Кандидат: Иван' }).pass, false);
  // Классический шаблон: модель оставила поле, которое не просил заполнять.
  const invented = 'Дмитрий, здравствуйте! Готовы ли вы к тестовому заданию? [Название компании]';
  const c = check('no_placeholder_leak', invented, { promptText: 'Кандидат: Дмитрий', referenceText: prodLike });
  assert.equal(c.pass, false);
  assert.match(c.detail, /Название компании/);
});

test('символьный мусор ловится, а нормальная пунктуация — нет', () => {
  assert.equal(check('no_symbol_spam', 'Дмитрий, здравствуйте! Вопрос? 🙂', {}).pass, true, 'один эмодзи — ещё человечность');
  assert.equal(check('no_symbol_spam', 'Дмитрий, здравствуйте! Вопрос? 🎉🔥🚀💥😎', {}).pass, false, 'пять эмодзи — гирлянда');
  assert.equal(check('no_symbol_spam', 'Дмитрий, здравствуйте! Вопрос? ============', {}).pass, false);
  assert.equal(check('no_symbol_spam', 'Дмитрий, здравствуйте! Вопрос — а цены? Да, и ещё...', {}).pass, true, 'тире и многоточие — не мусор');
});

test('приветствие и вопрос требуются только на первом касании', () => {
  const continuation = 'Отличный опыт, спасибо. Готовы ли вы к тестовому заданию?';
  const names = (o) => deterministicChecks(continuation, o).checks.map((c) => c.name);
  assert.ok(names({ isFirstTouch: true }).includes('greeting'));
  assert.ok(!names({ isFirstTouch: false }).includes('greeting'), 'в продолжении переписки приветствие не нужно');
});

test('первое касание определяется по тексту промпта, а не по числу сообщений', () => {
  // Прод кладёт всю переписку в одно user-сообщение, поэтому «сообщений ≤ 1» означало бы
  // «первое касание» для всех кейсов корпуса.
  const withHistory = { messages: [{ role: 'system', ref: 'x' }, { role: 'user', content: 'История переписки:\nКандидат: привет\n\nНапиши следующее сообщение' }] };
  assert.equal(detectFirstTouch(withHistory), false);
  assert.equal(detectFirstTouch({ messages: [{ role: 'user', content: 'Собери письмо для первого касания' }] }), true);
  // Поле из корпуса — источник истины, даже если текст кейса противоречит.
  assert.equal(detectFirstTouch({ first_touch: true, messages: withHistory.messages }), true);
});