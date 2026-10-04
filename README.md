# conversation-bench

Независимый бенчмарк генерации писем кандидатам (метод conversation в hh-skill).
Код открытый, данные — только обезличенные и только по явному выпуску владельца.

Дизайн и решение по хранению данных: [docs/DATA-PII.md](docs/DATA-PII.md).

## Что здесь происходит

```
прод (JSONL на сервере) ──extract──▶ обезличенный корпус ──run──▶ результаты ──judge──▶ отчёт
        сырьё остаётся           sha256 в manifest.json       JSONL        слепая пара      markdown
```

1. **Сбор корпуса** — `scripts/extract-corpus.mjs`. Читает сырой JSONL со stdin, дедуплицирует
   промпты, выносит системный промпт в отдельные файлы, обезличивает, проверяет остатки ПДн,
   пишет `manifest.json` с sha256. Остатки ПДн — exit 1, а не предупреждение.
2. **Прогон** — `scripts/run-bench.mjs`. Каждый кейс × каждая модель из `models.json`.
   Ступень лестницы запинена (failover выключен намеренно), параллельность ≤5, фиксируются
   токены (вход/выход), латентность, ретраи. Ничего не отправляется кандидатам.
3. **Оценка** — `scripts/judge.mjs`: детерминированные проверки (бесплатно) + слепой судья
   (продовый ответ и кандидат перемешаны, автор неизвестен, порядок детерминирован от case id).
4. **Отчёт** — `scripts/report.mjs`: качество / цена / скорость по модели, markdown.

## Быстрый старт

```bash
# тесты и гейт ПДн (без ключей — это и есть CI)
node --test test/
node scripts/scan-pii.mjs

# собрать корпус из прода (сырьё идёт через stdin, на диск не пишется)
ssh vm "cat /home/vova/agent-data/hh/conversation-history.jsonl" \
  | node scripts/extract-corpus.mjs --limit 100 --out datasets/prod-2026-10

# прогон и оценка
export OPENROUTER_API_KEY=…
node scripts/run-bench.mjs --dataset datasets/prod-2026-10 --dry-run   # план без API
node scripts/run-bench.mjs --dataset datasets/prod-2026-10 --out results/run.jsonl
node scripts/judge.mjs --results results/run.jsonl --dataset datasets/prod-2026-10
node scripts/report.mjs --results results/run.judged.jsonl --out results/report.md
```

Кандидаты и цены — `models.json` (источник: `trained-assist-llm-ladder/config/ladders.json`).

## Правила репозитория

- `datasets/`, `results/` в `.gitignore`: локальные копии не коммитятся.
- В публичный git попадает только то, что прошло гейт `scan-pii.mjs` **и** осознанно
  выпущено владельцем (см. docs/DATA-PII.md).
- Сырые логи прода (`conversation-history.jsonl`) не должны появиться в индексе — CI проверяет.
- PR неизменяемый: после открытия не пушить в ту же ветку.