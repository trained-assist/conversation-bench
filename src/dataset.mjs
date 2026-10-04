// Загрузка датасета с проверкой целостности. Три источника — код от них не зависит:
//
//   datasets/current/                 — локальная папка (то, что собрал extract-corpus)
//   BENCH_DATASET_REF=owner/private#subdir — приватный git-репозиторий (клонируется в кэш)
//   BENCH_DATASET_URL=https://…/corpus.jsonl + BENCH_DATASET_TOKEN=… — bucket/object storage
//
// Во всех случаях проверяется sha256 корпуса из манифеста: молчаливая подмена датасета
// делает несравнимые результаты, а это худший вид поломки бенчмарка.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function loadDataset(source = process.env.BENCH_DATASET_DIR ?? 'datasets/current') {
  const dir = resolveDir(source);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const corpusRaw = readFileSync(join(dir, manifest.corpus_file), 'utf8');

  const got = sha256(corpusRaw);
  if (manifest.corpus_sha256 && got !== manifest.corpus_sha256) {
    throw new Error(`sha256 корпуса не совпал: манифест ${manifest.corpus_sha256}, файл ${got}. Прогон бессмыслен.`);
  }

  const prompts = new Map();
  for (const p of manifest.prompts_list ?? readPrompts(dir)) prompts.set(p.ref, p.text);

  const cases = corpusRaw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { dir, manifest, cases, prompts };
}

function readPrompts(dir) {
  const out = [];
  for (const f of listFiles(join(dir, 'prompts'))) {
    if (!f.endsWith('.txt')) continue;
    out.push({ ref: f.split('/').pop().replace(/\.txt$/, ''), text: readFileSync(join(dir, 'prompts', f), 'utf8') });
  }
  return out;
}

function listFiles(dir, prefix = '') {
  const res = [];
  for (const e of readdirSync(dir)) {
    const rel = prefix ? `${prefix}/${e}` : e;
    if (statSync(join(dir, e)).isDirectory()) res.push(...listFiles(join(dir, e), rel));
    else res.push(rel);
  }
  return res;
}

function resolveDir(source) {
  if (existsSync(join(source, 'manifest.json'))) return source;

  const ref = process.env.BENCH_DATASET_REF;
  if (ref && source === 'auto') return cloneRef(ref);
  if (ref && !existsSync(source)) return cloneRef(ref);

  const url = process.env.BENCH_DATASET_URL;
  if (url && source === 'auto') throw new Error('BENCH_DATASET_URL требует адаптера загрузки — используй локальную папку или BENCH_DATASET_REF.');

  throw new Error(`Датасет не найден: ${source}. Собери его extract-corpus.mjs или укажи BENCH_DATASET_DIR.`);
}

/** Приватный репозиторий с данными: клон в кэш и фиксация коммита — версия датасета воспроизводима. */
function cloneRef(ref) {
  const [repo, subdir = '.'] = ref.split('#');
  const cache = join(tmpdir(), `bench-dataset-${repo.replace(/[^\w.-]/g, '_')}`);
  if (!existsSync(cache)) {
    execFileSync('git', ['clone', '--depth', '1', `https://github.com/${repo}.git`, cache], { stdio: 'inherit' });
  } else {
    execFileSync('git', ['-C', cache, 'pull', '--ff-only'], { stdio: 'inherit' });
  }
  const sha = execFileSync('git', ['-C', cache, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  console.error(`Датасет из ${repo}@${sha.slice(0, 8)} (${subdir})`);
  return subdir === '.' ? cache : join(cache, subdir);
}