#!/usr/bin/env node
// Гейт ПДн для публичного репозитория. Сканирует tracked-файлы (git ls-files) и падает,
// если после обезличивания осталось что-то похожее на персональные данные.
//
//   node scripts/scan-pii.mjs              # всё, что в индексе git
//   node scripts/scan-pii.mjs path/to/x    # только указанные пути
//
// Политика, чтобы код можно было писать, а данные — не течь:
//   * fixtures/ — исключён: там ВЫМЫШЛЕННЫЕ данные для тестов псевдонимизации;
//   * любые email/телефоны/telegram/ФИО/ИНН — ошибка в любом файле, включая тесты;
//   * прочие URL — находка только в данных (jsonl/txt/md), в коде эндпоинты легальны;
//   * строка с комментарием `pii-allow` пропускается — для синтетических литералов в
//     тестах, видно на ревью, не спрятано.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { scan } from '../src/pii.mjs';

const TEXT = /\.(mjs|js|json|md|txt|jsonl|ya?ml)$/i;
const DATA = /\.(jsonl|txt|md|csv|tsv)$/i;
const SKIP_DIRS = ['fixtures/', 'node_modules/', '.git/', 'datasets/', 'results/'];
const ALLOW_MARKER = 'pii-allow';

const paths = process.argv.slice(2).length
  ? process.argv.slice(2)
  : trackedFiles();

let total = 0;
let checked = 0;
for (const path of paths) {
  if (!TEXT.test(path)) continue;
  if (SKIP_DIRS.some((d) => path.startsWith(d))) continue;
  if (!existsSync(path)) continue;
  checked++;

  const lines = readFileSync(path, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.includes(ALLOW_MARKER)) return;
    for (const f of scan(line)) {
      if (f.type === 'url' && !DATA.test(path)) continue;
      total++;
      console.error(`[ПДн] ${path}:${i + 1}: ${f.type} — «…${f.context}…»`);
    }
  });
}

if (total > 0) {
  console.error(`\nГейт ПДн: ${total} находок в публичном репозитории. Мерж заблокирован.`);
  process.exit(1);
}
console.log(`Гейт ПДн: чисто (${checked} файлов проверено).`);

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    console.error('Не git-репозиторий — просканируй только явные пути.');
    return [];
  }
}