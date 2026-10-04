#!/usr/bin/env node
// Бюджет входа письма: какая доля промпта приходится на системный промпт, профиль с ATS,
// сжатую историю, цель и доступность — и сколько входа остаётся платной модели в
// двухшаговой схеме «дешёвая ступень пишет по полному входу → платная переписывает
// цель + черновик». Ничего не отправляется: скрипт читает только локальный датасет.
//
//   node scripts/budget.mjs --dataset datasets/prod-2026-10
//   node scripts/budget.mjs --dataset datasets/prod-2026-10 --results results/run-free-v2.jsonl
//
// Токены считаются gpt-tokenizer (cl100k). Если пакета нет — падаем на грубую эвристику
// и печатаем об этом предупреждение: молчаливо выдавать другую метрику нельзя.
// Реальные prompt_tokens из прогона (--results) — единственный замер, который не спорит
// с оценкой; по нему же печатается калибровка «оценка → факт».
import { readFileSync } from 'node:fs';
import { loadDataset } from '../src/dataset.mjs';

const args = parseArgs(process.argv.slice(2));
const ds = loadDataset(args.dataset ?? 'datasets/current');

const INSTR = 250; // токенов на инструкцию «перепиши это письмо» платной модели
const PRICE = {
  paid: { in: 0.3, out: 2.5 },   // gemini-2.5-flash
  cheap: { in: 0.021, out: 0.063 }, // ling-3.0-flash
  prod: { in: 0.25, out: 1.5 },  // gemini-3.1-flash-lite-preview (прод)
};
const LETTERS = 1000;

let count = null;
let tokenizerNote = '';
try {
  const { encode } = await import('gpt-tokenizer');
  count = (s) => (s ? encode(s).length : 0);
  tokenizerNote = 'оценка токенов: gpt-tokenizer (cl100k)';
} catch {
  count = (s) => (s ? Math.ceil(s.length / 3.7) : 0);
  tokenizerNote = 'gpt-tokenizer не установлен — грубая эвристика (~3.7 симв./токен), доли слегка смещены. Для точных долей: npm ci';
}
console.log(`Датасет ${ds.manifest.dataset}: кейсов ${ds.cases.length}. ${tokenizerNote}`);

const rows = [];
for (const c of ds.cases) {
  const sysMsg = c.messages.find((m) => m.role === 'system');
  const user = (c.messages.find((m) => m.role === 'user')?.content ?? '');
  const systemText = sysMsg?.ref ? ds.prompts.get(sysMsg.ref) ?? '' : '';

  const iHist = user.indexOf('История переписки:');
  const iGoal = user.indexOf('Задача письма:');
  const iAvail = user.indexOf('Доступность');
  const iFunnel = user.indexOf('Действие воронки');
  const cuts = [iGoal, iAvail, iFunnel, user.length].filter((x) => x >= 0).sort((a, b) => a - b);
  const goalEnd = cuts.find((x) => x > iGoal) ?? user.length;
  const availEnd = iAvail > 0 ? (cuts.find((x) => x > iAvail) ?? user.length) : 0;

  const profile = user.slice(0, iHist);
  const history = user.slice(iHist, iGoal > 0 ? iGoal : user.length);
  const goal = user.slice(iGoal, goalEnd);
  const availability = iAvail > 0 ? user.slice(iAvail, availEnd) : '';

  const draft = c.reference?.text ?? ''; // продовый ответ = объём того, что пишет дешёвая ступень
  const t = {
    system: count(systemText),
    profile: count(profile),
    history: count(history),
    goal: count(goal),
    availability: count(availability),
    draft: count(draft),
  };
  t.full = t.system + t.profile + t.history + t.goal + t.availability;
  t.step2 = INSTR + t.goal + t.availability + t.draft; // что реально видит платная модель на втором шаге
  t.hasHistory = !/переписки ещё не было/.test(history);
  rows.push(t);
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const med = (a) => {
  const b = [...a].sort((x, y) => x - y);
  return b.length ? b[Math.floor(b.length / 2)] : 0;
};
const share = (set, f) => avg(set.map((r) => (r[f] / (r.full || 1)) * 100));

function report(label, set) {
  if (!set.length) return;
  const s2 = set.map((r) => (1 - r.step2 / (r.full || 1)) * 100);
  console.log(`\n=== ${label} (n=${set.length}) ===`);
  console.log(`вход сейчас (full): медиана ${med(set.map((r) => r.full))} токенов, среднее ${avg(set.map((r) => r.full)).toFixed(0)}`);
  console.log(
    `доли входа: системный промпт ${share(set, 'system').toFixed(1)}% | профиль+ATS ${share(set, 'profile').toFixed(1)}%` +
    ` | сжатая история ${share(set, 'history').toFixed(1)}% | цель ${share(set, 'goal').toFixed(1)}% | доступность ${share(set, 'availability').toFixed(1)}%`,
  );
  console.log(
    `черновик дешёвой ступени: среднее ${avg(set.map((r) => r.draft)).toFixed(0)} токенов = ${share(set, 'draft').toFixed(1)}% входа`,
  );
  console.log(
    `экономия входа платной модели в двухшаговой схеме: средняя ${avg(s2).toFixed(1)}%, медиана ${med(s2).toFixed(1)}%` +
    ` (мин ${Math.min(...s2).toFixed(1)}, макс ${Math.max(...s2).toFixed(1)})`,
  );
  money(set);
}

function money(set) {
  const out = avg(set.map((r) => r.draft));
  const per = (p, t) => (t * p) / 1e6;
  const baseIn = per(PRICE.paid.in, avg(set.map((r) => r.full)));
  const baseOut = per(PRICE.paid.out, out);
  const cheapIn = per(PRICE.cheap.in, avg(set.map((r) => r.full)));
  const cheapOut = per(PRICE.cheap.out, out);
  const paidIn2 = per(PRICE.paid.in, avg(set.map((r) => r.step2)));
  const paidOut2 = per(PRICE.paid.out, out);
  const prodBase = per(PRICE.prod.in, avg(set.map((r) => r.full))) + per(PRICE.prod.out, out);
  const scheme = cheapIn + cheapOut + paidIn2 + paidOut2;
  const base = baseIn + baseOut;
  const k = (x) => `$${(x * LETTERS).toFixed(3)}`;
  console.log(`  деньги на ${LETTERS} писем: A) платная на полном входе ${k(base)} | B) дешёвая пишет + платная переписывает ${k(scheme)} (${(scheme / (base || 1) * 100).toFixed(0)}% от A, экономия ${(100 - scheme / (base || 1) * 100).toFixed(0)}%) | прод-ступень на полном входе ${k(prodBase)}`);
  console.log(`  в схеме B выход платной модели пишется дважды: дешёвая ${k(cheapOut)} + платная ${k(paidOut2)}`);
}

report('все кейсы', rows);
report('кейсы с историей переписки', rows.filter((r) => r.hasHistory));
report('первые письма (без истории)', rows.filter((r) => !r.hasHistory));

if (args.results) {
  const rl = readFileSync(args.results, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const ok = rl.filter((r) => r.usage?.prompt_tokens);
  if (!ok.length) {
    console.log('\nВ результатах нет usage.prompt_tokens — реальный замер входа недоступен.');
  } else {
    const p = ok.map((r) => r.usage.prompt_tokens).sort((a, b) => a - b);
    const q = (f) => p[Math.min(p.length - 1, Math.floor(p.length * f))];
    console.log(`\n=== Реальные prompt_tokens из прогона (${ok.length} записей, ${new Set(ok.map((r) => r.model)).size} моделей) ===`);
    console.log(`p10=${q(0.1)} p50=${q(0.5)} p90=${q(0.9)} max=${p[p.length - 1]}`);
    const est = med(rows.map((r) => r.full));
    if (est) console.log(`калибровка «оценка → факт»: ${(q(0.5) / est).toFixed(2)}× — на столько cl100k-оценка меньше реального счёта провайдера.`);
  }
}

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