/**
 * Conversation Store Unit Tests
 * Tests src/utils/conversation-store.ts directly against
 * dist/utils/conversation-store.js — no running proxy required.
 *
 * conversation-store.ts itself has no inertness gate (unlike privacy-filter.ts
 * / kompress.ts, which are no-ops unless a *_URL env var is set) — the gate
 * lives entirely in its sole consumer, src/handlers/responses.ts, via
 * `env?.CONVERSATION_STATE === 'true' || env?.CONVERSATION_STATE === '1'`. That gated
 * behavior (previous_response_id silently dropped when CONVERSATION_STATE is
 * unset) is already covered live by 11_responses/responses_api.test.js
 * TC1906 ("stateful fields dropped"), so this file does not duplicate a live
 * end-to-end test and instead focuses entirely on the store's own logic:
 * save/get round-trip, expiry-on-read, normalizeInputToItems' four input
 * branches, and CONVERSATION_MAX_ENTRIES-driven oldest-eviction ordering.
 *
 * MAX_ENTRIES is read from process.env.CONVERSATION_MAX_ENTRIES once, at
 * module load time (`parseInt(process.env.CONVERSATION_MAX_ENTRIES ?? '10000', 10)`),
 * so the env var is set to '3' *before* the dynamic import in loadModule(),
 * and the eviction test (TC2305) runs first, before any other test's saves
 * can occupy a slot in the shared module-level store.
 *
 * Coverage:
 * - TC2301: saveConversation + getConversation round-trip (entry + fields intact)
 * - TC2302: getConversation returns undefined for an unknown key
 * - TC2303: normalizeInputToItems wraps a string as a single user-message item
 * - TC2303b: normalizeInputToItems passes an array through unchanged
 * - TC2303c: normalizeInputToItems wraps a plain object as a JSON-stringified user-message item
 * - TC2303d: normalizeInputToItems returns [] for null/undefined
 * - TC2304: saveConversation overwrites an existing key's entry (re-save, not append)
 * - TC2305: CONVERSATION_MAX_ENTRIES-driven oldest-first eviction on write
 *
 * Known gap (documented, not tested): the 1-hour CONVERSATION_TTL_MS expiry
 * path (lazy eviction in getConversation, opportunistic evictExpired() on
 * every save) is a hardcoded constant with no injectable clock or env
 * override, so it cannot be exercised in a fast unit test without patching
 * Date.now globally; verified by code reading only (src/utils/conversation-store.ts).
 *
 * Reference: src/utils/conversation-store.ts, src/handlers/responses.ts
 *            (conversation-store wiring), testcases/gaps-of-testcases-konwn.md
 */

const path = require('path');
const {
  assert,
  runTestSuite
} = require('../utils/test_helpers');

let getConversation, saveConversation, normalizeInputToItems;

async function loadModule() {
  // MAX_ENTRIES is computed once at module load, so this must be set first.
  process.env.CONVERSATION_MAX_ENTRIES = '3';
  const mod = await import(path.join(process.cwd(), 'dist/utils/conversation-store.js'));
  getConversation = mod.getConversation;
  saveConversation = mod.saveConversation;
  normalizeInputToItems = mod.normalizeInputToItems;
}

// ---------------------------------------------------------------------------
// TC2305: CONVERSATION_MAX_ENTRIES-driven oldest-first eviction
// Runs FIRST (before any other test's saves can occupy a store slot),
// exercised against a store capped at 3 entries.
// ---------------------------------------------------------------------------
async function testEvictionOldestFirst() {
  const ids = ['evict_r1', 'evict_r2', 'evict_r3', 'evict_r4', 'evict_r5'];
  for (const id of ids) {
    saveConversation(id, [{ type: 'message', role: 'user', content: id }], []);
  }

  assert(getConversation('evict_r1') === undefined, 'Oldest entry (r1) should have been evicted');
  assert(getConversation('evict_r2') === undefined, 'Second-oldest entry (r2) should have been evicted');
  assert(getConversation('evict_r3') !== undefined, 'r3 should still be present (within cap of 3)');
  assert(getConversation('evict_r4') !== undefined, 'r4 should still be present (within cap of 3)');
  assert(getConversation('evict_r5') !== undefined, 'r5 (most recent) should still be present');
}

// ---------------------------------------------------------------------------
// TC2301: save + get round-trip
// ---------------------------------------------------------------------------
async function testSaveAndGetRoundTrip() {
  const inputItems = [{ type: 'message', role: 'user', content: 'Hello' }];
  const outputItems = [{ type: 'message', role: 'assistant', content: 'Hi there' }];
  saveConversation('rt_id_1', inputItems, outputItems);

  const entry = getConversation('rt_id_1');
  assert(entry !== undefined, 'Expected entry to be found after save');
  assert(entry.inputItems === inputItems, 'Expected inputItems reference to be preserved');
  assert(entry.outputItems === outputItems, 'Expected outputItems reference to be preserved');
  assert(typeof entry.expiresAt === 'number' && entry.expiresAt > Date.now(), 'Expected a future expiresAt timestamp');
}

// ---------------------------------------------------------------------------
// TC2302: unknown key returns undefined
// ---------------------------------------------------------------------------
async function testGetUnknownKey() {
  const entry = getConversation('this_key_was_never_saved');
  assert(entry === undefined, `Expected undefined for an unknown key, got ${JSON.stringify(entry)}`);
}

// ---------------------------------------------------------------------------
// TC2303: normalizeInputToItems — string input
// ---------------------------------------------------------------------------
async function testNormalizeStringInput() {
  const result = normalizeInputToItems('Say OK');
  assert(Array.isArray(result) && result.length === 1, `Expected a single-item array, got ${JSON.stringify(result)}`);
  assert(
    result[0].type === 'message' && result[0].role === 'user' && result[0].content === 'Say OK',
    `Expected a user-message item wrapping the string, got ${JSON.stringify(result[0])}`
  );
}

// ---------------------------------------------------------------------------
// TC2303b: normalizeInputToItems — array input passthrough
// ---------------------------------------------------------------------------
async function testNormalizeArrayInput() {
  const input = [{ type: 'message', role: 'user', content: 'a' }, { type: 'message', role: 'assistant', content: 'b' }];
  const result = normalizeInputToItems(input);
  assert(result === input, 'Expected the same array reference to be returned unchanged for array input');
}

// ---------------------------------------------------------------------------
// TC2303c: normalizeInputToItems — plain object input
// ---------------------------------------------------------------------------
async function testNormalizeObjectInput() {
  const input = { foo: 'bar' };
  const result = normalizeInputToItems(input);
  assert(Array.isArray(result) && result.length === 1, `Expected a single-item array, got ${JSON.stringify(result)}`);
  assert(
    result[0].type === 'message' && result[0].role === 'user' && result[0].content === JSON.stringify(input),
    `Expected a user-message item wrapping the JSON-stringified object, got ${JSON.stringify(result[0])}`
  );
}

// ---------------------------------------------------------------------------
// TC2303d: normalizeInputToItems — null/undefined input
// ---------------------------------------------------------------------------
async function testNormalizeNullishInput() {
  const resultNull = normalizeInputToItems(null);
  assert(Array.isArray(resultNull) && resultNull.length === 0, `Expected [] for null input, got ${JSON.stringify(resultNull)}`);

  const resultUndefined = normalizeInputToItems(undefined);
  assert(Array.isArray(resultUndefined) && resultUndefined.length === 0, `Expected [] for undefined input, got ${JSON.stringify(resultUndefined)}`);
}

// ---------------------------------------------------------------------------
// TC2304: re-saving an existing key overwrites (not appends)
// ---------------------------------------------------------------------------
async function testSaveOverwritesExistingKey() {
  saveConversation('overwrite_id', [{ type: 'message', role: 'user', content: 'first' }], []);
  saveConversation('overwrite_id', [{ type: 'message', role: 'user', content: 'second' }], []);

  const entry = getConversation('overwrite_id');
  assert(entry !== undefined, 'Expected entry to be present after two saves to the same key');
  assert(entry.inputItems.length === 1, `Expected the entry to hold only the latest save's items, got ${JSON.stringify(entry.inputItems)}`);
  assert(entry.inputItems[0].content === 'second', `Expected the latest content to win, got ${JSON.stringify(entry.inputItems[0])}`);
}

module.exports = {
  testEvictionOldestFirst,
  testSaveAndGetRoundTrip,
  testGetUnknownKey,
  testNormalizeStringInput,
  testNormalizeArrayInput,
  testNormalizeObjectInput,
  testNormalizeNullishInput,
  testSaveOverwritesExistingKey
};

if (require.main === module) {
  loadModule().then(() => runTestSuite('Conversation Store Unit Tests', [
    { name: 'TC2305: eviction oldest-first (runs first, fresh store)', fn: testEvictionOldestFirst },
    { name: 'TC2301: save + get round-trip', fn: testSaveAndGetRoundTrip },
    { name: 'TC2302: unknown key returns undefined', fn: testGetUnknownKey },
    { name: 'TC2303: normalizeInputToItems string input', fn: testNormalizeStringInput },
    { name: 'TC2303b: normalizeInputToItems array input', fn: testNormalizeArrayInput },
    { name: 'TC2303c: normalizeInputToItems object input', fn: testNormalizeObjectInput },
    { name: 'TC2303d: normalizeInputToItems null/undefined input', fn: testNormalizeNullishInput },
    { name: 'TC2304: save overwrites existing key', fn: testSaveOverwritesExistingKey }
  ]));
}
