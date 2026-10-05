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
// «Кандидат» тоже не входит: «ваша кандидатура выглядит убедительно» — обычный язык рекрутера,
// и подстрока «кандидат» ловила 4% эталонных ответов прода.
const SERVICE_NOISE = [
  'наш клиент', 'наши вопросы', 'персонаж', 'промпт',
  'system:', 'assistant:', 'инструкция для модели', 'llm',
];

const QUESTIONS = /[?？]/g;

// Иероглифы и соседние письменности (кандзи, хангль, кана, полноширинные формы). В письме
// кандидату их быть не может: модель получила русский запрос и ответила чужой письменностью.
// Отдельная проверка, а не доля кириллицы: та пропустит ответ, где кириллицы «достаточно».
const CJK = /[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7af\ufe30-\ufe4f\uff00-\uffef]/gu;

// Эмодзи и пиктограммы. Две штуки в письме — ещё человечность, пять — уже гирлянда.
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu;

// Плейсхолдеры, которые модель сочиняет сама. Промпт и reference — легальные источники таких
// токенов (корпус обезличен, в эталонном ответе они есть), всё остальное — мусор в письме.
const PLACEHOLDER = [
  { kind: (m) => `<${m[1]}>`, re: /<([A-Za-z_][A-Za-z0-9_]*)>/gu },
  { kind: (m) => `[${m[1]}]`, re: /\[([^\]\n]{1,40})\]/gu },
  { kind: (m) => `{{${m[1]}}}`, re: /\{\{([^}]{1,40})\}\}/gu },
  { kind: (m) => `{${m[1]}}`, re: /\{([\p{L}_]{2,24})\}/gu },
];

export function deterministicChecks(text, { isFirstTouch = false, promptText = '', referenceText = '' } = {}) {
  const out = [];
  const t = String(text ?? '');
  const add = (name, pass, detail = '') => out.push({ name, pass, detail });

  // Язык. Токены обезличивания (<PERSON_…>) из письма убираем: они латинские, и в эталонных
  // ответах прода на 100 кейсах из-за них 5 ответов проваливали порог 0.6 при доле 0.54.
  // Порог 0.5, а не 0.6: в письме легально встречаются латинские бренды (Wildberries, Ozon),
  // а «не русский» ловит no_cjk.
  const letters = textWithoutTokens(t).replace(/\s/g, '');
  const cyr = (letters.match(/[А-Яа-яЁё]/g) ?? []).length;
  add('language_ru', letters.length === 0 ? false : cyr / letters.length > 0.5,
    `доля кириллицы ${letters.length ? (cyr / letters.length).toFixed(2) : 0}`);

  const len = t.trim().length;
  add('length_120_1500', len >= 120 && len <= 1500, `${len} символов`);

  const low = t.toLowerCase();
  const refusal = REFUSALS.find((r) => low.includes(r));
  add('no_refusal', !refusal, refusal ?? '');

  const noise = SERVICE_NOISE.filter((w) => low.includes(w));
  if (/\bats\b/i.test(t)) noise.push('ats');
  add('no_service_noise', noise.length === 0, noise.join(', '));

  // Письмо в hh — plain text, и в продовых ответах markdown нет ни разу за 100 кейсов.
  // Модель, которая завернула письмо в «**Тема:**» и буллеты, отправляет кандидату разметку.
  const md = markdownFindings(t);
  add('no_markdown', md.length === 0, md.join(', '));

  const cjk = [...(t.match(CJK) ?? [])];
  add('no_cjk', cjk.length === 0, cjk.length ? `${cjk.length} шт: ${[...new Set(cjk)].slice(0, 5).join(' ')}` : '');

  const emoji = (t.match(EMOJI) ?? []).length;
  const run = symbolRun(t);
  add('no_symbol_spam', emoji <= 2 && !run, [emoji > 2 ? `эмодзи ×${emoji}` : '', run ? `символы «${run}»` : ''].filter(Boolean).join(', '));

  // Плейсхолдеры разрешены только если они уже есть в промпте или в эталонном ответе.
  const allowed = new Set([...placeholderKinds(promptText), ...placeholderKinds(referenceText)]);
  const invented = [...placeholderKinds(t)].filter((k) => !allowed.has(k));
  add('no_placeholder_leak', invented.length === 0, invented.join(', '));

  // Приветствие с обращением по имени: прод пишет «Дмитрий, здравствуйте!», и строгий
  // «текст начинается с приветствия» отвергал бы собственный эталонный ответ рекрутера.
  const hasGreeting = /^\s*(?:\p{Lu}[\p{L}]{1,20},?\s+)?(?:здравствуй\p{L}*|добрый (день|вечер)|привет\p{L}*)/iu.test(t);
  const hasQuestion = (t.match(QUESTIONS) ?? []).length > 0;
  if (isFirstTouch) {
    add('greeting', hasGreeting, hasGreeting ? '' : 'нет приветствия');
    add('asks_question', hasQuestion, hasQuestion ? '' : 'нет ни одного вопроса');
  }

  // Повтор вопроса, который уже был: кандидат отвечает, а модель спрашивает то же самое.
  return { checks: out, length: len, questions: (t.match(QUESTIONS) ?? []).length };
}

/** Текст без токенов обезличивания корпуса — они артефакт нашей подготовки, а не текст модели. */
const textWithoutTokens = (t) => t.replace(/<[A-Za-z_][A-Za-z0-9_]*>/g, ' ');

/** Признаки markdown в письме. Каждый пункт — то, что hh-кандидат увидит как мусор. */
function markdownFindings(t) {
  const found = [];
  if (/\*\*/.test(t)) found.push('**жирный**');
  if (/^#{1,6}\s/m.test(t)) found.push('заголовок #');
  if (/```/.test(t)) found.push('код');
  const bullets = (t.match(/^\s*[-*+•·]\s+/gm) ?? []).length;
  if (bullets > 3) found.push(`буллеты ×${bullets}`);
  const numbered = (t.match(/^\s*\d+[.)]\s+/gm) ?? []).length;
  if (numbered > 3) found.push(`нумерация ×${numbered}`);
  if (/^\s*(?:[*#>\s])*(тема|subject)\s*:/im.test(t)) found.push('«Тема:» в начале');
  if (/^\s*(-{3,}|={3,}|\*{3,})\s*$/m.test(t)) found.push('разделитель');
  return found;
}

/**
 * Виды плейсхолдеров в тексте. Сравниваются ВИДЫ, а не сами токены: нумерация у промпта и у
 * модели своя, а `[Название компании]` и `[Компания]` — один мусор.
 */
function placeholderKinds(t) {
  const kinds = new Set();
  for (const { kind, re } of PLACEHOLDER) {
    re.lastIndex = 0;
    for (const m of String(t ?? '').matchAll(re)) kinds.add(kind(m));
  }
  return kinds;
}

/** Пять одинаковых символов подряд — разделитель или «красивый» мусор, а не знак препинания. */
function symbolRun(t) {
  const m = t.match(/([^\d\p{L}\s.,!?;:()"'«»№\-–—/\\])(?:\1){4,}/u);
  return m ? m[0] : null;
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