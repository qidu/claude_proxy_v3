import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { convertClaudeToGeminiRequest } from '../../src/converters/claude-to-gemini.js';
import type { ClaudeMessagesRequest } from '../../src/types/claude.js';

/**
 * Direct field-level coverage for the Claude -> Gemini generateContent request
 * converter. Only `convertClaudeToGeminiRequest` is exported from the module;
 * the remaining helpers are internal and are exercised through it.
 */

describe('convertClaudeToGeminiRequest', () => {
  it('maps a string user message to a user content part', () => {
    const req = {
      model: 'gemini',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.contents, [
      { role: 'user', parts: [{ text: 'hello' }] },
    ]);
  });

  it("maps assistant role to 'model'", () => {
    const req = {
      model: 'gemini',
      messages: [{ role: 'assistant', content: 'sure' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.equal(out.contents[0].role, 'model');
  });

  it('maps text and image blocks in array content', () => {
    const req = {
      model: 'gemini',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'ABC' },
            },
          ],
        },
      ],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.contents[0].parts, [
      { text: 'look' },
      { inline_data: { mime_type: 'image/png', data: 'ABC' } },
    ]);
  });

  it('drops messages whose content produces no parts', () => {
    const req = {
      model: 'gemini',
      messages: [
        { role: 'user', content: [{ type: 'tool_use', id: 't', name: 'n', input: {} }] },
        { role: 'user', content: 'kept' },
      ],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.equal(out.contents.length, 1, 'the tool_use-only message is skipped');
    assert.deepEqual(out.contents[0], { role: 'user', parts: [{ text: 'kept' }] });
  });

  it('emits system_instruction from a string system prompt', () => {
    const req = {
      model: 'gemini',
      system: 'be terse',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.system_instruction, { parts: [{ text: 'be terse' }] });
  });

  it('maps temperature and max_tokens into generation_config', () => {
    const req = {
      model: 'gemini',
      temperature: 0.4,
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.generation_config, {
      temperature: 0.4,
      max_output_tokens: 256,
    });
  });

  it('omits generation_config when neither temperature nor max_tokens is set', () => {
    const req = {
      model: 'gemini',
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.equal(out.generation_config, undefined);
  });

  it('passes through cached_content as cachedContent', () => {
    const req = {
      model: 'gemini',
      cached_content: 'cache-key',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.equal(out.cachedContent, 'cache-key');
  });
});
