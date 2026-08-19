/**
 * Unit tests for converters/streaming.ts (OpenAI SSE -> Claude SSE).
 *
 * Drives createStreamTransformer through a real TransformStream, feeding OpenAI
 * chat.completions delta chunks and asserting on the emitted Claude event
 * sequence: message_start, content_block_start/delta/stop, tool_use blocks,
 * reasoning_content thinking blocks (with synthetic signature), stop_reason
 * mapping, upstream usage capture, and the unexpected-end flush path.
 *
 * Run with: npx tsx --test tests/unit/streaming.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createStreamTransformer } from '../../src/converters/streaming.js';
import { SYNTHETIC_THINKING_SIGNATURE } from '../../src/converters/openai-to-claude.js';

interface ClaudeEvent { event: string; data: any; }

/** Feed OpenAI SSE lines through the transformer and collect parsed Claude events. */
async function runTransformer(sseLines: string[], opts?: {
  requestId?: string;
  includeThinking?: boolean;
  flushInsteadOfDone?: boolean;
}): Promise<ClaudeEvent[]> {
  const transformer = createStreamTransformer(
    'model-a',
    opts?.requestId ?? 'req-1',
    undefined,
    undefined,
    opts?.includeThinking ?? false,
  );
  const stream = new TransformStream<Uint8Array, Uint8Array>(transformer as any);
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  let raw = '';
  const readAll = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
    }
  })();

  // The transformer calls controller.terminate() on [DONE], which closes the
  // writable side out from under us. Swallow the resulting "already closed"
  // errors on write/close — the readable side still drains every event.
  try {
    for (const line of sseLines) await writer.write(enc.encode(line));
    await writer.close();
  } catch (e: any) {
    if (e?.code !== 'ERR_INVALID_STATE') throw e;
  }
  await readAll;

  return parseClaudeSse(raw);
}

function parseClaudeSse(raw: string): ClaudeEvent[] {
  const events: ClaudeEvent[] = [];
  for (const block of raw.split('\n\n')) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let event = '';
    let dataStr = '';
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) dataStr = line.slice(6);
    }
    if (dataStr) events.push({ event, data: JSON.parse(dataStr) });
  }
  return events;
}

function oa(delta: any, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({ choices: [{ delta, index: 0, finish_reason: null }], ...extra })}\n\n`;
}
function oaFinal(finishReason: string | null, usage?: any): string {
  return `data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: finishReason }], usage })}\n\n`;
}
const DONE = 'data: [DONE]\n\n';

/**
 * The transformer's stop-reason / usage extraction scans backward through the
 * lines of the SAME transform() call that carries [DONE]. A real upstream
 * flushes the final finish_reason chunk and [DONE] together, so emit them as
 * one combined write to reproduce that framing.
 */
function finalThenDone(finishReason: string | null, usage?: any): string {
  return oaFinal(finishReason, usage) + DONE;
}

// ---------------------------------------------------------------------------

describe('createStreamTransformer — lifecycle framing', () => {
  it('emits message_start + content_block_start before any delta', async () => {
    const events = await runTransformer([oa({ content: 'hi' }), DONE]);
    assert.equal(events[0].event, 'message_start');
    assert.equal(events[0].data.message.id, 'req-1');
    assert.equal(events[0].data.message.model, 'model-a');
    assert.equal(events[1].event, 'content_block_start');
    assert.equal(events[1].data.index, 0);
    assert.equal(events[1].data.content_block.type, 'text');
  });

  it('emits message_stop last and terminates on [DONE]', async () => {
    const events = await runTransformer([oa({ content: 'hi' }), DONE]);
    assert.equal(events[events.length - 1].event, 'message_stop');
  });
});

describe('createStreamTransformer — text content', () => {
  it('forwards a plain text delta as text_delta on block 0', async () => {
    const events = await runTransformer([oa({ content: 'hello' }), DONE]);
    const delta = events.find(e => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta');
    assert.ok(delta);
    assert.equal(delta!.data.index, 0);
    assert.equal(delta!.data.delta.text, 'hello');
  });

  it('maps finish_reason=stop to end_turn in message_delta', async () => {
    const events = await runTransformer([oa({ content: 'x' }), finalThenDone('stop')]);
    const md = events.find(e => e.event === 'message_delta');
    assert.equal(md!.data.delta.stop_reason, 'end_turn');
  });

  it('maps finish_reason=length to max_tokens', async () => {
    const events = await runTransformer([oa({ content: 'x' }), finalThenDone('length')]);
    const md = events.find(e => e.event === 'message_delta');
    assert.equal(md!.data.delta.stop_reason, 'max_tokens');
  });
});

describe('createStreamTransformer — tool calls', () => {
  it('opens a tool_use block once id+name are known and streams input_json_delta', async () => {
    const events = await runTransformer([
      oa({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q"' } }] }),
      oa({ tool_calls: [{ index: 0, function: { arguments: ':"cats"}' } }] }),
      finalThenDone('tool_calls'),
    ]);

    const start = events.find(e => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use');
    assert.ok(start, 'tool_use content_block_start emitted');
    assert.equal(start!.data.content_block.id, 'call_1');
    assert.equal(start!.data.content_block.name, 'search');
    assert.equal(start!.data.index, 1, 'tool block sits at index 1 after text block 0');

    const jsonDeltas = events
      .filter(e => e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta')
      .map(e => e.data.delta.partial_json)
      .join('');
    assert.equal(jsonDeltas, '{"q":"cats"}');

    const md = events.find(e => e.event === 'message_delta');
    assert.equal(md!.data.delta.stop_reason, 'tool_use');
  });

  it('forces stop_reason=tool_use when tool calls exist but finish_reason=stop', async () => {
    const events = await runTransformer([
      oa({ tool_calls: [{ index: 0, id: 'c', function: { name: 'n', arguments: '{}' } }] }),
      finalThenDone('stop'),
    ]);
    const md = events.find(e => e.event === 'message_delta');
    assert.equal(md!.data.delta.stop_reason, 'tool_use');
  });
});

describe('createStreamTransformer — reasoning / thinking', () => {
  it('emits a thinking block for reasoning_content with a synthetic signature at DONE', async () => {
    const events = await runTransformer([
      oa({ reasoning_content: 'step one ' }),
      oa({ reasoning_content: 'step two' }),
      oa({ content: 'final' }),
      finalThenDone('stop'),
    ]);

    const thinkStart = events.find(e => e.event === 'content_block_start' && e.data.content_block.type === 'thinking');
    assert.ok(thinkStart, 'thinking content_block_start emitted');

    const thinkDeltas = events
      .filter(e => e.event === 'content_block_delta' && e.data.delta.type === 'thinking_delta')
      .map(e => e.data.delta.thinking)
      .join('');
    assert.equal(thinkDeltas, 'step one step two');

    const sig = events.find(e => e.event === 'content_block_delta' && e.data.delta.type === 'signature_delta');
    assert.ok(sig, 'signature_delta emitted for thinking block');
    assert.equal(sig!.data.delta.signature, SYNTHETIC_THINKING_SIGNATURE);
  });

  it('uses an upstream signature when one is streamed', async () => {
    const events = await runTransformer([
      oa({ reasoning_content: 'r' }),
      oa({ signature: 'real-sig' }),
      oa({ content: 'a' }),
      finalThenDone('stop'),
    ]);
    const sig = events.find(e => e.event === 'content_block_delta' && e.data.delta.type === 'signature_delta');
    assert.equal(sig!.data.delta.signature, 'real-sig');
  });

  it('extracts inline <think> tags into a thinking block', async () => {
    const events = await runTransformer([
      oa({ content: '<think>hidden</think>' }),
      oa({ content: 'visible' }),
      finalThenDone('stop'),
    ], { includeThinking: true });

    const thinkDeltas = events
      .filter(e => e.event === 'content_block_delta' && e.data.delta.type === 'thinking_delta')
      .map(e => e.data.delta.thinking)
      .join('');
    assert.equal(thinkDeltas, 'hidden');

    const textDeltas = events
      .filter(e => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta')
      .map(e => e.data.delta.text)
      .join('');
    assert.equal(textDeltas, 'visible');
  });
});

describe('createStreamTransformer — usage', () => {
  it('captures upstream usage from an include_usage chunk (empty choices)', async () => {
    const usageChunk = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n`;
    const events = await runTransformer([oa({ content: 'x' }), usageChunk, finalThenDone('stop')]);
    const md = events.find(e => e.event === 'message_delta');
    assert.equal(md!.data.usage.input_tokens, 100);
    assert.equal(md!.data.usage.output_tokens, 20);
  });

  it('surfaces cache-read tokens from prompt_tokens_details.cached_tokens', async () => {
    const usageChunk = `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 30 } },
    })}\n\n`;
    const events = await runTransformer([oa({ content: 'x' }), usageChunk, finalThenDone('stop')]);
    const md = events.find(e => e.event === 'message_delta');
    assert.equal(md!.data.usage.cache_read_input_tokens, 30);
  });
});

describe('createStreamTransformer — flush on unexpected end', () => {
  it('closes open blocks and emits message_delta/message_stop when stream ends without [DONE]', async () => {
    // No DONE line: the stream closes and the flush() path must finalize.
    const events = await runTransformer([oa({ content: 'partial' })]);
    assert.equal(events[0].event, 'message_start');
    assert.ok(events.some(e => e.event === 'content_block_stop' && e.data.index === 0));
    const md = events.find(e => e.event === 'message_delta');
    assert.ok(md, 'message_delta emitted on flush');
    assert.equal(md!.data.delta.stop_reason, 'end_turn');
    assert.equal(events[events.length - 1].event, 'message_stop');
  });

  it('flush reports tool_use stop_reason when a tool call was in progress', async () => {
    const events = await runTransformer([
      oa({ tool_calls: [{ index: 0, id: 'c', function: { name: 'n', arguments: '{}' } }] }),
    ]);
    const md = events.find(e => e.event === 'message_delta');
    assert.equal(md!.data.delta.stop_reason, 'tool_use');
  });
});
