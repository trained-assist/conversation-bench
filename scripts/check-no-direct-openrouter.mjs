#!/usr/bin/env node
// Гейт: в этом репозитории не должно быть прямых обращений к LLM-провайдерам.
// Единственный транспорт — наша модельная лестница (src/ladder.mjs). Провайдерские ключи
// живут только в секретах воркера лестницы; бенчмарку они не нужны и не должны попадать сюда.
//
// Проверяем то, что реально означает прямой вызов: хост провайдера, ключ провайдера,
// чтение файла провайдерского ключа. Имена ступеней лестницы вида `openrouter/google/…`
// НЕ запрещены — это идентификаторы ступеней из config/ladders.json, а не вызовы.
//
// Обход намеренно неудобен: строка с маркером `ladder-only-allow` исключается из проверки
// (нужно для документации вида «раньше был прямой вызов»).
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['.git', 'node_modules', 'datasets', 'results', 'fixtures']);
const ALLOW_MARKER = 'ladder-only-allow';

// Хосты прямых вызовов и ключи провайдеров.
const FORBIDDEN = [
  { re: /openrouter\.ai/i, why: 'прямой хост OpenRouter' },
  { re: /OPENROUTER_API_KEY/, why: 'ключ OpenRouter' },
  { re: /['"`]\/openrouter['"`]/, why: 'чтение файла ключа провайдера' },
  { re: /OPENCODE_GO_API_KEYS|GIGACHAT_CREDENTIALS/, why: 'ключ провайдера Go/GigaChat' },
];

const hits = [];
for (const file of walk(ROOT)) {
  const text = readFileSync(file, 'utf8');
  if (text.includes(ALLOW_MARKER)) continue;
  const lines = text.split('\n');
  for (const rule of FORBIDDEN) {
    lines.forEach((line, i) => {
      if (rule.re.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}  ${rule.why}\n    ${line.trim().slice(0, 160)}`);
    });
  }
}

if (hits.length) {
  console.error(`Прямой доступ к LLM-провайдеру запрещён (${hits.length}):\n`);
  for (const h of hits) console.error('  ' + h);
  console.error('\nПравильный путь: src/ladder.mjs — лестница владеет ключами, мы выбираем ступень.');
  process.exit(1);
}
console.log('Прямых обращений к провайдерам нет — весь LLM-трафик через лестницу.');

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (/\.(mjs|js|cjs|ts|json|sh|yml|yaml)$/.test(e)) out.push(full);
  }
  return out;
}