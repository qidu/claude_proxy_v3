import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { convertCompletionsToResponses, convertCompletionsToCompactedResponse } from '../../src/converters/completions-to-responses.js';
import { convertResponsesToChatCompletions, convertInputItemsToMessages } from '../../src/converters/responses-to-completions.js';
import type { OpenAIResponse } from '../../src/types/openai.js';

/**
 * Round-trip tests for the completions <-> responses converters.
 * These converters had only indirect HTTP coverage through testcases/11_responses.
 */

function baseCompletion(overrides: Partial<OpenAIResponse> = {}): OpenAIResponse {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'hello world' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

// ─── completions → responses ───────────────────────────────────────────────

describe('convertCompletionsToResponses', () => {
  it('converts a basic text completion into a responses-format response', () => {
    const out = convertCompletionsToResponses(baseCompletion(), 'gpt-4o');

    assert.ok(out.id.startsWith('resp_'), 'id must have resp_ prefix');
    assert.equal(out.object, 'response');
    assert.equal(out.status, 'completed');
    assert.equal(out.model, 'gpt-4o');
    assert.equal(out.output_text, 'hello world');

    const msgItem = out.output.find(o => o.type === 'message');
    assert.ok(msgItem, 'must have a message output item');
    assert.equal(msgItem!.role, 'assistant');
    assert.equal(msgItem!.content![0].type, 'output_text');
    assert.equal(msgItem!.content![0].text, 'hello world');
  });

  it('maps usage fields correctly', () => {
    const out = convertCompletionsToResponses(baseCompletion(), 'gpt-4o');

    assert.deepEqual(out.usage, {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
    });
  });

  it('converts tool_calls into function_call output items', () => {
    const out = convertCompletionsToResponses(
      baseCompletion({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null as unknown as string,
              tool_calls: [
                { id: 'tc_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
      'gpt-4o',
    );

    const fnItem = out.output.find(o => o.type === 'function_call');
    assert.ok(fnItem, 'must have a function_call output item');
    assert.equal(fnItem!.name, 'search');
    assert.equal(fnItem!.arguments, '{"q":"x"}');
    assert.equal(fnItem!.call_id, 'tc_1');
  });

  it('emits a reasoning output item from reasoning_content', () => {
    const out = convertCompletionsToResponses(
      baseCompletion({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'answer',
              reasoning_content: 'thinking...',
            } as any,
            finish_reason: 'stop',
          },
        ],
      }),
      'model',
    );

    const reasoningItem = out.output.find(o => o.type === 'reasoning') as any;
    assert.ok(reasoningItem, 'must emit a reasoning output item');
    assert.equal(reasoningItem.content[0].type, 'reasoning_text');
    assert.equal(reasoningItem.content[0].text, 'thinking...');
  });

  it('strips <thinking> tags from content and emits a reasoning item', () => {
    const out = convertCompletionsToResponses(
      baseCompletion({
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '<thinking>hmm</thinking>final' },
            finish_reason: 'stop',
          },
        ],
      }),
      'model',
    );

    assert.equal(out.output_text, 'final');
    const reasoningItem = out.output.find(o => o.type === 'reasoning') as any;
    assert.ok(reasoningItem);
    assert.equal(reasoningItem.content[0].text, 'hmm');
  });

  it('returns a fallback message item when choices is empty', () => {
    const out = convertCompletionsToResponses(
      baseCompletion({ choices: [] }),
      'model',
    );

    assert.equal(out.output.length, 1);
    assert.equal(out.output[0].type, 'message');
    assert.equal(out.output[0].content![0].text, '');
  });
});

describe('convertCompletionsToCompactedResponse', () => {
  it('returns object: response.compaction', () => {
    const out = convertCompletionsToCompactedResponse(baseCompletion(), 'gpt-4o');
    assert.equal(out.object, 'response.compaction');
    assert.ok(out.output.length > 0);
  });
});

// ─── responses → completions ───────────────────────────────────────────────

describe('convertResponsesToChatCompletions', () => {
  it('converts a simple string input to a user message', () => {
    const out = convertResponsesToChatCompletions(
      { model: 'gpt-4o', input: 'hello' },
      'gpt-4o',
    );

    assert.equal(out.model, 'gpt-4o');
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].role, 'user');
    assert.equal(out.messages[0].content, 'hello');
  });

  it('maps instructions to a system message prepended before input', () => {
    const out = convertResponsesToChatCompletions(
      { instructions: 'be concise', input: 'hi' },
      'model',
    );

    assert.equal(out.messages[0].role, 'system');
    assert.equal(out.messages[0].content, 'be concise');
    assert.equal(out.messages[1].role, 'user');
  });

  it('copies optional parameters (temperature, max_output_tokens, top_p, stop)', () => {
    const out = convertResponsesToChatCompletions(
      { input: 'hi', temperature: 0.5, max_output_tokens: 100, top_p: 0.9, stop: ['END'] },
      'model',
    );

    assert.equal(out.temperature, 0.5);
    assert.equal(out.max_tokens, 100);
    assert.equal(out.top_p, 0.9);
    assert.deepEqual(out.stop, ['END']);
  });

  it('converts flat responses-API tool format to nested completions format', () => {
    const out = convertResponsesToChatCompletions(
      {
        input: 'hi',
        tools: [
          { type: 'function', name: 'search', description: 'Search', parameters: { type: 'object' } },
        ],
      },
      'model',
    );

    assert.equal(out.tools!.length, 1);
    assert.equal(out.tools![0].type, 'function');
    assert.equal((out.tools![0] as any).function.name, 'search');
    assert.equal((out.tools![0] as any).function.description, 'Search');
  });

  it('drops non-function tools', () => {
    const out = convertResponsesToChatCompletions(
      {
        input: 'hi',
        tools: [
          { type: 'web_search_preview' },
          { type: 'function', name: 'fn', parameters: {} },
        ],
      },
      'model',
    );

    assert.equal(out.tools!.length, 1);
  });

  it('maps tool_choice { type: "function", name: "fn" } to nested format', () => {
    const out = convertResponsesToChatCompletions(
      { input: 'hi', tool_choice: { type: 'function', name: 'fn' } },
      'model',
    );

    assert.deepEqual(out.tool_choice, { type: 'function', function: { name: 'fn' } });
  });

  it('passes through string tool_choice (auto, none, required)', () => {
    const out = convertResponsesToChatCompletions(
      { input: 'hi', tool_choice: 'required' },
      'model',
    );

    assert.equal(out.tool_choice, 'required');
  });

  it('copies thinking and reasoning_effort', () => {
    const out = convertResponsesToChatCompletions(
      { input: 'hi', thinking: { enabled: true, budget_tokens: 1024 }, reasoning_effort: 'high' },
      'model',
    );

    assert.deepEqual(out.thinking, { enabled: true, budget_tokens: 1024 });
    assert.equal(out.reasoning_effort, 'high');
  });
});

// ─── convertInputItemsToMessages ───────────────────────────────────────────

describe('convertInputItemsToMessages', () => {
  it('converts function_call and function_call_output items', () => {
    const msgs = convertInputItemsToMessages([
      { type: 'function_call', call_id: 'c1', name: 'search', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'result' },
    ]);

    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'assistant');
    assert.ok(msgs[0].tool_calls);
    assert.equal(msgs[0].tool_calls![0].id, 'c1');
    assert.equal(msgs[0].tool_calls![0].function.name, 'search');
    assert.equal(msgs[1].role, 'tool');
    assert.equal(msgs[1].content, 'result');
    assert.equal(msgs[1].tool_call_id, 'c1');
  });

  it('attaches pending reasoning_content to the next assistant turn', () => {
    const msgs = convertInputItemsToMessages([
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'deep thought' }] },
      { type: 'message', role: 'assistant', content: 'answer' },
    ]);

    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'assistant');
    assert.equal((msgs[0] as any).reasoning_content, 'deep thought');
    assert.equal(msgs[0].content, 'answer');
  });

  it('merges consecutive function_call and assistant message items into one assistant message', () => {
    const msgs = convertInputItemsToMessages([
      { type: 'function_call', call_id: 'c1', name: 'fn1', arguments: '{}' },
      { type: 'message', role: 'assistant', content: 'text' },
    ]);

    assert.equal(msgs.length, 1, 'must merge into a single assistant message');
    assert.ok(msgs[0].tool_calls);
    assert.equal(msgs[0].tool_calls!.length, 1);
    // The text from the assistant message is merged in
    assert.equal(msgs[0].content, 'text');
  });

  it('converts a user message item', () => {
    const msgs = convertInputItemsToMessages([
      { type: 'message', role: 'user', content: 'hello' },
    ]);

    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'user');
    assert.equal(msgs[0].content, 'hello');
  });

  it('maps developer role to system', () => {
    const msgs = convertInputItemsToMessages([
      { type: 'message', role: 'developer', content: 'instructions' },
    ]);

    assert.equal(msgs[0].role, 'system');
  });
});
