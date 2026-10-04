// Единственный транспорт LLM в этом репозитории — наша модельная лестница
// (trained-assist/trained-assist-llm-ladder, Cloudflare Worker, OpenAI-совместимый API).
//
// Правило продукта: прямых обращений к провайдерам (OpenRouter и т.п.) из этого репозитория
// нет вообще. Ключи провайдеров живут только в секретах воркера лестницы; бенчмарк получает
// токен лестницы и сам выбирает СТУПЕНЬ (`ladder_rung`) — так замеряется именно модель,
// а не поведение фейловера. Гейт scripts/check-no-direct-openrouter.mjs не даёт вернуться
// к прямому вызову.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function ladderUrl() {
  return (process.env.LLM_LADDER_URL ?? 'https://llm-ladder.trainedassist.store').replace(/\/+$/, '');
}

// Токен лестницы: переменная окружения, иначе файл в хранилище креденшелов профиля
// ($AGENT_TOKENS_DIR/llm-ladder/token — тот же путь, что у hh-skill и агента).
export function ladderToken() {
  const fromEnv = process.env.LLM_LADDER_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const base = process.env.AGENT_TOKENS_DIR || join(homedir(), 'agent-tokens');
  const file = join(base, 'llm-ladder', 'token');
  try {
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8').trim();
      if (text) return text;
    }
  } catch { /* unreadable = no token */ }
  return null;
}

/**
 * Один вызов chat.completions через лестницу со ЗАПИНЕННОЙ ступенью.
 *
 * @param {object} o
 * @param {Array<{role:string,content:string}>} o.messages
 * @param {string} o.ladder              имя лестницы из config/ladders.json лестницы
 * @param {string} o.rung                ступень этой лестницы (обязательна: без неё меряется фейловер)
 * @param {number} [o.temperature=0]
 * @param {number} [o.maxTokens=1200]
 * @param {number} [o.timeoutMs=120000]  бюджет на ступень (рассуждение eat'ает лимит ответа)
 * @param {string} [o.source='conversation-bench']  атрибуция x-ladder-app
 * @param {object} [o.responseFormat]    напр. {type:'json_object'}
 * @param {Function} [o.fetchImpl]
 * @returns {Promise<{content:string, model:string|null, usage:object|null}>}
 * @throws {Error} нет токена / HTTP-ошибка лестницы / пустой ответ
 */
export async function ladderChat({ messages, ladder, rung, temperature = 0, maxTokens = 1200, timeoutMs = 120_000, source = 'conversation-bench', responseFormat, fetchImpl = null } = {}) {
  if (!ladder) throw new Error('ladder: не указано имя лестницы');
  if (!rung) throw new Error('ladder: ступень (rung) обязательна — иначе мы меряем фейловер, а не модель');
  if (!Array.isArray(messages) || !messages.length) throw new Error('ladder: messages required');

  const token = ladderToken();
  if (!token) throw new Error('ladder: нет токена (LLM_LADDER_TOKEN или $AGENT_TOKENS_DIR/llm-ladder/token)');

  const body = {
    model: ladder,
    messages,
    temperature,
    max_tokens: maxTokens,
    ladder_timeout_ms: timeoutMs,
    ladder_rung: rung,
    ...(responseFormat ? { response_format: responseFormat } : {}),
  };

  const res = await (fetchImpl || fetch)(`${ladderUrl()}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'x-ladder-app': source,
      'x-ladder-app-title': 'Conversation bench',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs + 20_000),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`ladder HTTP ${res.status}: ${text.slice(0, 300)}`);

  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`ladder: не JSON в ответе: ${text.slice(0, 200)}`); }
  const content = json.choices?.[0]?.message?.content ?? '';
  if (!content) throw new Error(`ladder: пустой ответ (finish=${json.choices?.[0]?.finish_reason ?? '?'})`);
  return { content, model: json.model ?? null, usage: json.usage ?? null, finish: json.choices?.[0]?.finish_reason ?? null };
}