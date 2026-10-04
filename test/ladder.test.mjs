// Транспорт лестницы: это ЕДИНСТВЕННЫЙ способ позвать модель из этого репозитория.
// Тесты проверяют контракт, который легко сломать незаметно:
//  - ступень запинена (ladder_rung) — иначе мы меряем фейловер, а не модель;
//  - запрос уходит на лестницу, а не к провайдеру;
//  - нет токена / нет ступени / пустой ответ / HTTP-ошибка → громкая ошибка, не тихий пустой текст.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ladderChat, ladderToken, ladderUrl } from '../src/ladder.mjs';

const MESSAGES = [{ role: 'user', content: 'привет' }];

function withTokenEnv(fn) {
  const prevToken = process.env.LLM_LADDER_TOKEN;
  const prevTokensDir = process.env.AGENT_TOKENS_DIR;
  process.env.LLM_LADDER_TOKEN = 'test-ladder-token';
  try { return fn(); } finally {
    if (prevToken === undefined) delete process.env.LLM_LADDER_TOKEN; else process.env.LLM_LADDER_TOKEN = prevToken;
    if (prevTokensDir === undefined) delete process.env.AGENT_TOKENS_DIR; else process.env.AGENT_TOKENS_DIR = prevTokensDir;
  }
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

test('ladderToken берёт токен из окружения', () => {
  withTokenEnv(() => assert.equal(ladderToken(), 'test-ladder-token'));
});

test('ladderToken читает файл хранилища креденшелов, когда переменной нет', () => {
  const prevToken = process.env.LLM_LADDER_TOKEN;
  const prevDir = process.env.AGENT_TOKENS_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'bench-tokens-'));
  mkdirSync(join(dir, 'llm-ladder'), { recursive: true });
  writeFileSync(join(dir, 'llm-ladder', 'token'), 'file-ladder-token\n');
  delete process.env.LLM_LADDER_TOKEN;
  process.env.AGENT_TOKENS_DIR = dir;
  try {
    assert.equal(ladderToken(), 'file-ladder-token');
  } finally {
    if (prevToken === undefined) delete process.env.LLM_LADDER_TOKEN; else process.env.LLM_LADDER_TOKEN = prevToken;
    if (prevDir === undefined) delete process.env.AGENT_TOKENS_DIR; else process.env.AGENT_TOKENS_DIR = prevDir;
  }
});

test('ladderToken = null без токена (громкая ошибка дальше, не тихий провайдер)', () => {
  const prevToken = process.env.LLM_LADDER_TOKEN;
  const prevDir = process.env.AGENT_TOKENS_DIR;
  delete process.env.LLM_LADDER_TOKEN;
  process.env.AGENT_TOKENS_DIR = mkdtempSync(join(tmpdir(), 'bench-empty-'));
  try {
    assert.equal(ladderToken(), null);
  } finally {
    if (prevToken === undefined) delete process.env.LLM_LADDER_TOKEN; else process.env.LLM_LADDER_TOKEN = prevToken;
    if (prevDir === undefined) delete process.env.AGENT_TOKENS_DIR; else process.env.AGENT_TOKENS_DIR = prevDir;
  }
});

test('ladderChat уходит на лестницу, запинивает ступень и несёт атрибуцию', async () => {
  const seen = {};
  const res = await withTokenEnv(() => ladderChat({
    messages: MESSAGES,
    ladder: 'conversation',
    rung: 'openrouter/google/gemini-2.5-flash',
    temperature: 0,
    maxTokens: 400,
    source: 'conversation-bench',
    fetchImpl: async (url, opts) => {
      seen.url = url;
      seen.opts = opts;
      seen.body = JSON.parse(opts.body);
      return jsonResponse({ model: 'openrouter/google/gemini-2.5-flash', choices: [{ message: { content: 'ок' }, finish_reason: 'stop' }], usage: { total_tokens: 5 } });
    },
  }));

  assert.match(seen.url, /^https:\/\/llm-ladder\.trainedassist\.store\/v1\/chat\/completions$/);
  assert.equal(seen.opts.headers.Authorization, 'Bearer test-ladder-token');
  assert.equal(seen.opts.headers['x-ladder-app'], 'conversation-bench');
  assert.equal(seen.body.model, 'conversation');
  assert.equal(seen.body.ladder_rung, 'openrouter/google/gemini-2.5-flash');
  assert.equal(seen.body.temperature, 0);
  assert.equal(seen.body.max_tokens, 400);
  assert.equal(res.content, 'ок');
});

test('ladderChat умеет просить JSON (судья)', async () => {
  let body = null;
  await withTokenEnv(() => ladderChat({
    messages: MESSAGES,
    ladder: 'conversation',
    rung: 'openrouter/google/gemini-2.5-flash',
    responseFormat: { type: 'json_object' },
    fetchImpl: async (_url, opts) => {
      body = JSON.parse(opts.body);
      return jsonResponse({ choices: [{ message: { content: '{}' } }] });
    },
  }));
  assert.deepEqual(body.response_format, { type: 'json_object' });
});

test('ladderChat требует ступень: без неё меряется фейловер', async () => {
  await withTokenEnv(() => assert.rejects(
    () => ladderChat({ messages: MESSAGES, ladder: 'conversation', fetchImpl: async () => jsonResponse({}) }),
    /ступень/,
  ));
});

test('ladderChat требует токен лестницы', async () => {
  const prevToken = process.env.LLM_LADDER_TOKEN;
  const prevDir = process.env.AGENT_TOKENS_DIR;
  delete process.env.LLM_LADDER_TOKEN;
  process.env.AGENT_TOKENS_DIR = mkdtempSync(join(tmpdir(), 'bench-empty-'));
  try {
    await assert.rejects(
      () => ladderChat({ messages: MESSAGES, ladder: 'conversation', rung: 'x', fetchImpl: async () => jsonResponse({}) }),
      /нет токена/,
    );
  } finally {
    if (prevToken === undefined) delete process.env.LLM_LADDER_TOKEN; else process.env.LLM_LADDER_TOKEN = prevToken;
    if (prevDir === undefined) delete process.env.AGENT_TOKENS_DIR; else process.env.AGENT_TOKENS_DIR = prevDir;
  }
});

test('ladderChat падает громко на HTTP-ошибке лестницы', async () => {
  await withTokenEnv(() => assert.rejects(
    () => ladderChat({
      messages: MESSAGES, ladder: 'conversation', rung: 'x',
      fetchImpl: async () => ({ ok: false, status: 400, text: async () => 'rung not in ladder: x' }),
    }),
    /ladder HTTP 400/,
  ));
});

test('ladderChat падает на пустом ответе, а не возвращает пустую строку', async () => {
  await withTokenEnv(() => assert.rejects(
    () => ladderChat({
      messages: MESSAGES, ladder: 'conversation', rung: 'x',
      fetchImpl: async () => jsonResponse({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
    }),
    /пустой ответ/,
  ));
});

test('URL лестницы настраивается переменной окружения', () => {
  const prev = process.env.LLM_LADDER_URL;
  process.env.LLM_LADDER_URL = 'https://ladder.example.test/';
  try {
    assert.equal(ladderUrl(), 'https://ladder.example.test');
  } finally {
    if (prev === undefined) delete process.env.LLM_LADDER_URL; else process.env.LLM_LADDER_URL = prev;
  }
});