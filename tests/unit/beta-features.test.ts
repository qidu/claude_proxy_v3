/**
 * Unit tests for the anthropic-beta header helpers in src/utils/beta-features.ts.
 *
 * These pure parse/validate functions had no direct unit coverage. Key behaviors
 * under test: unknown features are silently dropped (not forwarded upstream),
 * invalid JSON / non-array input returns null (never throws), and header
 * round-tripping via createBetaHeader.
 *
 * Run with: npx tsx --test tests/unit/beta-features.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  VALID_BETA_FEATURES,
  validateBetaFeatures,
  hasBetaFeature,
  createBetaHeader,
  validateBetaFeaturesForEndpoint,
} from '../../src/utils/beta-features.js';

// ---------------------------------------------------------------------------
// validateBetaFeatures
// ---------------------------------------------------------------------------

describe('validateBetaFeatures', () => {
  it('returns null for null / empty header', () => {
    assert.equal(validateBetaFeatures(null), null);
    assert.equal(validateBetaFeatures(''), null);
  });

  it('parses a JSON array of valid features', () => {
    assert.deepEqual(
      validateBetaFeatures('["prompt-caching-2024-07-31","pdfs-2024-09-25"]'),
      ['prompt-caching-2024-07-31', 'pdfs-2024-09-25'],
    );
  });

  it('silently drops unknown features, keeping only valid ones', () => {
    assert.deepEqual(
      validateBetaFeatures('["prompt-caching-2024-07-31","made-up-feature-9999"]'),
      ['prompt-caching-2024-07-31'],
    );
  });

  it('returns an empty array when all features are unknown', () => {
    assert.deepEqual(validateBetaFeatures('["nope-1","nope-2"]'), []);
  });

  it('returns an empty array for an empty JSON array', () => {
    assert.deepEqual(validateBetaFeatures('[]'), []);
  });

  it('returns null on invalid JSON (never throws)', () => {
    assert.equal(validateBetaFeatures('not-json'), null);
    assert.equal(validateBetaFeatures('{'), null);
  });

  it('returns null when JSON is valid but not an array', () => {
    assert.equal(validateBetaFeatures('"prompt-caching-2024-07-31"'), null);
    assert.equal(validateBetaFeatures('{"a":1}'), null);
    assert.equal(validateBetaFeatures('42'), null);
  });

  it('returns null when the array contains a non-string element', () => {
    // A non-string element throws internally, which is caught -> null.
    assert.equal(validateBetaFeatures('["prompt-caching-2024-07-31", 123]'), null);
  });

  it('accepts every feature in VALID_BETA_FEATURES', () => {
    const header = JSON.stringify(VALID_BETA_FEATURES);
    assert.deepEqual(validateBetaFeatures(header), [...VALID_BETA_FEATURES]);
  });
});

// ---------------------------------------------------------------------------
// hasBetaFeature
// ---------------------------------------------------------------------------

describe('hasBetaFeature', () => {
  it('true when the feature is present', () => {
    assert.equal(
      hasBetaFeature(['prompt-caching-2024-07-31', 'pdfs-2024-09-25'], 'pdfs-2024-09-25'),
      true,
    );
  });

  it('false when the feature is absent', () => {
    assert.equal(hasBetaFeature(['prompt-caching-2024-07-31'], 'pdfs-2024-09-25'), false);
  });

  it('false when the feature list is null', () => {
    assert.equal(hasBetaFeature(null, 'pdfs-2024-09-25'), false);
  });

  it('false for an empty feature list', () => {
    assert.equal(hasBetaFeature([], 'pdfs-2024-09-25'), false);
  });
});

// ---------------------------------------------------------------------------
// createBetaHeader
// ---------------------------------------------------------------------------

describe('createBetaHeader', () => {
  it('serializes features to a JSON array string', () => {
    assert.equal(
      createBetaHeader(['prompt-caching-2024-07-31', 'pdfs-2024-09-25']),
      '["prompt-caching-2024-07-31","pdfs-2024-09-25"]',
    );
  });

  it('round-trips through validateBetaFeatures', () => {
    const features = ['token-counting-2024-11-01', 'files-api-2025-04-14'] as const;
    const header = createBetaHeader([...features]);
    assert.deepEqual(validateBetaFeatures(header), [...features]);
  });

  it('serializes an empty list to "[]"', () => {
    assert.equal(createBetaHeader([]), '[]');
  });
});

// ---------------------------------------------------------------------------
// validateBetaFeaturesForEndpoint
// ---------------------------------------------------------------------------

describe('validateBetaFeaturesForEndpoint', () => {
  // Current implementation performs no throwing validation; it must never throw
  // regardless of endpoint or feature presence. These tests pin that contract.
  it('does not throw for null features', () => {
    assert.doesNotThrow(() => validateBetaFeaturesForEndpoint(null, 'v1/messages/count_tokens'));
  });

  it('does not throw for the token-counting endpoint with/without the feature', () => {
    assert.doesNotThrow(() =>
      validateBetaFeaturesForEndpoint(['token-counting-2024-11-01'], 'v1/messages/count_tokens'),
    );
    assert.doesNotThrow(() =>
      validateBetaFeaturesForEndpoint(['pdfs-2024-09-25'], 'v1/messages/count_tokens'),
    );
  });

  it('does not throw for files / skills endpoints', () => {
    assert.doesNotThrow(() => validateBetaFeaturesForEndpoint([], 'v1/files/abc'));
    assert.doesNotThrow(() => validateBetaFeaturesForEndpoint([], 'v1/skills/xyz'));
  });

  it('returns undefined (void)', () => {
    assert.equal(validateBetaFeaturesForEndpoint(null, 'v1/messages'), undefined);
  });
});
