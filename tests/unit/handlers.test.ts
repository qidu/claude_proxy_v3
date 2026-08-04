/**
 * Unit tests for the pure transformation helpers exported from the four big
 * handlers (claude.ts, openai.ts, gemini.ts, responses.ts).
 *
 * The full request/response cycles in these handlers are exercised end-to-end
 * by ./testcases (integration). Here we cover the exported pure functions
 * that contain the testable conversion/decision logic:
 *   - openai.ts: completionsToClaudeBody, completionsToResponsesBody,
 *                claudeJsonToSyntheticCompletions
 *   - gemini.ts: isGeminiRequest
 *
 * Run with: npx tsx --test tests/unit/handlers.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  completionsToClaudeBody,
  completionsToResponsesBody,
  claudeJsonToSyntheticCompletions,
} from '../../src/handlers/openai.js';
import { isGeminiRequest } from '../../src/handlers/gemini.js';

// ---------------------------------------------------------------------------
// completionsToClaudeBody
// ---------------------------------------------------------------------------

describe('completionsToClaudeBody', () => {
  it('converts a basic user message', () => {
    const body = completionsToClaudeBody({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    }, 'claude-target');
    assert.equal(body.model, 'claude-target');
    assert.equal(body.max_tokens, 100);
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  });

  it('defaults max_tokens to 4096 when missing', () => {
    const body = completionsToClaudeBody({
      messages: [{ role: 'user', content: 'hi' }],
    } as any, 'm');
    assert.equal(body.max_tokens, 4096);
  });

  it('extracts the system message into top-level system field', () => {
    const body = completionsToClaudeBody({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'q' },
      ],
    } as any, 'm');
    assert.equal(body.system, 'be brief');
    assert.equal((body.messages as any[]).length, 1);
    assert.equal((body.messages as any[])[0].role, 'user');
  });

  it('maps tool_calls + tool results into Claude tool_use / tool_result blocks', () => {
    const body = completionsToClaudeBody({
      messages: [
        { role: 'user', content: 'do thing' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1', type: 'function',
            function: { name: 'do_thing', arguments: '{"x":1}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'result-text' },
      ],
    } as any, 'm');

    const msgs = body.messages as any[];
    // [user, assistant(tool_use), user(tool_result)]
    assert.equal(msgs.length, 3);
    assert.deepEqual(msgs[1], {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'do_thing', input: { x: 1 } }],
    });
    assert.deepEqual(msgs[2], {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'result-text' }],
    });
  });

  it('groups consecutive tool messages into a single user message', () => {
    const body = completionsToClaudeBody({
      messages: [
        {
          role: 'assistant', content: '',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
            { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'r1' },
        { role: 'tool', tool_call_id: 'c2', content: 'r2' },
      ],
    } as any, 'm');
    const msgs = body.messages as any[];
    // assistant with both tool_use blocks, then ONE user with both tool_results
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].content.length, 2);
    assert.equal(msgs[1].role, 'user');
    assert.equal(msgs[1].content.length, 2);
  });

  it('preserves reasoning_content as a thinking block on assistant turns', () => {
    const body = completionsToClaudeBody({
      messages: [{
        role: 'assistant', content: 'answer',
        reasoning_content: 'pondering',
      }],
    } as any, 'm');
    const m = (body.messages as any[])[0];
    assert.equal(m.role, 'assistant');
    assert.deepEqual(m.content, [
      { type: 'thinking', thinking: 'pondering' },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('maps OpenAI tools array to Claude tools', () => {
    const body = completionsToClaudeBody({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{
        type: 'function',
        function: { name: 'search', description: 'search the web', parameters: { type: 'object' } },
      }],
    } as any, 'm');
    assert.deepEqual(body.tools, [{
      name: 'search',
      description: 'search the web',
      input_schema: { type: 'object' },
    }]);
  });

  it('maps stop (string or array) to stop_sequences', () => {
    const a = completionsToClaudeBody({
      messages: [{ role: 'user', content: 'x' }], stop: 'END',
    } as any, 'm');
    assert.deepEqual(a.stop_sequences, ['END']);

    const b = completionsToClaudeBody({
      messages: [{ role: 'user', content: 'x' }], stop: ['A', 'B'],
    } as any, 'm');
    assert.deepEqual(b.stop_sequences, ['A', 'B']);
  });

  it('forwards temperature and top_p when present', () => {
    const body = completionsToClaudeBody({
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.5, top_p: 0.9,
    } as any, 'm');
    assert.equal(body.temperature, 0.5);
    assert.equal(body.top_p, 0.9);
  });

  it('parses tool_call arguments JSON; invalid falls back gracefully', () => {
    const body = completionsToClaudeBody({
      messages: [{
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'c1', type: 'function',
          function: { name: 'a', arguments: 'not-json' },
        }],
      }],
    } as any, 'm');
    // parseJsonObject returns {} on invalid JSON
    assert.deepEqual((body.messages as any[])[0].content[0].input, {});
  });
});

// ---------------------------------------------------------------------------
// completionsToResponsesBody
// ---------------------------------------------------------------------------

describe('completionsToResponsesBody', () => {
  it('builds a responses body with model + input + stream', () => {
    const body = completionsToResponsesBody({
      messages: [{ role: 'user', content: 'hi' }],
    } as any, 'resp-model');
    assert.equal(body.model, 'resp-model');
    assert.equal(body.stream, false);
    assert.equal((body.input as any[]).length, 1);
  });

  it('lifts system + developer messages into instructions', () => {
    const body = completionsToResponsesBody({
      messages: [
        { role: 'system', content: 'rule one' },
        { role: 'developer', content: 'rule two' },
        { role: 'user', content: 'q' },
      ],
    } as any, 'm');
    assert.equal(body.instructions, 'rule one\nrule two');
    // System/developer messages are excluded from input
    assert.equal((body.input as any[]).length, 1);
    assert.equal((body.input as any[])[0].role, 'user');
  });

  it('maps user/assistant messages to input_text/output_text respectively', () => {
    const body = completionsToResponsesBody({
      messages: [
        { role: 'user', content: 'ask' },
        { role: 'assistant', content: 'reply' },
      ],
    } as any, 'm');
    const input = body.input as any[];
    assert.equal(input[0].content[0].type, 'input_text');
    assert.equal(input[1].content[0].type, 'output_text');
  });

  it('maps assistant tool_calls to function_call items', () => {
    const body = completionsToResponsesBody({
      messages: [{
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'c1', type: 'function',
          function: { name: 'do', arguments: '{"a":1}' },
        }],
      }],
    } as any, 'm');
    const input = body.input as any[];
    assert.equal(input[0].type, 'function_call');
    assert.equal(input[0].call_id, 'c1');
    assert.equal(input[0].arguments, '{"a":1}');
  });

  it('maps tool-role messages to function_call_output', () => {
    const body = completionsToResponsesBody({
      messages: [
        { role: 'tool', tool_call_id: 'c1', content: 'result' },
      ],
    } as any, 'm');
    const input = body.input as any[];
    assert.equal(input[0].type, 'function_call_output');
    assert.equal(input[0].call_id, 'c1');
    assert.equal(input[0].output, 'result');
  });

  it('forwards temperature, top_p, max_output_tokens, prompt_cache_key', () => {
    const body = completionsToResponsesBody({
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.3, top_p: 0.8, max_tokens: 500,
      prompt_cache_key: 'cache-1',
    } as any, 'm');
    assert.equal(body.temperature, 0.3);
    assert.equal(body.top_p, 0.8);
    assert.equal(body.max_output_tokens, 500);
    assert.equal(body.prompt_cache_key, 'cache-1');
  });

  it('maps tools array to responses-style function tools', () => {
    const body = completionsToResponsesBody({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{
        type: 'function',
        function: { name: 't', description: 'd', parameters: { type: 'object' } },
      }],
    } as any, 'm');
    assert.deepEqual(body.tools, [{
      type: 'function', name: 't', description: 'd', parameters: { type: 'object' },
    }]);
  });

  it('assistant with both tool_calls and text emits function_call + message', () => {
    const body = completionsToResponsesBody({
      messages: [{
        role: 'assistant', content: 'explanation',
        tool_calls: [{
          id: 'c1', type: 'function',
          function: { name: 'do', arguments: '{}' },
        }],
      }],
    } as any, 'm');
    const input = body.input as any[];
    // function_call first, then message with output_text
    assert.equal(input.length, 2);
    assert.equal(input[0].type, 'function_call');
    assert.equal(input[1].type, 'message');
    assert.equal(input[1].content[0].type, 'output_text');
  });
});

// ---------------------------------------------------------------------------
// claudeJsonToSyntheticCompletions
// ---------------------------------------------------------------------------

describe('claudeJsonToSyntheticCompletions', () => {
  it('converts a text-only Claude response to a chat.completion', () => {
    const out = claudeJsonToSyntheticCompletions({
      id: 'msg_1',
      model: 'claude-x',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }, 'fallback-model');
    assert.equal(out.object, 'chat.completion');
    assert.equal(out.model, 'claude-x');
    const choice = (out.choices as any[])[0];
    assert.equal(choice.message.content, 'hello');
    assert.equal(choice.message.role, 'assistant');
    assert.equal(choice.finish_reason, 'stop');
    assert.deepEqual(out.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('converts tool_use blocks to tool_calls and sets finish_reason=tool_calls', () => {
    const out = claudeJsonToSyntheticCompletions({
      content: [
        { type: 'tool_use', id: 't1', name: 'search', input: { q: 'x' } },
      ],
      stop_reason: 'tool_use',
    }, 'm');
    const msg = (out.choices as any[])[0].message;
    assert.deepEqual(msg.tool_calls, [{
      id: 't1', type: 'function',
      function: { name: 'search', arguments: '{"q":"x"}' },
    }]);
    assert.equal((out.choices as any[])[0].finish_reason, 'tool_calls');
    // content null when only tool_calls + empty text
    assert.equal(msg.content, null);
  });

  it('maps stop_reason=max_tokens to finish_reason=length', () => {
    const out = claudeJsonToSyntheticCompletions({
      content: [{ type: 'text', text: 'partial' }],
      stop_reason: 'max_tokens',
    }, 'm');
    assert.equal((out.choices as any[])[0].finish_reason, 'length');
  });

  it('preserves thinking blocks as reasoning_content', () => {
    const out = claudeJsonToSyntheticCompletions({
      content: [
        { type: 'thinking', thinking: 'step 1' },
        { type: 'thinking', thinking: 'step 2' },
        { type: 'text', text: 'answer' },
      ],
    }, 'm');
    const msg = (out.choices as any[])[0].message;
    assert.equal(msg.reasoning_content, 'step 1\nstep 2');
  });

  it('falls back to the provided model when Claude response has no model field', () => {
    const out = claudeJsonToSyntheticCompletions({
      content: [{ type: 'text', text: 'x' }],
    }, 'fallback');
    assert.equal(out.model, 'fallback');
  });

  it('returns usage undefined when Claude response has no usage block', () => {
    const out = claudeJsonToSyntheticCompletions({
      content: [{ type: 'text', text: 'x' }],
    }, 'm');
    assert.equal(out.usage, undefined);
  });

  it('keeps text content alongside tool_calls (both present)', () => {
    const out = claudeJsonToSyntheticCompletions({
      content: [
        { type: 'text', text: 'calling tool' },
        { type: 'tool_use', id: 't1', name: 'f', input: {} },
      ],
    }, 'm');
    const msg = (out.choices as any[])[0].message;
    assert.equal(msg.content, 'calling tool');
    assert.ok(msg.tool_calls?.length === 1);
  });
});

// ---------------------------------------------------------------------------
// isGeminiRequest
// ---------------------------------------------------------------------------

describe('isGeminiRequest', () => {
  function req(path: string): Request {
    return new Request(`https://proxy.example${path}`);
  }

  it('returns true for /v1/interactions paths', () => {
    assert.equal(isGeminiRequest(req('/v1/interactions'), 'https://up'), true);
    assert.equal(isGeminiRequest(req('/v1/interactions?x=1'), 'https://up'), true);
  });

  it('returns true for /v1beta/interactions paths', () => {
    assert.equal(isGeminiRequest(req('/v1beta/interactions'), 'https://up'), true);
  });

  it('returns true when targetUrl contains generativelanguage.googleapis.com', () => {
    assert.equal(
      isGeminiRequest(req('/v1/messages'), 'https://generativelanguage.googleapis.com/v1beta'),
      true,
    );
  });

  it('returns true when targetUrl contains "gemini"', () => {
    assert.equal(isGeminiRequest(req('/v1/foo'), 'https://gemini-upstream.example'), true);
  });

  it('returns false for ordinary OpenAI/Claude paths and URLs', () => {
    assert.equal(isGeminiRequest(req('/v1/messages'), 'https://api.openai.com'), false);
    assert.equal(isGeminiRequest(req('/v1/chat/completions'), 'https://api.anthropic.com'), false);
  });
});
