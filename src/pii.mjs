// Псевдонимизация и сканирование персональных данных.
//
// Два разных контракта:
//   pseudonymize() — преобразование (best effort, словарь имён собирается из самого текста);
//   scan()        — детектор (строгий, ничего не знает про словарь и ищет остатки).
// Гейт CI опирается на scan(), а не на pseudonymize(): если после обезличивания что-то осталось — это блокер.
//
// NB: \b в JS работает по ASCII-\w и кириллицу «не видит» — все границы только lookaround'ами.

const L = '[\\p{L}\\p{N}_]';
const RE = {
  email: /[\w.+-]+@[\w-]+\.[\w.а-яё-]+/gi,
  phone: /(?:\+7|8)[\s(-]?\d{3}[\s)-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g,
  telegram: /(?:https?:\/\/)?t\.me\/[A-Za-z0-9_+/]+/g,
  inn: new RegExp(`(?<!${L})\\d{10}(?:\\d{2})?(?!${L})`, 'gu'),
  hhUrl: /https?:\/\/[^\s)"'<>]*hh\.ru[^\s)"'<>]*/gi,
  url: /https?:\/\/[^\s)"'<>]+/g,
  salary: /(\d[\d\s ]{2,})\s*(₽|руб(?:\.|лей)?|тыс\.?\s*руб)/gi,
  fullName: new RegExp(`(?<!${L})[А-ЯЁ][а-яё]{1,15}(?:[- ][А-ЯЁ][а-яё]{1,15}){1,2}(?!${L})`, 'gu'),
  nameIntro: new RegExp(`(?<!${L})(?:зовут|обращаться к)\\s+([А-ЯЁ][а-яё]{1,15})(?!${L})`, 'gu'),
  salutation: /(?:^|[\n>]\s*)([А-ЯЁ][а-яё]{1,15})\s*,\s*(?:добрый|здравствуй|привет)/gim,
  // Имя в начале сообщения/ответа: «Олег, спасибо за подробный рассказ» — тут нет слова «добрый».
  leadName: /(?:^|\n)[^\S\n]*([А-ЯЁ][а-яё]{1,15})\s*,/gm,
};

// Слова, похожие на имя, но имя не являющиеся — чтобы не маскировать смысл вакансии.
const NOT_NAMES = new Set([
  'Россия', 'Москва', 'Санкт', 'Петербург', 'Екатеринбург', 'Новосибирск', 'Казань', 'Нижний',
  'Новгород', 'Владивосток', 'Калининград', 'Краснодар', 'Самар', 'Омск', 'Челябинск', 'Воронеж',
  'Ростелеком', 'Сбербанк', 'Сбер', 'Альфа', 'Втб', 'Тинькофф', 'Газпром', 'Роснефть',
  'Яндекс', 'Авито', 'Хабр', 'Гитхаб', 'Лампа', 'Понедельник', 'Вторник', 'Среда', 'Четверг',
  'Пятница', 'Суббота', 'Воскресенье', 'Уважаемый', 'Уважаемая', 'Коллеги', 'Добрый', 'Доброго',
  'Итого', 'Кстати', 'Вкратце', 'Кроме', 'Плюс', 'Минус', 'Сейчас', 'Затем', 'После', 'Далее',
  'Также', 'Однако', 'Поэтому', 'Спасибо', 'Здравствуйте', 'Привет', 'Резюме', 'Вакансия', 'Результат',
]);

/**
 * Собирает словарь имён из текста: полные ФИО, «зовут X», обращение «Имя, добрый день».
 * Из полных ФИО берём и имя, и фамилию — в письмах они встречаются по отдельности.
 *
 * Важное разделение сильных и слабых источников. «Зовут X» и «X, добрый день» — имя
 * названо прямо, такой кандидат всегда в словаре. А RE.fullName — это ЛЮБЫЕ две соседние
 * заглавные слова, и RE.leadName — любое слово с запятой в начале строки: на продовом корпусе
 * hh так туда попадали «Кандидат», «Если», «Это», «Опыт», «Условия», «Ваш» — и каждое маскировалось
 * в <PERSON_…>. Словарь расползался до 541 слова, из которых 288 — обычные слова русского языка,
 * а половина словаря корпуса («ваш <PERSON_1vkk0w> работы») превращалась в токены: модели писали
 * в ответ токены, и «пишет ли модель по-русски» становилось вопросом к нашему же обезличиванию.
 *
 * Отличать имя от слова позволяет регистр: имя в русском тексте пишут с заглавной, обычное
 * слово — в любом. Считаем словоформы кандидата (основа + падежное окончание, как в маскировании)
 * и отбрасываем того, кто в нижнем регистре встречается заметно чаще, чем в верхнем.
 */
export function discoverNames(text) {
  const strong = new Set(); // имя названо прямо — в словарь попадает всегда
  for (const m of text.matchAll(RE.nameIntro)) {
    if (!NOT_NAMES.has(m[1])) strong.add(m[1]);
  }
  for (const m of text.matchAll(RE.salutation)) {
    if (!NOT_NAMES.has(m[1])) strong.add(m[1]);
  }

  const weak = new Set(); // кандидат из общего правила «заглавные слова» — нужен фильтр по регистру
  for (const m of text.matchAll(RE.fullName)) {
    for (const part of m[0].split(/[- ]/)) if (!NOT_NAMES.has(part)) weak.add(part);
  }
  for (const m of text.matchAll(RE.leadName)) {
    if (!NOT_NAMES.has(m[1])) weak.add(m[1]);
  }

  const names = new Set(strong);
  for (const w of weak) if (strong.has(w) || caseLooksLikeName(w, text)) names.add(w);
  return [...names].sort((a, b) => b.length - a.length);
}

/** Имя или обычное слово: у имени почти нет вхождений в нижнем регистре. */
function caseLooksLikeName(word, text) {
  const { upper, lower } = caseCounts(text, stemOf(word));
  return lower === 0 || lower * 3 <= upper;
}

/** Сколько раз словоформы кандидата встречаются с заглавной и со строчной буквы. */
function caseCounts(text, stem) {
  const re = new RegExp(`(?<!${L})${escapeRe(stem.toLowerCase())}[а-яё]{0,5}(?!${L})`, 'giu');
  let upper = 0;
  let total = 0;
  for (const m of text.matchAll(re)) {
    total++;
    if (/^[А-ЯЁ]/.test(m[0])) upper++;
  }
  return { upper, lower: total - upper };
}

const counter = (prefix) => {
  const map = new Map();
  return (value) => {
    if (!map.has(value)) map.set(value, `<${prefix}_${map.size + 1}>`);
    return map.get(value);
  };
};

/**
 * Обезличивает текст. Опции:
 *   names        — словарь имён (по умолчанию discoverNames от текста);
 *   salaryMode   — 'bucket' (по умолчанию, округление до 10 тыс.) | 'keep' | 'drop';
 *   urlMode      — 'hash' (по умолчанию, <URL_n>) | 'keep';
 *   maskPhones/maskEmails/maskTelegram/maskInn — по умолчанию true.
 */
export function pseudonymize(text, opts = {}) {
  const {
    names = discoverNames(text),
    salaryMode = 'bucket',
    urlMode = 'hash',
    maskPhones = true,
    maskEmails = true,
    maskTelegram = true,
    maskInn = true,
  } = opts;

  const tok = { url: counter('URL'), mail: counter('EMAIL'), tg: counter('TG'), phone: counter('PHONE'), inn: counter('INN') };
  let out = String(text);

  // Словоформы: «Иван» закрывает «Ивану/Иваном/Иванова», «Петров» — «Петрову/Петровой».
  // Псевдонимизация здесь осознанно best effort; страховка — строгий scan() после неё.
  for (const name of names) {
    if (!name || NOT_NAMES.has(name)) continue;
    const stem = stemOf(name);
    out = out.replace(
      new RegExp(`(?<!${L})${escapeRe(stem)}[а-яё]{0,5}(?!${L})`, 'gui'),
      `<PERSON_${hash(stem)}>`,
    );
  }

  if (maskEmails) out = out.replace(RE.email, (m) => tok.mail(m));
  if (maskPhones) out = out.replace(RE.phone, (m) => tok.phone(m));
  if (maskTelegram) out = out.replace(RE.telegram, (m) => tok.tg(m));
  if (maskInn) out = out.replace(RE.inn, (m) => tok.inn(m));
  if (urlMode === 'hash') out = out.replace(RE.url, (m) => tok.url(m));

  if (salaryMode === 'bucket') {
    out = out.replace(RE.salary, (m, num, cur) => {
      const n = Number(String(num).replace(/[^\d]/g, ''));
      if (!Number.isFinite(n)) return m;
      const rounded = Math.round(n / 10000) * 10000;
      return `${rounded} ${cur.trim()}`;
    });
  } else if (salaryMode === 'drop') {
    out = out.replace(RE.salary, '<SALARY>');
  }

  return out;
}

/** Приводит словоформу к основе: Петрову → Петров; слишком короткую не режем. */
const stemOf = (name) => {
  let stem = name;
  while (stem.length > 4) {
    const next = stem.replace(/[аяуюьейои]+$/u, '');
    if (next.length < 4 || next === stem) break;
    stem = next;
  }
  return stem;
};

const hash = (s) => {
  let h = 0x811c9dc5;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(36).slice(0, 6);
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Строгий детектор остатков ПДн. Возвращает находки с типом и обрезанным контекстом;
 * сами значения в контекст попадают только в замаскированном виде.
 */
export function scan(text) {
  const findings = [];
  const add = (type, m) => {
    const at = m.index ?? 0;
    findings.push({ type, at, context: redactContext(text.slice(Math.max(0, at - 30), at + m[0].length + 30)) });
  };

  for (const m of text.matchAll(RE.email)) add('email', m);
  for (const m of text.matchAll(RE.telegram)) add('telegram', m);
  for (const m of text.matchAll(RE.phone)) add('phone', m);
  for (const m of text.matchAll(RE.hhUrl)) add('hh_url', m);
  for (const m of text.matchAll(RE.url)) add('url', m);
  for (const m of text.matchAll(RE.inn)) add('inn', m);
  for (const m of text.matchAll(RE.fullName)) {
    const words = m[0].split(/[- ]/).filter(Boolean);
    if (words.some((w) => NOT_NAMES.has(w))) continue;
    add('full_name', m);
  }
  // Точная (не округлённая до тысячи) зарплата — признак, что bucket не применился.
  for (const m of text.matchAll(RE.salary)) {
    const n = Number(String(m[1]).replace(/[^\d]/g, ''));
    if (Number.isFinite(n) && n > 1000 && n % 1000 !== 0) add('salary_exact', m);
  }

  return findings;
}

// В выводе гейта показываем, ЧТО нашли, но не само значение: лог гейта уезжает в CI-артефакты.
function redactContext(s) {
  return s
    .replace(RE.email, '<EMAIL>')
    .replace(RE.phone, '<PHONE>')
    .replace(RE.url, '<URL>')
    .replace(RE.telegram, '<TG>')
    .replace(/\b\d{10}(\d{2})?\b/g, '<INN>')
    .replace(/\d[\d\s ]{2,}/g, (m) => {
      const n = Number(m.replace(/[^\d]/g, ''));
      return n > 1000 ? '<NUM>' : m;
    })
    .slice(0, 120)
    .replace(/\s+/g, ' ');
}

export const PATTERNS = RE;