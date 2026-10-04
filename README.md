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
2. **Прогон** — `scripts/run-bench.mjs`. Каждый кейс × каждая ступень из `models.json`.
   Ступень запинена (`ladder_rung`, фейловер выключен намеренно), параллельность ≤5,
   фиксируются токены (вход/выход), латентность, ретраи. Ничего не отправляется кандидатам.
3. **Оценка** — `scripts/judge.mjs`: детерминированные проверки (бесплатно) + слепой судья
   (продовый ответ и кандидат перемешаны, автор неизвестен, порядок детерминирован от case id).
4. **Отчёт** — `scripts/report.mjs`: качество / цена / скорость по модели, markdown.

## Быстрый старт

```bash
# тесты и гейты (без ключей — это и есть CI)
node --test test/
node scripts/scan-pii.mjs
node scripts/check-no-direct-openrouter.mjs

# собрать корпус из прода (сырьё идёт через stdin, на диск не пишется)
ssh vm "cat /home/vova/agent-data/hh/conversation-history.jsonl" \
  | node scripts/extract-corpus.mjs --limit 100 --out datasets/prod-2026-10

# прогон и оценка — только через НАШУ лестницу (ключ провайдера не нужен и не должен появляться)
export LLM_LADDER_TOKEN=…          # или $AGENT_TOKENS_DIR/llm-ladder/token на сервере
node scripts/run-bench.mjs --dataset datasets/prod-2026-10 --dry-run   # план без вызовов
node scripts/run-bench.mjs --dataset datasets/prod-2026-10 --out results/run.jsonl --resume
node scripts/judge.mjs --results results/run.jsonl --dataset datasets/prod-2026-10
node scripts/report.mjs --results results/run.judged.jsonl --out results/report.md
```

Ступени и цены — `models.json` и `models-free.json` (источник: `trained-assist-llm-ladder/config/ladders.json`
и `config/prices.json`). В них у модели обязательная пара `ladder` + `rung`: `rung` запинена в запросе,
поэтому мы меряем конкретную модель, а не поведение фейловера. `models-free.json` — ступени лестницы
`free` с жёстким потолком $0.

## Правила репозитория

- **Прямых обращений к LLM-провайдерам нет.** Весь транспорт — `src/ladder.mjs` (наша модельная
  лестница): ключи провайдеров живут только в секретах воркера, семян провайдерского ключа
  в репозитории быть не должно. Гейт `scripts/check-no-direct-openrouter.mjs` проверяет это
  в CI; обход — строка с маркером `ladder-only-allow`, только осознанно и особым коммитом.
- `datasets/`, `results/` в `.gitignore`: локальные копии не коммитятся.
- В публичный git попадает только то, что прошло гейт `scan-pii.mjs` **и** осознанно
  выпущено владельцем (см. docs/DATA-PII.md).
- Сырые логи прода (`conversation-history.jsonl`) не должны появиться в индексе — CI проверяет.
- PR неизменяемый: после открытия не пушить в ту же ветку.