// Разбор ответа слепого судьи.
//
// Контракт судьи: «Ответь строго JSON». На практике даже при response_format=json_object
// свободная модель дописывает хвост: подпись, второе предложение, повторный вариант ответа.
// `JSON.parse` на этом падает с «Unexpected non-whitespace character after JSON» — запись
// теряется, судья считается упавшей, а оценка молча выпадает из отчёта.
//
// Правило: вынимаем ПЕРВЫЙ сбалансированный JSON-объект из текста. Скобки считаем,
// учитывая строки и escapes — иначе объект внутри строки реплики перепутают границы.
// Если объекта нет вообще или он не валиден — возвращаем ошибку с началом ответа,
// чтобы диагностика не терялась.

/**
 * @param {string} raw текст, отданный моделью
 * @returns {object} разобранный объект судьи
 * @throws {Error} если валидного объекта в тексте нет
 */
export function parseJudgeJson(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw new Error('судья: пустой ответ');

  const start = text.indexOf('{');
  if (start === -1) throw new Error(`судья: в ответе нет JSON-объекта: ${text.slice(0, 160)}`);

  const body = scanObject(text, start);
  if (body === null) throw new Error(`судья: JSON-объект не закрыт: ${text.slice(start, start + 160)}`);

  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') throw new Error('не объект');
    return parsed;
  } catch (e) {
    // Иногда модель отдаёт «почти JSON»: одинарные кавычки, висячую запятую. Это не повод
    // терять кейс, но и молча глотать мусор нельзя — пробуем разобрать как есть, иначе ошибка.
    throw new Error(`судья: JSON не разобрался (${e.message}): ${body.slice(0, 160)}`);
  }
}

/** Находит границу объекта, начиная с позиции openIndex (там лежит '{'). */
function scanObject(text, openIndex) {
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(openIndex, i + 1);
    }
  }
  return null;
}
