import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { stringify } from '../../src/utils/stringify.js';

/**
 * Tests for the configurable stringify utility.
 * Default (no env override) is JSON.stringify.
 */

describe('stringify', () => {
  it('stringifies a plain object identically to JSON.stringify', () => {
    const obj = { a: 1, b: 'text', c: true, d: null };
    assert.equal(stringify(obj), JSON.stringify(obj));
  });

  it('stringifies an array identically to JSON.stringify', () => {
    const arr = [1, 'two', { three: 3 }];
    assert.equal(stringify(arr), JSON.stringify(arr));
  });

  it('stringifies a primitive value identically to JSON.stringify', () => {
    assert.equal(stringify('hello'), JSON.stringify('hello'));
    assert.equal(stringify(42), JSON.stringify(42));
    assert.equal(stringify(null), JSON.stringify(null));
  });

  it('handles a deeply nested object', () => {
    const obj = { outer: { inner: { deep: { value: 'core' } } } };
    const out = JSON.parse(stringify(obj)) as typeof obj;
    assert.equal(out.outer.inner.deep.value, 'core');
  });
});
