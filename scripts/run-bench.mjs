#!/usr/bin/env node
// Прогон: каждый кейс × каждая ступень лестницы. Пишет результаты в JSONL. Ничего не отправляется кандидатам.
//
//   node scripts/run-bench.mjs --dataset datasets/current --models models.json --out results/run.jsonl
//   node scripts/run-bench.mjs --dry-run          # план без обращений к API
//
// Единственный транспорт — НАША лестница (src/ladder.mjs). Прямых обращений к провайдерам
// (OpenRouter и т.п.) в этом репозитории нет вообще: ключи провайдеров живут только в
// секретах воркера лестницы. Ступень запинена (ladder_rung, фейловер выключен) — сравниваем
// модели, а не поведение фейловера.
//
// Формат models.json:
//   { "models": [ { "ladder": "conversation", "rung": "openrouter/google/gemini-2.5-flash",
//                    "id": "стабильное-имя-для-файла", "role": "prod"|"cand",
//                    "note": "...", "max_tokens": 4000, "price": { "input": 0.3, "output": 2.5 } } ] }
// Поле model в результатах = id; рядом пишем ladder/rung — что реально звали.
import { appendFileSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadDataset } from '../src/dataset.mjs';
import { ladderChat, ladderToken } from '../src/ladder.mjs';

const args = parseArgs(process.argv.slice(2));
const dryRun = !!args['dry-run'];
const concurrency = Number(args.concurrency ?? 5);
const limit = args.limit ? Number(args.limit) : Infinity;
const models = JSON.parse(readFileSync(args.models ?? 'models.json', 'utf8')).models.map(normalizeModel);
const out = args.out ?? `results/bench-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;

const ds = loadDataset(args.dataset ?? 'datasets/current');
const cases = ds.cases.slice(0, Number.isFinite(limit) ? limit : ds.cases.length);

if (dryRun) {
  console.log(`Датасет ${ds.manifest.dataset}: ${ds.cases.length} кейсов, берём ${cases.length}`);
  for (const m of models) console.log(`  ${m.model}  <- лестница ${m.ladder}, ступень ${m.rung} (${m.note ?? m.role ?? ''})`);
  console.log(`План: ${cases.length * models.length} вызовов, параллельность ${concurrency}. Результат: ${out}`);
  process.exit(0);
}

if (!ladderToken()) {
  console.error('Нет токена лестницы (LLM_LADDER_TOKEN или $AGENT_TOKENS_DIR/llm-ladder/token) — прогон невозможен.');
  process.exit(2);
}

let errors = 0;
mkdirSync(dirname(out), { recursive: true });
if (!args.resume) writeFileSync(out, '');

// Resume: уже посчитанные пары case×rung не повторяем — прогон длинный.
const already = new Set();
if (args.resume && existsSync(out)) {
  for (const line of readFileSync(out, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t);
      // Готовым считаем только НЕпустой ответ: ошибка (429) и пустой text (съеденный
      // рассуждениями лимит ответа) должны быть перепробованы — иначе дыры молча едут в отчёт.
      if (r.text && r.text.trim()) already.add(key(r.case, r.model));
    } catch { /* битая строка */ }
  }
  console.log(`Resume: уже есть ${already.size} записей, повторяем только недостающие.`);
}

const jobs = [];
for (const c of cases) for (const m of models) {
  if (already.has(key(c.id, m.model))) continue;
  jobs.push({ c, m });
}
const total = jobs.length;
let done = 0;
console.log(`К вызову: ${total} (из ${cases.length * models.length})`);
await Promise.all(Array.from({ length: concurrency }, () => worker()));

console.log(`\nГотово: ${done}/${total} -> ${out}`);

async function worker() {
  while (jobs.length) {
    const job = jobs.shift();
    const rec = await runOne(job.c, job.m);
    appendFileSync(out, JSON.stringify(rec) + '\n');
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
      const r = await ladderChat({
        messages,
        ladder: m.ladder,
        rung: m.rung,
        temperature,
        maxTokens: m.max_tokens ?? 1200,
        timeoutMs: m.timeout_ms ?? 120000,
        source: 'conversation-bench',
      });
      return {
        case: c.id,
        model: m.model,
        ladder: m.ladder,
        rung: m.rung,
        role: m.role ?? null,
        text: r.content,
        finish: r.finish,
        usage: r.usage,
        reported_model: r.model,
        latency_ms: Date.now() - started,
        attempt,
        temperature,
      };
    } catch (e) {
      if (attempt === maxTries) {
        errors++;
        return {
          case: c.id, model: m.model, ladder: m.ladder, rung: m.rung, role: m.role ?? null,
          error: String(e.message ?? e), latency_ms: Date.now() - started, attempt, temperature,
        };
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

function key(caseId, model) {
  return `${caseId}::${model}`;
}

// Старое поле `model: "openrouter/<id>"` — это id провайдера, а не ступень лестницы.
// Приводим к явной паре ladder+rung, чтобы мимо лестницы позвать провайдера было нельзя.
function normalizeModel(m) {
  if (!m.ladder || !m.rung) throw new Error(`models.json: у "${m.id ?? m.model ?? '?'}" нет пары ladder+rung`);
  return { ...m, model: m.id ?? m.model ?? m.rung };
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