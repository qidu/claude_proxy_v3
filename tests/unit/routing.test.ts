/**
 * Unit tests for routing helpers that can be run offline.
 *
 * Run with:
 *   npx tsx --test tests/unit/routing.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpstreamUrl } from '../../src/utils/routing.js';
import { decayEffectiveCompositeShare, getEffectiveCompositeShare, resetEffectiveCompositeSharesForTest } from '../../src/index.js';

describe('composite primary effective share decay', () => {
  it('halves primary share down to one tenth of configured share', () => {
    resetEffectiveCompositeSharesForTest();

    assert.deepEqual(decayEffectiveCompositeShare('alias', 'primary', 10), { previous: 10, next: 5, floor: 1 });
    assert.deepEqual(decayEffectiveCompositeShare('alias', 'primary', 10), { previous: 5, next: 2.5, floor: 1 });
    assert.deepEqual(decayEffectiveCompositeShare('alias', 'primary', 10), { previous: 2.5, next: 1.25, floor: 1 });
    assert.deepEqual(decayEffectiveCompositeShare('alias', 'primary', 10), { previous: 1.25, next: 1, floor: 1 });
    assert.deepEqual(decayEffectiveCompositeShare('alias', 'primary', 10), { previous: 1, next: 1, floor: 1 });
  });

  it('uses 0.1 as the floor when configured share defaults to 1', () => {
    resetEffectiveCompositeSharesForTest();

    let result = decayEffectiveCompositeShare('alias', 'primary', 1);
    assert.equal(result.next, 0.5);
    result = decayEffectiveCompositeShare('alias', 'primary', 1);
    assert.equal(result.next, 0.25);
    result = decayEffectiveCompositeShare('alias', 'primary', 1);
    assert.equal(result.next, 0.125);
    result = decayEffectiveCompositeShare('alias', 'primary', 1);
    assert.equal(result.next, 0.1);
    result = decayEffectiveCompositeShare('alias', 'primary', 1);
    assert.equal(result.next, 0.1);
  });

  it('keeps runtime state separate from configured share input', () => {
    resetEffectiveCompositeSharesForTest();
    const targetConfig = { share: 10, primary: true };

    decayEffectiveCompositeShare('alias', 'primary', targetConfig.share);

    assert.deepEqual(targetConfig, { share: 10, primary: true });
    assert.equal(getEffectiveCompositeShare('alias', 'primary', targetConfig.share), 5);
    assert.equal(getEffectiveCompositeShare('alias', 'other', targetConfig.share), 10);
  });
});

describe('composite fallback effective share decay', () => {
  it('halves fallback share down to one tenth of configured share', () => {
    resetEffectiveCompositeSharesForTest();

    assert.deepEqual(decayEffectiveCompositeShare('alias', 'fallback1', 10), { previous: 10, next: 5, floor: 1 });
    assert.deepEqual(decayEffectiveCompositeShare('alias', 'fallback1', 10), { previous: 5, next: 2.5, floor: 1 });
    assert.deepEqual(decayEffectiveCompositeShare('alias', 'fallback1', 10), { previous: 2.5, next: 1.25, floor: 1 });
    assert.deepEqual(decayEffectiveCompositeShare('alias', 'fallback1', 10), { previous: 1.25, next: 1, floor: 1 });
    assert.deepEqual(decayEffectiveCompositeShare('alias', 'fallback1', 10), { previous: 1, next: 1, floor: 1 });
  });

  it('uses 0.1 as the floor when configured share defaults to 1', () => {
    resetEffectiveCompositeSharesForTest();

    let result = decayEffectiveCompositeShare('alias', 'fallback1', 1);
    assert.equal(result.next, 0.5);
    result = decayEffectiveCompositeShare('alias', 'fallback1', 1);
    assert.equal(result.next, 0.25);
    result = decayEffectiveCompositeShare('alias', 'fallback1', 1);
    assert.equal(result.next, 0.125);
    result = decayEffectiveCompositeShare('alias', 'fallback1', 1);
    assert.equal(result.next, 0.1);
    result = decayEffectiveCompositeShare('alias', 'fallback1', 1);
    assert.equal(result.next, 0.1);
  });

  it('decays each fallback target independently', () => {
    resetEffectiveCompositeSharesForTest();

    decayEffectiveCompositeShare('alias', 'fallback1', 10);
    // fallback2 should be unaffected
    assert.equal(getEffectiveCompositeShare('alias', 'fallback2', 10), 10);
    assert.equal(getEffectiveCompositeShare('alias', 'fallback1', 10), 5);
  });

  it('does not affect primary decay state for the same alias', () => {
    resetEffectiveCompositeSharesForTest();

    decayEffectiveCompositeShare('alias', 'fallback1', 10);
    // primary target in the same alias should be unaffected
    assert.equal(getEffectiveCompositeShare('alias', 'primary-model', 10), 10);
  });

  it('keeps decay state separate across different aliases', () => {
    resetEffectiveCompositeSharesForTest();

    decayEffectiveCompositeShare('alias-a', 'fallback1', 10);
    // same target name in a different alias must not be affected
    assert.equal(getEffectiveCompositeShare('alias-b', 'fallback1', 10), 10);
    assert.equal(getEffectiveCompositeShare('alias-a', 'fallback1', 10), 5);
  });

  it('keeps runtime state separate from configured share input', () => {
    resetEffectiveCompositeSharesForTest();
    const targetConfig = { share: 10, fallback: 1 };

    decayEffectiveCompositeShare('alias', 'fallback1', targetConfig.share);

    assert.deepEqual(targetConfig, { share: 10, fallback: 1 });
    assert.equal(getEffectiveCompositeShare('alias', 'fallback1', targetConfig.share), 5);
  });
});

describe('buildUpstreamUrl', () => {
  it('appends the suffix when baseUrl is a plain host', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com', 'v1/messages'),
      'https://api.example.com/v1/messages'
    );
  });

  it('does not duplicate /v1/messages', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com/v1/messages', 'v1/messages'),
      'https://api.example.com/v1/messages'
    );
  });

  it('recognises /anthropic/messages as a full endpoint', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com/anthropic/messages', 'v1/messages'),
      'https://api.example.com/anthropic/messages'
    );
  });

  it('recognises /v1/chat/completions as a full endpoint', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com/v1/chat/completions', 'v1/chat/completions'),
      'https://api.example.com/v1/chat/completions'
    );
  });

  it('recognises /v1/interactions as a full endpoint', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com/v1/interactions', 'v1/chat/completions'),
      'https://api.example.com/v1/interactions'
    );
  });

  it('recognises /v1/responses as a full endpoint', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com/v1/responses', 'v1/responses'),
      'https://api.example.com/v1/responses'
    );
  });

  it('recognises Azure /openai/responses as a full endpoint', () => {
    assert.equal(
      buildUpstreamUrl('https://my-resource.openai.azure.com/openai/responses?api-version=2025-04-01-preview', 'v1/responses'),
      'https://my-resource.openai.azure.com/openai/responses?api-version=2025-04-01-preview'
    );
  });

  it('recognises Gemini /v1beta/models/{model}:generateContent as a full endpoint', () => {
    assert.equal(
      buildUpstreamUrl('https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent', 'v1beta/models/gemini-pro:generateContent'),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent'
    );
  });

  it('recognises Gemini /v1beta/models/{model}:streamGenerateContent as a full endpoint', () => {
    assert.equal(
      buildUpstreamUrl('https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent?alt=sse', 'v1beta/models/gemini-pro:streamGenerateContent?alt=sse'),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent?alt=sse'
    );
  });

  it('recognises Gemini /v1beta/models/{model}:countTokens as a full endpoint', () => {
    assert.equal(
      buildUpstreamUrl('https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:countTokens', 'v1beta/models/gemini-pro:countTokens'),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:countTokens'
    );
  });

  it('still appends to a bare Gemini base path without a generative action', () => {
    assert.equal(
      buildUpstreamUrl('https://generativelanguage.googleapis.com/v1beta/models', 'gemini-pro:generateContent'),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent'
    );
  });

  it('does not duplicate version for Gemini generateContent suffixes', () => {
    assert.equal(
      buildUpstreamUrl('https://generativelanguage.googleapis.com/v1beta', 'v1beta/models/gemini-pro:generateContent'),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent'
    );
  });

  it('does not duplicate version for Gemini streamGenerateContent suffixes', () => {
    assert.equal(
      buildUpstreamUrl('https://generativelanguage.googleapis.com/v1beta', 'v1beta/models/gemini-pro:streamGenerateContent?alt=sse'),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent?alt=sse'
    );
  });

  it('does not duplicate version for Gemini countTokens suffixes', () => {
    assert.equal(
      buildUpstreamUrl('https://generativelanguage.googleapis.com/v1beta', 'v1beta/models/gemini-pro:countTokens'),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:countTokens'
    );
  });

  it('keeps matching Gemini API versions when base is already versioned', () => {
    assert.equal(
      buildUpstreamUrl('https://generativelanguage.googleapis.com/v1', 'v1/models/gemini-pro:generateContent'),
      'https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent'
    );
  });

  it('collapses the suffix version to the base version when they differ', () => {
    assert.equal(
      buildUpstreamUrl('https://generativelanguage.googleapis.com/v1', 'v1beta/models/gemini-pro:generateContent'),
      'https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent'
    );
  });

  it('performs case-insensitive matching', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com/V1/Messages', 'v1/messages'),
      'https://api.example.com/V1/Messages'
    );
  });

  it('defensively avoids duplicating the exact suffix even when not a known marker', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com/v1/models', 'v1/models'),
      'https://api.example.com/v1/models'
    );
  });
});
