/**
 * DEV_PASS_THROUGH Passthrough Validation Unit Tests
 *
 * When DEV_PASS_THROUGH is enabled ('true' | '1'), /v1/chat/completions is
 * forwarded as-is to the upstream openai-completions target with NO format
 * conversion (src/index.ts:922-939). The only proxy-owned logic on that path
 * is validateOpenAICompletionsRequest (src/utils/validation.ts:439), which
 * guards the forwarded body before the plain fetch() runs.
 *
 * The block path (DEV_PASS_THROUGH unset) is already covered by
 * 03_errors/validation.test.js TC311. This suite covers the *passthrough*
 * path's proxy-owned logic — the validator. Live e2e forwarding isn't tested
 * here because run-tests.js starts the proxy with DEV_PASS_THROUGH unset
 * (src/server.ts:37 default 'false') and the proxy cannot be restarted
 * mid-suite to toggle it.
 *
 * Reference:
 *   src/utils/validation.ts:439  validateOpenAICompletionsRequest (exported)
 *   src/utils/errors.ts:29       ValidationError (exported)
 *   src/index.ts:922             passthrough condition
 *   src/server.ts:37            DEV_PASS_THROUGH default
 */

const path = require('path');
const {
  assert,
  runTestSuite,
} = require('../utils/test_helpers');

let validateOpenAICompletionsRequest;

async function loadModule() {
  const mod = await import(path.join(process.cwd(), 'dist/utils/validation.js'));
  validateOpenAICompletionsRequest = mod.validateOpenAICompletionsRequest;
}

function expectThrows(fn, messageFragment) {
  let threw = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  assert(threw !== null, 'should throw');
  assert(
    threw.message.includes(messageFragment),
    `expected error containing "${messageFragment}", got: ${threw && threw.message}`
  );
}

// ---------------------------------------------------------------------------
// TC2801: valid request — does not throw
// ---------------------------------------------------------------------------

async function testValidRequestDoesNotThrow() {
  let threw = null;
  try {
    validateOpenAICompletionsRequest({
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 10,
    });
  } catch (e) {
    threw = e;
  }
  assert(threw === null, `valid request should not throw, got: ${threw && threw.message}`);
}

// ---------------------------------------------------------------------------
// TC2802–TC2806: invalid request — ValidationError with specific message
// ---------------------------------------------------------------------------

async function testMissingModelThrows() {
  expectThrows(
    () => validateOpenAICompletionsRequest({ messages: [{ role: 'user', content: 'Hi' }] }),
    'model is required and must be a string'
  );
}

async function testMissingMessagesThrows() {
  expectThrows(
    () => validateOpenAICompletionsRequest({ model: 'x' }),
    'messages is required and must be an array'
  );
}

async function testEmptyMessagesThrows() {
  expectThrows(
    () => validateOpenAICompletionsRequest({ model: 'x', messages: [] }),
    'messages array must not be empty'
  );
}

async function testInvalidRoleThrows() {
  expectThrows(
    () => validateOpenAICompletionsRequest({
      model: 'x',
      messages: [{ role: 'foo', content: 'Hi' }],
    }),
    'role must be one of'
  );
}

async function testZeroMaxTokensThrows() {
  expectThrows(
    () => validateOpenAICompletionsRequest({
      model: 'x',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 0,
    }),
    'max_tokens must be a positive number'
  );
}

module.exports = {
  testValidRequestDoesNotThrow,
  testMissingModelThrows,
  testMissingMessagesThrows,
  testEmptyMessagesThrows,
  testInvalidRoleThrows,
  testZeroMaxTokensThrows,
};

if (require.main === module) {
  loadModule().then(() =>
    runTestSuite('DEV_PASS_THROUGH Passthrough Validation', [
      { name: 'TC2801: valid request does not throw', fn: testValidRequestDoesNotThrow },
      { name: 'TC2802: missing model throws', fn: testMissingModelThrows },
      { name: 'TC2803: missing messages throws', fn: testMissingMessagesThrows },
      { name: 'TC2804: empty messages throws', fn: testEmptyMessagesThrows },
      { name: 'TC2805: invalid role throws', fn: testInvalidRoleThrows },
      { name: 'TC2806: max_tokens=0 throws', fn: testZeroMaxTokensThrows },
    ])
  );
}
