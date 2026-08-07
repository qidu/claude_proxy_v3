import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { convertGeminiGenerateContentToOpenAI } from '../../src/handlers/openai.js';

/**
 * Coverage for image-part handling in the Gemini generateContent request ->
 * OpenAI Completions request converter. Gemini inline_data/inlineData parts
 * must become OpenAI image_url data-URI parts; text-only turns must keep
 * their string content (regression guard).
 */
describe('convertGeminiGenerateContentToOpenAI — image parts', () => {
  it('emits image_url data-URI parts for inline_data (snake_case)', () => {
    const req = {
      model: 'gemini',
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'look' },
            { inline_data: { mime_type: 'image/png', data: 'ABC' } },
          ],
        },
      ],
    };

    const out = convertGeminiGenerateContentToOpenAI(req) as any;
    const msg = out.messages[0];
    assert.equal(msg.role, 'user');
    assert.deepEqual(msg.content, [
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,ABC' } },
    ]);
  });

  it('emits image_url data-URI parts for inlineData (camelCase)', () => {
    const req = {
      model: 'gemini',
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: 'XYZ' } },
          ],
        },
      ],
    };

    const out = convertGeminiGenerateContentToOpenAI(req) as any;
    assert.deepEqual(out.messages[0].content, [
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,XYZ' } },
    ]);
  });

  it('defaults missing mime to image/jpeg', () => {
    const req = {
      model: 'gemini',
      contents: [{ role: 'user', parts: [{ inline_data: { data: 'Q' } }] }],
    };
    const out = convertGeminiGenerateContentToOpenAI(req) as any;
    assert.equal(
      out.messages[0].content[0].image_url.url,
      'data:image/jpeg;base64,Q',
    );
  });

  it('drops an image part whose data is missing rather than emitting an empty image_url', () => {
    const req = {
      model: 'gemini',
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'hi' },
            { inline_data: { mime_type: 'image/png' } }, // no data
          ],
        },
      ],
    };
    const out = convertGeminiGenerateContentToOpenAI(req) as any;
    // No image parts survived -> content stays a plain string.
    assert.equal(typeof out.messages[0].content, 'string');
    assert.equal(out.messages[0].content, 'hi');
  });

  it('keeps string content for text-only turns (regression guard)', () => {
    const req = {
      model: 'gemini',
      contents: [{ role: 'user', parts: [{ text: 'plain' }] }],
    };
    const out = convertGeminiGenerateContentToOpenAI(req) as any;
    assert.equal(out.messages[0].content, 'plain');
  });
});
