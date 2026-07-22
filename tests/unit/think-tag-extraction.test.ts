import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../../src/index.js';
import { clearProxyConfigCache } from '../../src/utils/config-loader.js';

function makeConfigPath(): string {
    const p = join(tmpdir(), `proxy_think_tag_${Date.now()}_${Math.random().toString(36).slice(2)}.toml`);
    writeFileSync(p, `
[models.default]
upstream_mode = "openai-completions"
base_url = "https://api.example.com"
api_key = "sk-test"
`, 'utf-8');
    return p;
}

const realFetch = globalThis.fetch;
let configPath = '';

const THINK_TEXT = 'reasoning body for unit test';
const NORMAL_TEXT = 'final answer for unit test';
const THINK_CONTENT = `<think>${THINK_TEXT}</think>${NORMAL_TEXT}`;

function mockOpenAI(content: string) {
    return {
        id: 'chatcmpl_think',
        object: 'chat.completion',
        created: 0,
        model: 'test-model',
        choices: [{
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
}

function installMockFetch(payload: object) {
    globalThis.fetch = async (): Promise<Response> => new Response(
        JSON.stringify(payload),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
}

async function sendMessages() {
    return handler.fetch(new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'client-key' },
        body: JSON.stringify({
            model: 'test-model',
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 64,
        }),
    }), { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any);
}

async function sendResponses() {
    return handler.fetch(new Request('http://localhost/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': 'client-key' },
        body: JSON.stringify({
            model: 'test-model',
            input: 'hi',
        }),
    }), { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any);
}

async function sendGenerateContent() {
    return handler.fetch(new Request('http://localhost/v1beta/models/test-model:generateContent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'client-key' },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        }),
    }), { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any);
}

describe('<think>/<thinking> tag extraction for openai-completions upstream', () => {
    beforeEach(() => {
        clearProxyConfigCache();
        configPath = makeConfigPath();
    });

    afterEach(() => {
        clearProxyConfigCache();
        globalThis.fetch = realFetch;
        if (configPath) unlinkSync(configPath);
        configPath = '';
    });

    describe('/v1/messages', () => {
        it('extracts <think>...</think> into a Claude thinking block and strips the tags from text', async () => {
            installMockFetch(mockOpenAI(THINK_CONTENT));
            const resp = await sendMessages();
            assert.equal(resp.status, 200);
            const body = await resp.json() as any;
            const types = (body.content as Array<{ type: string; thinking?: string; text?: string }>).map((b) => b.type);
            // Both blocks must be present; order is implementation-defined.
            assert.deepEqual(types.sort(), ['text', 'thinking']);
            const thinkingBlock = body.content.find((b: any) => b.type === 'thinking');
            const textBlock = body.content.find((b: any) => b.type === 'text');
            assert.equal(thinkingBlock.thinking, THINK_TEXT);
            assert.equal(textBlock.text, NORMAL_TEXT);
            assert(!textBlock.text.includes('<think>'), 'tag should be stripped from text block');
        });

        it('still recognizes legacy <thinking>...</thinking> tags', async () => {
            installMockFetch(mockOpenAI(`<thinking>${THINK_TEXT}</thinking>${NORMAL_TEXT}`));
            const resp = await sendMessages();
            assert.equal(resp.status, 200);
            const body = await resp.json() as any;
            const thinkingBlock = body.content.find((b: any) => b.type === 'thinking');
            const textBlock = body.content.find((b: any) => b.type === 'text');
            assert(thinkingBlock, 'thinking block must be present');
            assert.equal(thinkingBlock.thinking, THINK_TEXT);
            assert.equal(textBlock.text, NORMAL_TEXT);
        });

        it('returns plain text when no think tags are present', async () => {
            installMockFetch(mockOpenAI(NORMAL_TEXT));
            const resp = await sendMessages();
            assert.equal(resp.status, 200);
            const body = await resp.json() as any;
            assert.deepEqual(body.content.map((b: any) => b.type), ['text']);
            assert.equal(body.content[0].text, NORMAL_TEXT);
        });
    });

    describe('/v1/responses', () => {
        it('extracts <think>...</think> into a Responses reasoning output item', async () => {
            installMockFetch(mockOpenAI(THINK_CONTENT));
            const resp = await sendResponses();
            assert.equal(resp.status, 200);
            const body = await resp.json() as any;
            const output = body.output as Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
            const reasoningItem = output.find((o) => o.type === 'reasoning');
            const messageItem = output.find((o) => o.type === 'message');
            assert(reasoningItem, 'reasoning output item should be present');
            assert.equal(reasoningItem.content?.[0].type, 'reasoning_text');
            assert.equal(reasoningItem.content?.[0].text, THINK_TEXT);
            // Stripped text should be present on the message item
            const textPart = messageItem?.content?.find((p) => p.type === 'output_text');
            assert.equal(textPart?.text, NORMAL_TEXT);
            assert(!JSON.stringify(messageItem?.content).includes('<think>'), 'tag should be stripped from message content');
        });

        it('returns plain text when no think tags are present', async () => {
            installMockFetch(mockOpenAI(NORMAL_TEXT));
            const resp = await sendResponses();
            assert.equal(resp.status, 200);
            const body = await resp.json() as any;
            const output = body.output as Array<{ type: string }>;
            assert(!output.some((o) => o.type === 'reasoning'), 'no reasoning item when no tags');
            const messageItem = output.find((o) => o.type === 'message');
            assert.equal(messageItem?.content?.[0].text, NORMAL_TEXT);
        });
    });

    describe('/v1beta/models/<model>:generateContent', () => {
        it('extracts <think>...</think> into a Gemini thought part', async () => {
            installMockFetch(mockOpenAI(THINK_CONTENT));
            const resp = await sendGenerateContent();
            assert.equal(resp.status, 200);
            const body = await resp.json() as any;
            const parts = body.candidates?.[0]?.content?.parts as Array<Record<string, unknown>>;
            assert(parts, 'parts should exist');
            const thoughtPart = parts.find((p) => p.thought === true);
            const textPart = parts.find((p) => typeof p.text === 'string' && p.thought !== true);
            assert(thoughtPart, 'thought part should be present');
            assert.equal(thoughtPart.text, THINK_TEXT);
            assert.equal(textPart?.text, NORMAL_TEXT);
            assert(!JSON.stringify(parts).includes('<think>'), 'tag should be stripped from parts');
        });

        it('returns plain text when no think tags are present', async () => {
            installMockFetch(mockOpenAI(NORMAL_TEXT));
            const resp = await sendGenerateContent();
            assert.equal(resp.status, 200);
            const body = await resp.json() as any;
            const parts = body.candidates?.[0]?.content?.parts as Array<Record<string, unknown>>;
            assert.equal(parts.length, 1);
            assert.equal(parts[0].text, NORMAL_TEXT);
            assert(!('thought' in parts[0]) || parts[0].thought !== true);
        });
    });
});