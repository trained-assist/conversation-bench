// Разбор models.json / models-free.json в одном месте. Раньше каждый скрипт читал этот файл
// по-своему, и нормализация id моделей разъехалась: run-bench требовал пару ladder+rung,
// а report брал цену по полю `model`, которого в новом формате уже нет. Теперь формат
// проверяется один раз, при чтении, и цена всегда ищется по id.

import { readFileSync } from 'node:fs';

// Ступень лестницы — это id провайдера плюс модель: `opencode-go/mimo-v2.6-flash` или
// `openrouter/nvidia/nemotron-3-super-120b-a12b:free` (у openrouter в id есть ещё namespace).
// Именно ПРОВАЙДЕРСКАЯ строка, а не полная: она доказывает, что вызов пойдёт через лестницу.
// `zen-pool/*` — ступени локального пула zen в том же воркере: отдельный префикс, потому что
// квоты у него свои (нет суточного лимита на IP прокси, в отличие от opencode-zen/*).
const RUNG_RE = /^(openrouter|opencode-go|opencode-zen|zen-pool|anthropic|openai|google|mistral|meta|xai)\/[^/]+(?:\/.+)?$/;

/**
 * @param {string} file путь к models.json / models-free.json
 * @returns {{models: object[], judge: object|null, comment: string}}
 * @throws если у модели нет id или пары ladder+rung
 */
export function readModelConfig(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const list = Array.isArray(raw.models) ? raw.models : [];
  if (!list.length) throw new Error(`${file}: нет ни одной модели`);

  const ids = new Set();
  const models = list.map((m, i) => {
    // Строка «эталон» (role: 'baseline') — не вызов модели, а продовые ответы из корпуса:
    // лестницы и ступени у неё нет по определению, и требовать их нельзя.
    const isBaseline = m.role === 'baseline' || m.baseline === true;
    if (!isBaseline && (!m.ladder || !m.rung)) {
      throw new Error(`${file}: у модели #${i + 1} (${m.id ?? m.model ?? '?'}) нет пары ladder+rung`);
    }
    const id = m.id ?? m.model ?? m.rung;
    if (ids.has(id)) throw new Error(`${file}: дважды повторяется id "${id}" — результаты неразличимы в отчёте`);
    ids.add(id);
    if (!isBaseline && !RUNG_RE.test(m.rung)) {
      throw new Error(`${file}: rung "${m.rung}" (${id}) не похож на ступень лестницы вида провайдер/модель — сначала добавь ступень в config/ladders.json лестницы`);
    }
    return { ...m, id, model: id };
  });

  const judge = raw.judge && raw.judge.ladder && raw.judge.rung ? { ...raw.judge } : null;
  return { models, judge, comment: raw._comment ?? '' };
}

/** Цены по id — единственный источник для отчёта (после перехода на формат лестницы поля model нет). */
export function priceById(models) {
  return Object.fromEntries(models.map((m) => [m.id ?? m.model, m.price ?? {}]));
}