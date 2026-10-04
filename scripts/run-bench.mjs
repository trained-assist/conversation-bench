#!/usr/bin/env node
// Прогон: каждый кейс × каждая модель. Пишет результаты в JSONL. Ничего не отправляется кандидатам.
//
//   node scripts/run-bench.mjs --dataset datasets/current --models models.json --out results/run.jsonl
//   node scripts/run-bench.mjs --dry-run          # план без обращений к API
//
// Ступень лестницы запинена (failout выключен): сравнивать модели, а не поведение фейловера.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadDataset } from '../src/dataset.mjs';

const args = parseArgs(process.argv.slice(2));
const dryRun = !!args['dry-run'];
const concurrency = Number(args.concurrency ?? 5);
const limit = args.limit ? Number(args.limit) : Infinity;
const models = JSON.parse(readFileSync(args.models ?? 'models.json', 'utf8')).models;
const out = args.out ?? `results/bench-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;

const ds = loadDataset(args.dataset ?? 'datasets/current');
const cases = ds.cases.slice(0, Number.isFinite(limit) ? limit : ds.cases.length);

if (dryRun) {
  console.log(`Датасет ${ds.manifest.dataset}: ${ds.cases.length} кейсов, берём ${cases.length}`);
  for (const m of models) console.log(`  модель ${m.model} (${m.note ?? m.role ?? ''})`);
  console.log(`План: ${cases.length * models.length} вызовов, параллельность ${concurrency}. Результат: ${out}`);
  process.exit(0);
}

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('Нет OPENROUTER_API_KEY — без него прогон не имеет смысла.');
  process.exit(2);
}

let errors = 0;
mkdirSync(dirname(out), { recursive: true });
const stream = writeFileSync(out, '');
let done = 0;
const total = cases.length * models.length;

const jobs = [];
for (const c of cases) for (const m of models) jobs.push({ c, m });
await Promise.all(Array.from({ length: concurrency }, () => worker()));

console.log(`\nГотово: ${done}/${total} → ${out}`);

async function worker() {
  while (jobs.length) {
    const job = jobs.shift();
    const rec = await runOne(job.c, job.m);
    stream.write(JSON.stringify(rec) + '\n');
    done++;
    if (done % 10 === 0 || done === total) {
      console.error(`  ${done}/${total} (${((done / total) * 100).toFixed(0)}%) ошибок: ${errors}`);
    }
  }
}

async function runOne(c, m) {
  const messages = c.messages.map((msg) => ({
    role: msg.role,
    content: msg.role === 'system' ? ds.prompts.get(msg.ref) ?? '' : msg.content,
  }));
  const temperature = c.prod?.temperature ?? 0.7;
  const started = Date.now();
  const maxTries = 3;

  for (let attempt = 1; attempt <= maxTries; attempt++) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: m.model, messages, temperature, max_tokens: m.max_tokens ?? 1200 }),
      });
      if (!res.ok) {
        const body = await res.text();
        if (res.status === 429 || res.status >= 500) throw new Error(`${res.status}: ${body.slice(0, 200)}`);
        errors++;
        return { case: c.id, model: m.model, error: `${res.status}: ${body.slice(0, 200)}`, latency_ms: Date.now() - started, attempt };
      }
      const json = await res.json();
      const choice = json.choices?.[0];
      return {
        case: c.id,
        model: m.model,
        role: m.role ?? null,
        text: choice?.message?.content ?? '',
        finish: choice?.finish_reason ?? null,
        usage: json.usage ?? null,
        reported_model: json.model ?? null,
        latency_ms: Date.now() - started,
        attempt,
        temperature,
      };
    } catch (e) {
      if (attempt === maxTries) {
        errors++;
        return { case: c.id, model: m.model, error: String(e.message ?? e), latency_ms: Date.now() - started, attempt };
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
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