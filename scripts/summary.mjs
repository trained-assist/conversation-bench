#!/usr/bin/env node
// Машинный срез результатов бенча: один JSON вместо 900 строк. Нужен двум вещам:
//
//   1) отчёт владельцу и в репозиторий — числа без сырых ответов моделей (сырьё остаётся
//      на машине прогона, в публичный репозиторий не едет);
//   2) шаг 3 эпика — автоматическая ротация ступеней: лестница должна уметь подгружать
//      свежие рабочие модели, а для этого результаты обязаны быть машинно-читаемыми.
//
//   node scripts/summary.mjs --results results/run.judged.jsonl --models models-all.json \
//       --out results/summary.json
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readModelConfig, priceById } from '../src/config.mjs';

const args = parseArgs(process.argv.slice(2));
const rows = readFileSync(args.results, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const models = readModelConfig(args.models ?? 'models.json').models;
const price = priceById(models);

const groups = new Map();
for (const r of rows) {
  if (!groups.has(r.model)) groups.set(r.model, []);
  groups.get(r.model).push(r);
}

const sorted = (a) => [...a].sort((x, y) => x - y);
const median = (a) => (a.length ? sorted(a)[Math.floor(a.length / 2)] : null);
const quant = (a, q) => (a.length ? sorted(a)[Math.min(sorted(a).length - 1, Math.floor(a.length * q))] : null);

const perCheck = (ok) => {
  const out = {};
  for (const r of ok) {
    for (const c of r.deterministic?.checks ?? []) {
      if (!out[c.name]) out[c.name] = { pass: 0, total: 0 };
      out[c.name].total++;
      if (c.pass) out[c.name].pass++;
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.pass / v.total]));
};

const modelsOut = [...groups.entries()].map(([id, rs]) => {
  const ok = rs.filter((r) => !r.error);
  const judged = ok.filter((r) => r.judge && !r.judge.error);
  const p = price[id] ?? {};
  const cost = ok.some((r) => r.usage)
    ? ok.reduce((a, r) => {
        const u = r.usage ?? {};
        return a + ((u.prompt_tokens ?? 0) * (p.input ?? 0) + (u.completion_tokens ?? 0) * (p.output ?? 0)) / 1e6;
      }, 0) / ok.length
    : null;
  const rung = rs.find((r) => r.rung)?.rung ?? null;
  return {
    id,
    rung,
    ladder: rs.find((r) => r.ladder)?.ladder ?? null,
    role: rs.find((r) => r.role)?.role ?? null,
    n: rs.length,
    errors: rs.length - ok.length,
    all_pass: ok.filter((r) => r.deterministic?.all_pass).length / (ok.length || 1),
    checks: perCheck(ok),
    judge: {
      n: judged.length,
      candidate_wins: judged.filter((r) => r.judge.vs_prod === 'candidate').length / (judged.length || 1),
      ties: judged.filter((r) => r.judge.vs_prod === 'tie').length / (judged.length || 1),
      prod_wins: judged.filter((r) => r.judge.vs_prod === 'prod').length / (judged.length || 1),
    },
    tokens: {
      in: median(ok.map((r) => r.usage?.prompt_tokens).filter(Number)),
      out: median(ok.map((r) => r.usage?.completion_tokens).filter(Number)),
      reasoning: median(ok.map((r) => r.usage?.completion_tokens_details?.reasoning_tokens).filter(Number)),
    },
    cost_per_call: cost,
    latency_ms: { p50: quant(ok.map((r) => r.latency_ms).filter(Number), 0.5), p95: quant(ok.map((r) => r.latency_ms).filter(Number), 0.95) },
    max_tokens: median(ok.map((r) => r.max_tokens).filter(Number)),
  };
});

const out = {
  schema_version: 1,
  results: args.results,
  dataset: args.dataset ?? null,
  cases: rows.length,
  generated_at: new Date().toISOString(),
  models: modelsOut,
};

mkdirSync(dirname(args.out), { recursive: true });
writeFileSync(args.out, JSON.stringify(out, null, 2) + '\n');
console.log(`Срез: ${modelsOut.length} моделей, ${rows.length} строк → ${args.out}`);

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith('--')) { o[k] = v; i++; } else o[k] = true;
  }
  return o;
}