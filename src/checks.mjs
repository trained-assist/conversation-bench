// Детерминированный слой оценки. Бесплатный, воспроизводимый, не спорит с вкусом:
// ловит то, что точно сломано (не тот язык, отказ модели, мусор в тексте письма).
//
// Слепой судья (LLM) живёт отдельно — в judge.mjs: его решение не должно подменяться этими проверками.
const REFUSALS = [
  'не могу помочь', 'не могу выполнить', 'i cannot', 'i can not', 'как языковая модель',
  'извините, я не', 'к сожалению, я не могу',
];

// Слова, которых в письме кандидату быть не должно. «Вакансия» сюда не входит —
// это нормальное слово для письма; здесь только то, что выдаёт служебный слой.
const SERVICE_NOISE = [
  'кандидат', 'наш клиент', 'наши вопросы', 'персонаж', 'промпт',
  'system:', 'assistant:', 'инструкция для модели', 'llm',
];

const QUESTIONS = /[?？]/g;

export function deterministicChecks(text, { isFirstTouch = false } = {}) {
  const out = [];
  const t = String(text ?? '');
  const add = (name, pass, detail = '') => out.push({ name, pass, detail });

  const letters = t.replace(/\s/g, '');
  const cyr = (t.match(/[А-Яа-яЁё]/g) ?? []).length;
  add('language_ru', letters.length === 0 ? false : cyr / letters.length > 0.6,
    `доля кириллицы ${letters.length ? (cyr / letters.length).toFixed(2) : 0}`);

  const len = t.trim().length;
  add('length_120_1500', len >= 120 && len <= 1500, `${len} символов`);

  const low = t.toLowerCase();
  const refusal = REFUSALS.find((r) => low.includes(r));
  add('no_refusal', !refusal, refusal ?? '');

  const noise = SERVICE_NOISE.filter((w) => low.includes(w));
  if (/\bats\b/i.test(t)) noise.push('ats');
  add('no_service_noise', noise.length === 0, noise.join(', '));

  const hasGreeting = /^\s*(здравствуй|добрый (день|вечер)|привет|здравствуйте)/i.test(t);
  const hasQuestion = (t.match(QUESTIONS) ?? []).length > 0;
  if (isFirstTouch) {
    add('greeting', hasGreeting, hasGreeting ? '' : 'нет приветствия');
    add('asks_question', hasQuestion, hasQuestion ? '' : 'нет ни одного вопроса');
  }

  // Повтор вопроса, который уже был: кандидат отвечает, а модель спрашивает то же самое.
  return { checks: out, length: len, questions: (t.match(QUESTIONS) ?? []).length };
}

/** Повторный вопрос: тот же текст вопроса уже встречался в предыдущем сообщении кандидата. */
export function repeatedQuestion(newText, previousTexts = []) {
  const q = extractQuestions(newText).map(normalize);
  if (!q.length) return false;
  const prev = previousTexts.flatMap(extractQuestions).map(normalize);
  return q.some((x) => x.length > 12 && prev.includes(x));
}

export function extractQuestions(text) {
  return String(text ?? '')
    .split(/[\n.!?]/)
    .map((s) => s.trim())
    .filter((s) => s.includes('?') || /\b(как|какой|когда|где|готовы|рассматриваете|обсудите)\b/i.test(s))
    .filter(Boolean);
}

const normalize = (s) => s.toLowerCase().replace(/[^a-zа-яё0-9]+/gi, ' ').trim();

export const scoreChecks = (checks) => {
  const passed = checks.filter((c) => c.pass).length;
  return { passed, total: checks.length, all_pass: passed === checks.length };
};