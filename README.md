# conversation-bench

**GCP VM exit (05.10.2026):** New work on `alesa-personal-assistent/us-central1-a/alesa-vm` is prohibited. Use serverless by default; the existing French VM only for a proven persistent or local requirement. Other Google services remain allowed. See [the exit plan](https://github.com/trained-assist/trained-agent-architecture/issues/145).


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
   Детерминированный слой ловит и то, что не видно глазом: `no_cjk` (иероглифы и другие
   письменности), `no_markdown` (письмо в hh — plain text), `no_placeholder_leak` (плейсхолдеры,
   которых нет ни в промпте, ни в эталоне), `no_symbol_spam` (эмодзи-гирлянда, разделители),
   `no_repeat_question`. Проверки настраиваются на ЭТАЛОН: корпус прода — 100 кейсов, и ни одна
   проверка не должна валиться на эталонных ответах, иначе она измеряет свой порог, а не дефект
   модели. Первое касание определяется по тексту промпта (`first_touch` в кейсе), а не по числу
   сообщений: прод кладёт всю переписку в одно сообщение, и «сообщений ≤ 1» было бы «первое
   касание» для всего корпуса.
4. **Отчёт** — `scripts/report.mjs`: качество / цена / скорость по модели, плюс разбивка
   поимённо по каждой детерминированной проверке, reasoning-токены и лимит ответа. В таблицу
   добавляется строка «эталон» — `scripts/baseline.mjs` превращает продовые ответы корпуса в
   строку `prod-reference`: это база, которую обязан набрать кандидат, и одновременно счётчик
   ложных срабатываний проверок (если эталон валится по `language_ru`, виновата проверка).
   Судью эталонная строка не судится: `judge.mjs --skip-judge-models prod-reference`.
5. **Бюджет входа** — `scripts/budget.mjs`: какая доля промпта съедается системным промптом,
   профилем, сжатой историей и целью, и сколько входа остаётся платной модели в двухшаговой
   схеме «дешёвая ступень пишет → платная переписывает». Считает локально, сети не касается:

   ```bash
   npm ci   # gpt-tokenizer; без него скрипт честно падает на грубую эвристику и предупреждает
   node scripts/budget.mjs --dataset datasets/prod-2026-10 --results results/run-free-v2.jsonl
   ```

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
`free` с жёстким потолком $0. `id` — стабильное имя для результатов и цен в отчёте.

**Ступень должна существовать в лестнице.** `rung` — это id провайдера внутри лестницы
(`opencode-go/…`, `openrouter/…`); лестница отвечает 400 на ступень, которой у неё нет.
На 04.10.2026 в лестнице `conversation` ровно три ступени: `gemini-3.1-flash-lite-preview` (прод),
`gemini-2.5-flash`, `opencode-go/mimo-v2.6-flash`. Дешёвые `ling-3.0-flash` и `xiaomi/mimo-v2.6-flash`
в неё не входят — чтобы они стали кандидатами на письма, их сначала нужно добавить в
`config/ladders.json` лестницы (это изменение продукта, а не бенчмарка). Конфиг читается
`src/config.mjs` и валидируется один раз при старте: без пары `ladder`+`rung`, с повторяющимся
`id` или со ступенью вне известных провайдеров прогон падает сразу, а не на середине.

**Судья.** По умолчанию — платная ступень из блока `judge` в `models.json`. Пока у провайдера нет
кредита, судью можно гнать на бесплатной ступени (`--judge-ladder free --judge-rung
openrouter/nvidia/nemotron-3-super-120b-a12b:free`), но тогда качество суждения — уровень
бесплатной модели, и это обязано быть помечено в отчёте: бесплатный судья не заменяет baseline.

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