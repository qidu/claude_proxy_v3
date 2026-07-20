import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../../src/index.js';
import { clearProxyConfigCache } from '../../src/utils/config-loader.js';

function makeConfigPath(): string {
  const p = join(tmpdir(), `proxy_role_default_${Date.now()}_${Math.random().toString(36).slice(2)}.toml`);
  writeFileSync(p, `
[models.default]
upstream_mode = "openai-completions"
base_url = "https://api.example.com"
api_key = "sk-test"
`, 'utf-8');
  return p;
}

type UpstreamCall = { url: string; body: Record<string, unknown> };

const realFetch = globalThis.fetch;
let configPath = '';
let upstreamCalls: UpstreamCall[] = [];

function installMockFetch() {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    upstreamCalls.push({ url, body });
    return new Response(JSON.stringify({
      id: 'chatcmpl_test',
      object: 'chat.completion',
      created: 0,
      model: body.model || 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

describe('Gemini endpoints routed to openai-completions', () => {
  beforeEach(() => {
    clearProxyConfigCache();
    configPath = makeConfigPath();
    upstreamCalls = [];
    installMockFetch();
  });

  afterEach(() => {
    clearProxyConfigCache();
    globalThis.fetch = realFetch;
    if (configPath) unlinkSync(configPath);
  });

  it('defaults missing /v1/interactions message roles to user', async () => {
    const resp = await handler.fetch(new Request('http://localhost/v1/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'client-key' },
      body: JSON.stringify({ model: 'test-model', input: { messages: [{ content: 'hi' }] } }),
    }), { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any);

    assert.equal(resp.status, 200);
    assert.equal(upstreamCalls.length, 1);
    const messages = upstreamCalls[0].body.messages as Array<Record<string, unknown>>;
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content, 'hi');
  });

  it('defaults missing generateContent content roles to user', async () => {
    const resp = await handler.fetch(new Request('http://localhost/v1beta/models/test-model:generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'client-key' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }] }),
    }), { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any);

    assert.equal(resp.status, 200);
    assert.equal(upstreamCalls.length, 1);
    const messages = upstreamCalls[0].body.messages as Array<Record<string, unknown>>;
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[0].content, 'hi');
  });
});
