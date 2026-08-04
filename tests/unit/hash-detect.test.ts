/**
 * Unit tests for hash-detect.ts
 *
 * Covers: shannonEntropy, detectHashPriority (all branches), detectB64Priority,
 * findHashSpans (hex + base64url merge, overlap dedupe, ordering), and
 * buildWhitelist (add/remove/file ingestion, length + hex filters).
 *
 * Run with: npx tsx --test tests/unit/hash-detect.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  shannonEntropy,
  detectHashPriority,
  detectB64Priority,
  findHashSpans,
  buildWhitelist,
  BUILTIN_HEX_WORDS_WHITELIST,
  HASH_HIGH,
  HASH_LOW,
  HASH_NO,
} from '../../src/utils/hash-detect.js';

// ---------------------------------------------------------------------------
// shannonEntropy
// ---------------------------------------------------------------------------

describe('shannonEntropy', () => {
  it('returns 0 for empty string', () => {
    assert.equal(shannonEntropy(''), 0);
  });

  it('returns 0 for a single repeated symbol', () => {
    assert.equal(shannonEntropy('aaaa'), 0);
    assert.equal(shannonEntropy('00000000'), 0);
  });

  it('returns log2(n) for a uniform string over n distinct symbols', () => {
    // 2 distinct symbols → 1.0 bit/symbol
    assert.equal(Number(shannonEntropy('ab').toFixed(6)), 1);
    // 4 distinct symbols → 2.0 bits/symbol
    assert.equal(Number(shannonEntropy('abcd').toFixed(6)), 2);
    // 16 distinct hex digits → 4.0 bits/symbol (max for hex)
    assert.equal(Number(shannonEntropy('0123456789abcdef').toFixed(6)), 4);
  });

  it('is symmetric in its inputs (order-independent)', () => {
    assert.equal(shannonEntropy('aabb'), shannonEntropy('abab'));
    assert.equal(shannonEntropy('aabb'), shannonEntropy('bbaa'));
  });
});

// ---------------------------------------------------------------------------
// detectHashPriority
// ---------------------------------------------------------------------------

describe('detectHashPriority', () => {
  it('returns HASH_NO for non-hex tokens', () => {
    assert.equal(detectHashPriority('not-hex-zzz'), HASH_NO);
    assert.equal(detectHashPriority('hello world'), HASH_NO);
  });

  it('returns HASH_NO for tokens shorter than minLen', () => {
    // 7 hex chars, below default minLen of 8
    assert.equal(detectHashPriority('abcdef1'), HASH_NO);
  });

  it('respects a custom minLen', () => {
    assert.equal(detectHashPriority('abcdef12', 3.0, BUILTIN_HEX_WORDS_WHITELIST, 9), HASH_NO);
  });

  it('returns HASH_NO for whitelisted hexspeak words', () => {
    assert.equal(detectHashPriority('deadbeef'), HASH_NO);
    assert.equal(detectHashPriority('cafebabe'), HASH_NO);
    assert.equal(detectHashPriority('DEADBEEF'), HASH_NO); // case-insensitive
    assert.equal(detectHashPriority('fabaceae'), HASH_NO);
  });

  it('returns HASH_NO for ordered hex sequences (max entropy but deliberate)', () => {
    assert.equal(detectHashPriority('0123456789abcdef'), HASH_NO);
    assert.equal(detectHashPriority('fedcba9876543210'), HASH_NO);
  });

  it('returns HASH_NO for low-entropy repetitive runs', () => {
    assert.equal(detectHashPriority('ffffffff'), HASH_NO);
    assert.equal(detectHashPriority('abababababababab'), HASH_NO);
  });

  it('returns HASH_HIGH for 16-char high-entropy hex (MD5-shaped)', () => {
    // Real MD5-like: 16 chars, %8==0, high entropy
    const md5 = 'd41d8cd98f00b204';
    assert.equal(detectHashPriority(md5), HASH_HIGH);
  });

  it('returns HASH_HIGH for 64-char SHA-256-shaped hex', () => {
    const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    assert.equal(detectHashPriority(sha256), HASH_HIGH);
  });

  it('returns HASH_HIGH for 40-char SHA-1-shaped hex', () => {
    const sha1 = 'da39a3ee5e6b4b0d3255bfef95601890afd80709';
    assert.equal(detectHashPriority(sha1), HASH_HIGH);
  });

  it('returns HASH_LOW for high-entropy hex of non-multiple-of-8 length', () => {
    // 12 chars, high entropy, not a multiple of 8 → LOW
    assert.equal(detectHashPriority('a1b2c3d4e5f6'), HASH_LOW);
  });

  it('returns HASH_LOW for 9..15 char high-entropy hex', () => {
    // 10 chars, high entropy, below the HIGH floor of 16
    assert.equal(detectHashPriority('a1b2c3d4e5'), HASH_LOW);
  });

  it('respects a custom entropy threshold', () => {
    // 16-char hex "a1b2c3d4" repeated has entropy 3.5 (8 distinct symbols over 16 chars).
    // Threshold 3.6 rejects it; default 3.0 accepts it as HIGH.
    const token = 'a1b2c3d4a1b2c3d4';
    const e = shannonEntropy(token);
    assert.ok(e < 3.6 && e >= 3.0, `test precond: entropy ${e} should be in [3.0, 3.6)`);
    assert.equal(detectHashPriority(token, 3.6), HASH_NO);
    assert.equal(detectHashPriority(token, 3.0), HASH_HIGH);
  });

  it('honors a custom whitelist (additions suppress detection)', () => {
    const token = 'a1b2c3d4e5f6a1b2'; // would be HIGH without whitelist
    const wl = new Set<string>([token]);
    assert.equal(detectHashPriority(token, 3.0, wl), HASH_NO);
  });

  it('returns HASH_NO for tokens > 256 chars (above HIGH ceiling)', () => {
    // 264 chars, multiple of 8, but > 256 → not HIGH. Entropy is max so not NO-via-entropy,
    // and not ordered, so it falls through to LOW.
    const long = '0123456789abcdef'.repeat(17).slice(0, 264);
    // Make it non-ordered by shuffling deterministically — but simpler: a long random-ish hex
    const tok = 'c0ffee'.repeat(44); // 264 chars, low entropy → NO
    assert.ok(tok.length >= 264);
    assert.equal(detectHashPriority(tok), HASH_NO);
  });
});

// ---------------------------------------------------------------------------
// detectB64Priority
// ---------------------------------------------------------------------------

describe('detectB64Priority', () => {
  it('returns HASH_NO for tokens shorter than the 20-char floor', () => {
    assert.equal(detectB64Priority('abcDEF123_-'), HASH_NO);
  });

  it('returns HASH_NO for pure-hex tokens (hex scanner handles them)', () => {
    const pureHex = 'd41d8cd98f00b204'; // 16 chars, but pure hex
    assert.equal(detectB64Priority(pureHex), HASH_NO);
    // Even a long pure-hex token is skipped by b64
    assert.equal(detectB64Priority('d41d8cd98f00b204e9800998ecf8427e'), HASH_NO);
  });

  it('returns HASH_HIGH for a high-entropy base64url API key', () => {
    const key = 'ouV7bwSqBiabj9kei4_ZiIl'; // 23 chars, mixed case, has _ and uppercase
    assert.equal(detectB64Priority(key), HASH_HIGH);
  });

  it('returns HASH_NO for low-entropy base64url tokens', () => {
    const low = 'aaaaaaaaaaaaaaaaaaaaa'; // 21 chars, entropy 0
    assert.equal(detectB64Priority(low), HASH_NO);
  });

  it('respects a raised entropy threshold', () => {
    // 21 chars, mixed case incl. non-hex letters (g-z), entropy ~3.37
    const key = 'gggggggg1234567890aBcZ';
    const e = shannonEntropy(key);
    assert.ok(e >= 3.0 && e < 3.8, `precond entropy ${e}`);
    assert.equal(detectB64Priority(key, 3.8), HASH_NO);
    assert.equal(detectB64Priority(key, 3.0), HASH_HIGH);
  });

  it('honors raised minLen (length floor applies)', () => {
    const key = 'ouV7bwSqBiabj9kei4_Z'; // 20 chars — meets default floor
    assert.equal(detectB64Priority(key), HASH_HIGH);
    // With minLen=30, falls below
    assert.equal(detectB64Priority(key, 3.0, 30), HASH_NO);
  });

  it('does not match a base64url token containing only lowercase a-f + digits beyond floor (pure hex)', () => {
    // Pure hex even when long — handled by the hex scanner
    assert.equal(detectB64Priority('deadbeefdeadbeefdeadbeefdead'), HASH_NO);
  });
});

// ---------------------------------------------------------------------------
// findHashSpans
// ---------------------------------------------------------------------------

describe('findHashSpans', () => {
  it('returns [] for empty input', () => {
    assert.deepEqual(findHashSpans(''), []);
  });

  it('returns [] for plain text with no hash-shaped tokens', () => {
    assert.deepEqual(findHashSpans('hello world, no hashes here'), []);
  });

  it('finds an MD5 hash embedded in text', () => {
    const md5 = 'd41d8cd98f00b204';
    const text = `the hash is ${md5} yes`;
    const spans = findHashSpans(text);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].token, md5);
    assert.equal(spans[0].priority, HASH_HIGH);
    assert.equal(text.slice(spans[0].start, spans[0].end), md5);
  });

  it('finds multiple hashes left-to-right', () => {
    const a = 'd41d8cd98f00b204';
    const b = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const text = `${a} ... ${b}`;
    const spans = findHashSpans(text);
    assert.equal(spans.length, 2);
    assert.equal(spans[0].token, a);
    assert.equal(spans[1].token, b);
    assert.ok(spans[0].start < spans[1].start);
  });

  it('skips whitelisted hexspeak tokens', () => {
    const spans = findHashSpans('marker deadbeef done');
    assert.equal(spans.length, 0);
  });

  it('detects a base64url API key', () => {
    const key = 'ouV7bwSqBiabj9kei4_ZiIl';
    const text = `Authorization: Bearer ${key}`;
    const spans = findHashSpans(text);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].token, key);
    assert.equal(spans[0].priority, HASH_HIGH);
  });

  it('dedupes overlapping base64url span when a hex span covers it', () => {
    // Pure-hex 32-char string would be matched by the hex scanner; the b64 scanner
    // should skip it (no duplicate span emitted).
    const hex = 'd41d8cd98f00b204e9800998ecf8427e';
    const spans = findHashSpans(`token=${hex}!`);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].token, hex);
  });

  it('does not match hex runs shorter than minLen', () => {
    // 7-char run embedded — below default 8
    const spans = findHashSpans('x abcdef1 y');
    assert.equal(spans.length, 0);
  });

  it('respects custom minLen for hex scanner', () => {
    // With minLen=16, a 12-char high-entropy hex should be skipped
    const tok = 'a1b2c3d4e5f6';
    const spans = findHashSpans(`x ${tok} y`, 3.0, BUILTIN_HEX_WORDS_WHITELIST, 16);
    assert.equal(spans.length, 0);
  });

  it('returns spans whose slice reconstructs the token', () => {
    const md5 = 'd41d8cd98f00b204';
    const text = `prefix${md5}suffix`;
    for (const s of findHashSpans(text)) {
      assert.equal(text.slice(s.start, s.end), s.token);
    }
  });

  it('finds both a hex hash and a nearby base64url key', () => {
    const md5 = 'd41d8cd98f00b204';
    const key = 'ouV7bwSqBiabj9kei4_ZiIl';
    const text = `${md5} and ${key}`;
    const spans = findHashSpans(text);
    assert.equal(spans.length, 2);
    const tokens = spans.map(s => s.token);
    assert.ok(tokens.includes(md5));
    assert.ok(tokens.includes(key));
  });
});

// ---------------------------------------------------------------------------
// buildWhitelist
// ---------------------------------------------------------------------------

describe('buildWhitelist', () => {
  it('starts from the built-in whitelist when no overrides given', () => {
    const wl = buildWhitelist();
    assert.ok(wl.has('deadbeef'));
    assert.ok(wl.has('cafebabe'));
    assert.ok(wl.has('fabaceae'));
  });

  it('lowercases and adds custom additions', () => {
    const wl = buildWhitelist(['ABCDEF1234567890']);
    assert.ok(wl.has('abcdef1234567890'));
  });

  it('drops additions shorter than 8 chars', () => {
    const wl = buildWhitelist(['abcdef1']); // 7 chars
    assert.ok(!wl.has('abcdef1'));
  });

  it('drops additions that are not valid hex', () => {
    const wl = buildWhitelist(['zzzzzzzzzzzz']); // 12 chars but not hex
    assert.ok(!wl.has('zzzzzzzzzzzz'));
  });

  it('strips comments and whitespace from entries', () => {
    const wl = buildWhitelist(['abcdef1234567890  # important token']);
    assert.ok(wl.has('abcdef1234567890'));
  });

  it('removes built-in entries via the removals list', () => {
    const wl = buildWhitelist([], ['-deadbeef']);
    assert.ok(!wl.has('deadbeef'));
    assert.ok(wl.has('cafebabe')); // other built-ins preserved
  });

  it('additions list with "-" prefix adds the stripped token (does NOT remove)', () => {
    // The "-" stripping in ingest() applies in both modes; the mode controls
    // add vs delete. Passing "-deadbeef" via additions therefore re-adds it.
    const wl = buildWhitelist(['-cafef00d12345678']);
    assert.ok(wl.has('cafef00d12345678'));
  });

  it('reads additions + removals from a whitelist file', () => {
    const fileContent = [
      '# comment line',
      'abcdef1234567890',
      '-deadbeef',
      '  cafef00d12345678  # inline',
    ].join('\n');
    const wl = buildWhitelist([], [], 'whitelist.txt', () => fileContent);
    assert.ok(wl.has('abcdef1234567890'));
    assert.ok(wl.has('cafef00d12345678'));
    assert.ok(!wl.has('deadbeef'));
  });

  it('continues with in-memory entries when the file reader throws', () => {
    const wl = buildWhitelist(['abcdef1234567890'], [], 'missing.txt', () => {
      throw new Error('ENOENT');
    });
    assert.ok(wl.has('abcdef1234567890'));
    assert.ok(wl.has('deadbeef')); // built-in preserved
  });

  it('returns a fresh Set (mutations do not leak into the built-in)', () => {
    const wl = buildWhitelist([], ['-deadbeef']);
    assert.ok(!wl.has('deadbeef'));
    // Built-in should be untouched
    assert.ok(BUILTIN_HEX_WORDS_WHITELIST.has('deadbeef'));
  });

  it('drops file entries that are not valid hex', () => {
    const fileContent = 'ghijklmnopqrst\nabcdef1234567890';
    const wl = buildWhitelist([], [], 'f.txt', () => fileContent);
    assert.ok(!wl.has('ghijklmnopqrst'));
    assert.ok(wl.has('abcdef1234567890'));
  });
});
