// Сборка корпуса: из сырых записей прода — обезличенный, дедуплицированный датасет.
import { createHash } from 'node:crypto';
import { pseudonymize, scan, discoverNames } from './pii.mjs';

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const h16 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * Из записи прода делает кейс: системный промпт выносится в отдельный файл (он одинаковый
 * для всех кейсов — 12.5к символов × 100 кейсов это 1.2 МБ лишнего в репозитории),
 * остальные сообщения остаются в кейсе. Продовый ответ едет как reference.
 */
export function buildCase(rec, seq) {
  const messages = Array.isArray(rec.messages) ? rec.messages : [];
  const prompts = new Map();
  const rest = messages.map((m) => {
    if (m.role !== 'system') return m;
    const ref = h16(m.content);
    prompts.set(ref, m.content);
    return { role: 'system', ref };
  });
  return {
    case: {
      id: `c${String(seq).padStart(4, '0')}`,
      ts: rec.ts ?? null,
      messages: rest,
      reference: rec.answer ? { text: rec.answer, model: rec.model ?? null, rung: rec.rung ?? null } : null,
      prod: { model: rec.model ?? null, rung: rec.rung ?? null, temperature: rec.temperature ?? null },
    },
    prompts,
  };
}

const fingerprint = (messages) =>
  sha256(messages.map((m) => `${m.role}:${m.ref ?? m.content ?? ''}`).join('\n'));

/**
 * Дедуп по содержимому промпта, затем последние N (свежее = ближе к текущему промпту прода).
 * Порядок стабильный: сортировка по ts, иначе «последние N» зависели бы от порядка в файле.
 */
export function selectCases(records, { limit = 100 } = {}) {
  const sorted = [...records].sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
  const seen = new Set();
  const picked = [];
  for (let i = sorted.length - 1; i >= 0 && picked.length < limit; i--) {
    const rec = sorted[i];
    if (!rec || !Array.isArray(rec.messages) || rec.messages.length === 0) continue;
    const fp = fingerprint(rec.messages);
    if (seen.has(fp)) continue;
    seen.add(fp);
    picked.push({ rec, fp });
  }
  return picked.reverse();
}

/** Полная сборка: обезличивание всех текстов, контроль остатков ПДн. */
export function buildDataset(records, opts = {}) {
  const { limit = 100, datasetId = 'prod-2026-10', pii = {}, strict = true } = opts;
  const picked = selectCases(records, { limit });
  const prompts = new Map();
  const cases = [];
  const leaks = [];

  // Проход 1: словарь имён на ВЕСЬ корпус. Побайтно по полям нельзя — «Олег, спасибо за
  // подробный рассказ» встречается только в ответе, и поле-покровом такое имя осталось бы.
  const dictionary = discoverNames(
    picked
      .map(({ rec }) => [(rec.messages ?? []).map((m) => m.content ?? '').join('\n'), rec.answer ?? ''].join('\n'))
      .join('\n\n'),
  );
  const withDict = { ...pii, names: dictionary };

  picked.forEach(({ rec }, i) => {
    const { case: c, prompts: p } = buildCase(rec, i + 1);
    for (const [ref, text] of p) {
      if (!prompts.has(ref)) {
        const clean = pseudonymize(text, withDict);
        const found = scan(clean);
        if (found.length) leaks.push({ case: c.id, where: `prompts/${ref}`, findings: found });
        prompts.set(ref, clean);
      }
    }
    const cleanMessages = c.messages.map((m) =>
      m.role === 'system' ? m : { ...m, content: pseudonymize(m.content ?? '', withDict) },
    );
    const cleanRef = c.reference ? { ...c.reference, text: pseudonymize(c.reference.text, withDict) } : null;
    const clean = { ...c, messages: cleanMessages, reference: cleanRef };

    for (const [field, text] of [
      ...cleanMessages.filter((m) => m.content).map((m) => ['message', m.content]),
      ['reference', cleanRef?.text],
    ]) {
      const found = scan(text ?? '');
      if (found.length) leaks.push({ case: c.id, where: field, findings: found });
    }
    cases.push(clean);
  });

  return { datasetId, prompts, cases, leaks, strict, dictionary };
}

/** Раскладка датасета на диск: corpus.jsonl + prompts/ + manifest.json с sha256. */
export function serializeDataset(ds) {
  const corpus = ds.cases.map((c) => JSON.stringify(c)).join('\n') + '\n';
  const prompts = [...ds.prompts.entries()].map(([ref, text]) => ({
    ref,
    file: `prompts/${ref}.txt`,
    sha256: sha256(text),
    chars: text.length,
    text,
  }));
  const manifest = {
    dataset: ds.datasetId,
    cases: ds.cases.length,
    prompts: prompts.length,
    corpus_file: 'corpus.jsonl',
    corpus_sha256: sha256(corpus),
    pii: { level: 'de-identified', strict_scan: ds.strict },
    created: new Date().toISOString(),
    notes: 'Продовые ответы в reference — baseline для парного сравнения, не эталон истины.',
  };
  return { corpus, prompts, manifest };
}