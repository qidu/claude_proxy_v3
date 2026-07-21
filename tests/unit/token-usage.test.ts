import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { convertClaudeToOpenAIRequest } from '../../src/converters/claude-to-openai.js';
import { createStreamTransformer } from '../../src/converters/streaming.js';
import { createGeminiStreamTransformer } from '../../src/converters/gemini-streaming.js';
import { extractTokenCounts } from '../../src/converters/openai-to-claude.js';
import { countClaudeRequestTokens } from '../../src/utils/token-counting.js';
import { handleMessagesRequest } from '../../src/handlers/messages.js';
import { createUsageTrackingTransformStream } from '../../src/utils/dashboard-stats.js';
import { buildModelUsageRecordPayload, recordModelUsageToRemote } from '../../src/utils/model-usage-recorder.js';

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

function parseSse(text: string): Array<{ event?: string; data: any }> {
  return text.trim().split('\n\n').map(message => {
    let event: string | undefined;
    let data = '';
    for (const line of message.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      if (line.startsWith('data: ')) data = line.slice(6);
    }
    return { event, data: data === '[DONE]' ? data : JSON.parse(data) };
  });
}

function sseStream(body: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
}

describe('streaming usage propagation', () => {
  it('adds stream_options.include_usage for Claude-format OpenAI streaming', () => {
    const request = convertClaudeToOpenAIRequest({
      model: 'claude-test',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    }, 'gpt-test');

    assert.deepEqual(request.stream_options, { include_usage: true });
  });

  it('adds and merges stream_options.include_usage for OpenAI passthrough streaming', async () => {
    const originalFetch = globalThis.fetch;
    let upstreamBody: any;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamBody = JSON.parse(init?.body as string);
      return new Response(sseStream([
        'data: {"choices":[{"delta":{"content":"ok"},"index":0}]}',
        '',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };

    try {
      const response = await handleMessagesRequest(
        new Request('http://localhost/v1/messages', {
          method: 'POST',
          body: JSON.stringify({
            model: 'gpt-test',
            stream: true,
            messages: [{ role: 'user', content: 'hello' }],
            stream_options: { include_usage: false },
          }),
        }),
        'https://example.com/v1/chat/completions',
        { Authorization: 'Bearer test' },
        'req-test',
      );
      await streamToText(response.body!);
      assert.deepEqual(upstreamBody.stream_options, { include_usage: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('emits OpenAI final stream usage including cached tokens', async () => {
    const input = sseStream([
      'data: {"choices":[{"delta":{"content":"hi"},"index":0}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18,"prompt_tokens_details":{"cached_tokens":4}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'));

    const output = await streamToText(input.pipeThrough(new TransformStream(createStreamTransformer('gpt-test', 'req-test'))));
    const messageDelta = parseSse(output).find(e => e.event === 'message_delta')?.data;

    assert.equal(messageDelta.usage.input_tokens, 11);
    assert.equal(messageDelta.usage.output_tokens, 7);
    assert.equal(messageDelta.usage.cache_read_input_tokens, 4);
  });

  it('emits Gemini interaction final usage', async () => {
    const input = sseStream([
      'data: {"event_type":"interaction.start","interaction":{"id":"int_1","role":"model"}}',
      '',
      'data: {"event_type":"content.start","index":0,"content":{"type":"text"}}',
      '',
      'data: {"event_type":"content.delta","index":0,"delta":{"type":"text","text":"hello"}}',
      '',
      'data: {"event_type":"content.stop","index":0}',
      '',
      'data: {"event_type":"interaction.complete","interaction":{"id":"int_1","status":"completed","object":"interaction","created":"now","updated":"now","role":"model","usage":{"total_input_tokens":13,"total_output_tokens":8,"total_cached_tokens":5,"total_tokens":26}}}',
      '',
    ].join('\n'));

    const output = await streamToText(input.pipeThrough(createGeminiStreamTransformer('gemini-test', 'req-test')));
    const messageDelta = parseSse(output).find(e => e.event === 'message_delta')?.data;

    assert.equal(messageDelta.usage.input_tokens, 13);
    assert.equal(messageDelta.usage.output_tokens, 8);
    assert.equal(messageDelta.usage.cache_read_input_tokens, 5);
  });
});

describe('remote usage recording', () => {
  it('builds payload with raw user key and all token counters', () => {
    const payload = buildModelUsageRecordPayload('req-1', '/v1/messages', 'sk-user', 'claude-test', {
      input_tokens: 11,
      cached_tokens: 3,
      cache_written_tokens: 5,
      output_tokens: 7,
      total_tokens: 26,
    });

    assert.equal(payload.request_id, 'req-1');
    assert.equal(payload.endpoint, '/v1/messages');
    assert.equal(payload.user_key, 'sk-user');
    assert.equal(payload.model, 'claude-test');
    assert.equal(payload.input_tokens, 11);
    assert.equal(payload.cached_tokens, 3);
    assert.equal(payload.cache_written_tokens, 5);
    assert.equal(payload.output_tokens, 7);
    assert.equal(payload.total_tokens, 26);
    assert.match(payload.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('posts payload only when record_url is configured', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(init?.body as string),
      });
      return new Response('{}', { status: 204 });
    }) as typeof fetch;

    try {
      const payload = buildModelUsageRecordPayload('req-2', '/v1/messages', 'sk-user', 'gpt-test', { total_tokens: 9 });
      recordModelUsageToRemote(undefined, payload);
      recordModelUsageToRemote('http://collector.test/usage', payload, undefined, 'one-time-token');
      await new Promise(resolve => setTimeout(resolve, 0));

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'http://collector.test/usage');
      assert.equal(calls[0].headers.access_token, 'one-time-token');
      assert.equal(calls[0].body.user_key, 'sk-user');
      assert.equal(calls[0].body.total_tokens, 9);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('invokes streaming usage callback with final counters', async () => {
    let captured: any;
    const input = sseStream([
      'event: message_start',
      'data: {"message":{"usage":{"input_tokens":10,"cache_read_input_tokens":4,"cache_creation_input_tokens":2}}}',
      '',
      'event: message_delta',
      'data: {"usage":{"output_tokens":6}}',
      '',
      '',
    ].join('\n'));

    await streamToText(input.pipeThrough(createUsageTrackingTransformStream('claude-test', undefined, usage => {
      captured = usage;
    })));

    assert.equal(captured.input_tokens, 10);
    assert.equal(captured.cached_tokens, 4);
    assert.equal(captured.cache_written_tokens, 2);
    assert.equal(captured.output_tokens, 6);
    assert.equal(captured.total_tokens, 22);
  });
});

describe('cache token mapping', () => {
  it('maps OpenAI Responses cached tokens to Claude cache_read_input_tokens', async () => {
    const usage = await extractTokenCounts({
      prompt_tokens: 20,
      completion_tokens: 10,
      total_tokens: 30,
      input_tokens_details: { cached_tokens: 6 },
    });

    assert.equal(usage.input_tokens, 20);
    assert.equal(usage.output_tokens, 10);
    assert.equal(usage.cache_read_input_tokens, 6);
  });
});

describe('local token counting for non-text content', () => {
  it('counts tool_result content instead of skipping it', () => {
    const base = countClaudeRequestTokens({
      model: 'claude-test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });
    const withToolResult = countClaudeRequestTokens({
      model: 'claude-test',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_result', tool_use_id: 'tool_1', content: 'the tool returned a detailed result' },
        ],
      }],
    } as any);

    assert.ok(withToolResult > base);
  });

  it('counts nested tool_result content blocks', () => {
    const count = countClaudeRequestTokens({
      model: 'claude-test',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool_1',
          content: [{ type: 'text', text: 'nested result text' }, { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }],
        }],
      }],
    } as any);

    assert.ok(count > 0);
  });
});
