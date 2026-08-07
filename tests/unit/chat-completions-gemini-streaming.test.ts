import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { handleChatCompletionsPassthrough } from '../../src/handlers/chat-completions.js';
import { createLogger } from '../../src/utils/logger.js';

/**
 * End-to-end coverage for the gemini-generatecontent cross-mode route in the
 * chat-completions handler. Exercises both the non-streaming response chain
 * and the streaming SSE transformer with a stubbed fetch returning canned
 * Gemini output.
 */

const testLogger = createLogger({});

const env = {} as any;

function makeRequest(body: Record<string, unknown>, stream = false): Request {
  return new Request('https://proxy.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream }),
  });
}

function geminiNonStreamResponse(text: string, status = 200): Response {
  return new Response(JSON.stringify({
    candidates: [{
      content: { role: 'model', parts: [{ text }] },
      finishReason: 'STOP',
      index: 0,
    }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
  }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function geminiStreamResponse(textChunks: string[]): Response {
  const encoder = new TextEncoder();
  const parts = textChunks.map(t =>
    `data: ${JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: t }] }, finishReason: null }],
    })}\n\n`,
  );
  parts.push(`data: ${JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
  })}\n\n`);
  const stream = new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(encoder.encode(p));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('handleChatCompletionsPassthrough — gemini-generatecontent cross-mode', () => {
  const realFetch = globalThis.fetch;
  after(() => { globalThis.fetch = realFetch; });

  it('non-streaming: converts OpenAI body to Gemini, response back to completions JSON', async () => {
    let capturedBody: any;
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return geminiNonStreamResponse('hello world');
    }) as typeof fetch;

    const req = makeRequest({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const res = await handleChatCompletionsPassthrough(
      req, 'https://upstream/v1beta/models/gemini-2.0-flash:generateContent',
      { Authorization: 'Bearer k' }, 'rid-1', testLogger, env, 'gemini-2.0-flash', 'gemini-generatecontent',
    );

    assert.equal(res.status, 200);
    // Request to upstream carried x-goog-api-key, not Authorization.
    // (capture fetch headers not exposed here; assert body shape instead.)
    assert.deepEqual(capturedBody.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);

    const json = await res.json();
    assert.equal(json.choices[0].message.content, 'hello world');
  });

  it('non-streaming: data-URI image_url is converted to inline_data', async () => {
    let capturedBody: any;
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return geminiNonStreamResponse('ok');
    }) as typeof fetch;

    const req = makeRequest({
      model: 'g',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,ABC' } },
        ],
      }],
    });
    await handleChatCompletionsPassthrough(
      req, 'https://upstream/v1beta/models/g:generateContent',
      { Authorization: 'Bearer k' }, 'rid-2', testLogger, env, 'g', 'gemini-generatecontent',
    );

    assert.deepEqual(capturedBody.contents[0].parts, [
      { text: 'look' },
      { inline_data: { mime_type: 'image/png', data: 'ABC' } },
    ]);
  });

  it('streaming: emits OpenAI chat.completion.chunk SSE with [DONE] terminator', async () => {
    let capturedUrl = '';
    globalThis.fetch = (async (url: any) => {
      capturedUrl = String(url);
      return geminiStreamResponse(['hel', 'lo']);
    }) as typeof fetch;

    const req = makeRequest({
      model: 'g', messages: [{ role: 'user', content: 'hi' }],
    }, true);
    const res = await handleChatCompletionsPassthrough(
      req, 'https://upstream/v1beta/models/g:generateContent',
      { Authorization: 'Bearer k' }, 'rid-3', testLogger, env, 'g', 'gemini-generatecontent',
    );

    assert.match(capturedUrl, /:streamGenerateContent/);
    assert.match(capturedUrl, /alt=sse/);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');

    const text = await res.text();
    const chunks = text.split('\n\n').filter(s => s.startsWith('data: ')).map(s => s.slice(6));
    const parsed = chunks.filter(s => s !== '[DONE]').map(s => JSON.parse(s));
    const contents = parsed.map((c: any) => c.choices[0]?.delta?.content).filter(Boolean);
    assert.equal(contents.join(''), 'hello');
    // Final chunk carries a finish_reason; then [DONE].
    const lastChunk = parsed[parsed.length - 1];
    assert.equal(lastChunk.choices[0].finish_reason, 'stop');
    assert.equal(chunks[chunks.length - 1], '[DONE]');
  });

  it('propagates upstream error status unchanged', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'bad' } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      })
    ) as typeof fetch;

    const req = makeRequest({
      model: 'g', messages: [{ role: 'user', content: 'hi' }],
    });
    const res = await handleChatCompletionsPassthrough(
      req, 'https://upstream/v1beta/models/g:generateContent',
      { Authorization: 'Bearer k' }, 'rid-4', testLogger, env, 'g', 'gemini-generatecontent',
    );
    assert.equal(res.status, 400);
  });
});
