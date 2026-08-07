import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { convertCompletionsToGeminiGenerateContentBody } from '../../src/converters/claude-to-gemini.js';

/**
 * Coverage for the OpenAI Chat Completions -> Gemini generateContent request
 * converter. Verifies text/image/system/tool mapping and the data-URI decode
 * path. http(s) fetch is exercised in Phase 3.
 */
describe('convertCompletionsToGeminiGenerateContentBody', () => {
  it('maps a string user message to a user content part', async () => {
    const out = await convertCompletionsToGeminiGenerateContentBody(
      { model: 'g', messages: [{ role: 'user', content: 'hi' }] },
      'g',
    );
    assert.deepEqual(out.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
  });

  it('lifts a system message to systemInstruction', async () => {
    const out = await convertCompletionsToGeminiGenerateContentBody(
      { model: 'g', messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }] },
      'g',
    );
    assert.deepEqual(out.systemInstruction, { parts: [{ text: 'be terse' }] });
    assert.equal(out.contents.length, 1);
    assert.equal(out.contents[0].role, 'user');
  });

  it('converts image_url (data URI) to inline_data', async () => {
    const out = await convertCompletionsToGeminiGenerateContentBody(
      {
        model: 'g',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,ABC' } },
          ],
        }],
      },
      'g',
    );
    assert.deepEqual(out.contents[0].parts, [
      { text: 'look' },
      { inline_data: { mime_type: 'image/png', data: 'ABC' } },
    ]);
  });

  it('rejects http image URLs pointing at loopback/private hosts (SSRF guard)', async () => {
    await assert.rejects(
      () => convertCompletionsToGeminiGenerateContentBody(
        {
          model: 'g',
          messages: [{
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'http://127.0.0.1/i.png' } }],
          }],
        },
        'g',
      ),
      (err: Error) => /blocked|private|loopback/i.test(err.message),
    );
  });

  it('converts assistant tool_calls to functionCall parts', async () => {
    const out = await convertCompletionsToGeminiGenerateContentBody(
      {
        model: 'g',
        messages: [{
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1', type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"sf"}' },
          }],
        }],
      },
      'g',
    );
    assert.equal(out.contents[0].role, 'model');
    assert.deepEqual(out.contents[0].parts, [{
      functionCall: { name: 'get_weather', args: { city: 'sf' } },
    }]);
  });

  it('converts role:tool messages to functionResponse parts', async () => {
    const out = await convertCompletionsToGeminiGenerateContentBody(
      {
        model: 'g',
        messages: [{
          role: 'tool', tool_call_id: 'call_1', name: 'get_weather', content: 'sunny',
        }],
      },
      'g',
    );
    assert.deepEqual(out.contents[0].parts, [{
      functionResponse: { name: 'get_weather', response: { content: 'sunny' } },
    }]);
  });

  it('maps generation params into generationConfig', async () => {
    const out = await convertCompletionsToGeminiGenerateContentBody(
      { model: 'g', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100, temperature: 0.5, top_p: 0.9, stop: ['x'] },
      'g',
    );
    assert.deepEqual(out.generationConfig, {
      max_output_tokens: 100, temperature: 0.5, top_p: 0.9, stopSequences: ['x'],
    });
  });

  it('converts OpenAI tools[] to tools[].functionDeclarations[]', async () => {
    const out = await convertCompletionsToGeminiGenerateContentBody(
      {
        model: 'g',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{
          type: 'function',
          function: { name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: {} } },
        }],
      },
      'g',
    );
    assert.deepEqual(out.tools, [{
      functionDeclarations: [{
        name: 'get_weather', description: 'weather',
        parameters: { type: 'object', properties: {} },
      }],
    }]);
  });
});
