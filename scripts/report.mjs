#!/usr/bin/env node
// Сводная таблица: качество / цена / скорость по каждой модели. На выходе markdown —
// его же можно публиковать владельцу без пересказа.
//
//   node scripts/report.mjs --results results/run.judged.jsonl --models models.json --out results/report.md
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readModelConfig, priceById } from '../src/config.mjs';

const sumScores = (j) => {
  const s = j.scores?.A ?? {};
  const v = Object.values(s).reduce((a, b) => a + (Number(b) || 0), 0);
  return v;
};
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
// Отчёт может печатать и наш id, и «сырую» ступень лестницы (provider/model) — убираем
// префикс провайдера, чтобы колонка читалась: opencode-go/mimo → mimo.
const short = (m) => m.replace(/^(openrouter|opencode-go|opencode-zen|zen-pool)\//, '');
const sorted = (a) => [...a].sort((x, y) => x - y);
const median = (a) => (a.length ? sorted(a)[Math.floor(a.length / 2)] : null);
const quant = (a, q) => (a.length ? sorted(a)[Math.min(sorted(a).length - 1, Math.floor(a.length * q))] : null);
const p50 = (a) => quant(a, 0.5);
const p95 = (a) => quant(a, 0.95);

const args = parseArgs(process.argv.slice(2));
const rows = readFileSync(args.results, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const models = readModelConfig(args.models ?? 'models.json').models;
// Ключ цены — id модели: в models.json после перехода на формат лестницы поля `model` уже нет,
// и цена молча превратилась бы в «—». Старое поле `model` держим как фолбэк.
const price = priceById(models);

const groups = new Map();
for (const r of rows) {
  if (!groups.has(r.model)) groups.set(r.model, []);
  groups.get(r.model).push(r);
}

const table = [...groups.entries()].map(([model, rs]) => {
  const ok = rs.filter((r) => !r.error);
  const detPass = ok.filter((r) => r.deterministic?.all_pass);
  const judged = ok.filter((r) => r.judge && !r.judge.error);
  const candWins = judged.filter((r) => r.judge.vs_prod === 'candidate');
  const ties = judged.filter((r) => r.judge.vs_prod === 'tie');

  const tin = median(ok.map((r) => r.usage?.prompt_tokens).filter(Number));
  const tout = median(ok.map((r) => r.usage?.completion_tokens).filter(Number));
  const reason = median(ok.map((r) => r.usage?.completion_tokens_details?.reasoning_tokens).filter(Number)) ?? 0;
  const p = price[model] ?? {};
  const cost = ok.length
    ? ok.reduce((a, r) => {
        const u = r.usage ?? {};
        return a + ((u.prompt_tokens ?? 0) * (p.input ?? 0) + (u.completion_tokens ?? 0) * (p.output ?? 0)) / 1e6;
      }, 0) / ok.length
    : null;

  return {
    model: short(model),
    n: rs.length,
    errors: rs.length - ok.length,
    det: pct(detPass.length, ok.length),
    win: pct(candWins.length, judged.length),
    tie: pct(ties.length, judged.length),
    tin, tout, reason,
    // Рассуждения съедают лимит ответа: у nemotron 356 из 664 токенов. Без этой колонки
    // ступень с большим thinking выглядит дороже и длиннее, чем ступень, которая реально
    // потратила лимит на текст письма.
    maxTok: median(ok.map((r) => r.max_tokens).filter(Number)) ?? null,
    cost: cost == null ? '—' : `$${cost.toFixed(5)}`,
    p50: p50(ok.map((r) => r.latency_ms)),
    p95: p95(ok.map((r) => r.latency_ms)),
    judgeSum: judged.reduce((a, r) => a + sumScores(r.judge), 0) / (judged.length || 1),
    perCheck: perCheckRates(ok),
  };
});

table.sort((a, b) => b.win.localeCompare(a.win) || b.det.localeCompare(a.det));

// Разбивка по КАЖДОЙ проверке. Без неё «Дет. проверки 71%» не отвечает на вопрос «что чинить»:
// провалилась длина, язык, тон или факты — а по цифре это не видно.
const checkNames = [...new Set(table.flatMap((t) => Object.keys(t.perCheck)))].sort();
const checkTable = checkNames.length
  ? [
      '## Проверки поимённо (доля ответов, прошедших проверку)',
      '',
      `| Модель | ${checkNames.join(' | ')} |`,
      `|---|${checkNames.map(() => '---').join('|')}|`,
      ...table.map((t) => `| ${t.model} | ${checkNames.map((c) => t.perCheck[c] ?? '—').join(' | ')} |`),
      '',
    ]
  : [];

const md = [
  '# Отчёт бенчмарка писем кандидатам',
  '',
  `Прогон: ${args.results} · кейсов: ${rows.length} · дата: ${new Date().toISOString().slice(0, 16)}Z`,
  '',
  '| Модель | N | Ошибки | Дет. проверки | Побед vs прод | Ничьи | Токены в | Токены out | Из них рассуждения | Лимит ответа | $/письмо | p50 мс | p95 мс | Сумма судьи |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...table.map((t) =>
    `| ${t.model} | ${t.n} | ${t.errors} | ${t.det} | ${t.win} | ${t.tie} | ${t.tin ?? '—'} | ${t.tout ?? '—'} | ${t.reason || '—'} | ${t.maxTok ?? '—'} | ${t.cost} | ${t.p50 ?? '—'} | ${t.p95 ?? '—'} | ${t.judgeSum.toFixed(1)}/10 |`),
  '',
  ...checkTable,
  'Судья слепой: продовый ответ и кандидат перемешаны, автор неизвестен. Дет. проверки — бесплатно и до судьи.',
  'Лимит ответа в проде — 800 (hh-142-chain/src/conversation-generation.js); в бенче он выше у reasoning-ступеней, иначе ответ приходит пустым. Сравнивать лимиты надо по колонке «Лимит ответа».',
  'Решение о перестановке лестницы принимается по quality floor, затем Pareto «цена/качество» — не «дешёвый = победитель».',
].join('\n');

if (args.out) {
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, md);
  console.log(`→ ${args.out}`);
}
console.log(md);

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const n = argv[i + 1];
    if (n && !n.startsWith('--')) { o[k] = n; i++; } else o[k] = true;
  }
  return o;
}

/** Доля ответов, прошедших каждую проверку поимённо: {language_ru: '96%', …}. */
function perCheckRates(ok) {
  const out = {};
  for (const r of ok) {
    for (const c of r.deterministic?.checks ?? []) {
      if (!out[c.name]) out[c.name] = { pass: 0, total: 0 };
      out[c.name].total++;
      if (c.pass) out[c.name].pass++;
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, pct(v.pass, v.total)]));
}