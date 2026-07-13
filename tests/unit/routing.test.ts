/**
 * Unit tests for routing helpers that can be run offline.
 *
 * Run with:
 *   npx tsx --test tests/unit/routing.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpstreamUrl } from '../../src/utils/routing.js';

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
