/**
 * Privacy Filter Unit Tests
 * Tests src/utils/privacy-filter.ts directly against dist/utils/privacy-filter.js
 * — no running proxy or live PRIVACY_FILTER_URL sidecar required.
 *
 * The plugin is entirely inert unless `PRIVACY_FILTER_URL` is set (per its own
 * docstring), and no sidecar (submodules/privacy-filter/serve.py) is assumed
 * to be running in the test environment, so these tests exercise the pure
 * config-loading / path-matching / text-restoration functions directly, plus
 * the fail-open vs fail-closed behavior of redactBody() against an
 * intentionally-unreachable local port (no real sidecar required — the
 * connection failure itself is the behavior under test).
 *
 * Coverage:
 * - TC2101: getPrivacyFilterConfig returns null when PRIVACY_FILTER_URL unset (inert by default)
 * - TC2102: getPrivacyFilterConfig rejects a non-internal (public) host
 * - TC2103: getPrivacyFilterConfig accepts a localhost URL and applies documented defaults
 * - TC2104: getPrivacyFilterConfig rejects a malformed URL
 * - TC2105: getPrivacyFilterConfig rejects a non-http(s) protocol
 * - TC2106: shouldFilterPath matches configured endpoints, including the
 *           /v1beta/models/ and /v1/models/ prefix special-cases
 * - TC2107: restoreText replaces PII sentinels with original values from the mapping
 * - TC2108: restoreText leaves text without sentinels untouched
 * - TC2109: redactBody fail-open (PRIVACY_FILTER_FAIL_OPEN=true) returns the
 *           original body unmodified with an empty mapping when the sidecar
 *           is unreachable
 * - TC2110: redactBody fail-closed (default) throws when the sidecar is unreachable
 * - TC2111: redactBody is a no-op (no fetch attempted, empty mapping) for a
 *           body with no extractable text refs
 * - TC2112 (live proxy): with no PRIVACY_FILTER_URL configured in the live
 *           test environment, a normal /v1/messages request completes without
 *           any privacy-filter artifacts (sentinels) leaking into the response
 *
 * Reference: src/utils/privacy-filter.ts, src/index.ts (privacy-filter wiring),
 *            testcases/gaps-of-testcases-konwn-round-2.md gap #1
 */

const path = require('path');
const {
  sendRequest,
  assert,
  runTestSuite
} = require('../utils/test_helpers');

let getPrivacyFilterConfig, shouldFilterPath, restoreText, redactBody;

async function loadModule() {
  const mod = await import(path.join(process.cwd(), 'dist/utils/privacy-filter.js'));
  getPrivacyFilterConfig = mod.getPrivacyFilterConfig;
  shouldFilterPath = mod.shouldFilterPath;
  restoreText = mod.restoreText;
  redactBody = mod.redactBody;
}

// ---------------------------------------------------------------------------
// TC2101: Inert by default (no PRIVACY_FILTER_URL)
// ---------------------------------------------------------------------------
async function testConfigNullWhenUnset() {
  const cfg = getPrivacyFilterConfig({});
  assert(cfg === null, `Expected null when PRIVACY_FILTER_URL is unset, got ${JSON.stringify(cfg)}`);

  const cfg2 = getPrivacyFilterConfig(undefined);
  assert(cfg2 === null, `Expected null when env is undefined, got ${JSON.stringify(cfg2)}`);
}

// ---------------------------------------------------------------------------
// TC2102: Rejects non-internal host (SSRF-style guard on the sidecar URL itself)
// ---------------------------------------------------------------------------
async function testConfigRejectsExternalHost() {
  let threw = false;
  try {
    getPrivacyFilterConfig({ PRIVACY_FILTER_URL: 'http://evil.example.com:9000' });
  } catch (e) {
    threw = true;
    assert(
      /localhost or a private\/LAN address/.test(e.message),
      `Expected internal-host error, got: ${e.message}`
    );
  }
  assert(threw, 'Expected getPrivacyFilterConfig to throw for a public/external host');
}

// ---------------------------------------------------------------------------
// TC2103: Accepts localhost URL and applies documented defaults
// ---------------------------------------------------------------------------
async function testConfigAcceptsLocalhostWithDefaults() {
  const cfg = getPrivacyFilterConfig({ PRIVACY_FILTER_URL: 'http://localhost:9500/' });
  assert(cfg !== null, 'Expected non-null config for a localhost URL');
  assert(cfg.url === 'http://localhost:9500', `Expected trailing slash stripped, got ${cfg.url}`);
  assert(cfg.failOpen === false, 'Expected failOpen to default to false');
  assert(cfg.timeoutMs === 40000, `Expected default timeoutMs=40000, got ${cfg.timeoutMs}`);
  assert(cfg.maxChars === 1024000, `Expected default maxChars=1024000, got ${cfg.maxChars}`);
  assert(
    ['/v1/messages', '/v1/chat/completions', '/v1/responses', '/v1/interactions']
      .every(e => cfg.endpoints.has(e)),
    `Expected default endpoint set, got ${JSON.stringify([...cfg.endpoints])}`
  );
}

// ---------------------------------------------------------------------------
// TC2104: Rejects malformed URL
// ---------------------------------------------------------------------------
async function testConfigRejectsMalformedUrl() {
  let threw = false;
  try {
    getPrivacyFilterConfig({ PRIVACY_FILTER_URL: 'not-a-url' });
  } catch (e) {
    threw = true;
    assert(/not a valid URL/.test(e.message), `Expected URL-parse error, got: ${e.message}`);
  }
  assert(threw, 'Expected getPrivacyFilterConfig to throw for a malformed URL');
}

// ---------------------------------------------------------------------------
// TC2105: Rejects non-http(s) protocol
// ---------------------------------------------------------------------------
async function testConfigRejectsNonHttpProtocol() {
  let threw = false;
  try {
    getPrivacyFilterConfig({ PRIVACY_FILTER_URL: 'ftp://localhost:9000' });
  } catch (e) {
    threw = true;
    assert(/must use http or https/.test(e.message), `Expected protocol error, got: ${e.message}`);
  }
  assert(threw, 'Expected getPrivacyFilterConfig to throw for a non-http(s) protocol');
}

// ---------------------------------------------------------------------------
// TC2106: shouldFilterPath endpoint matching, including /v1beta/models/ and
// /v1/models/ prefix special-cases
// ---------------------------------------------------------------------------
async function testShouldFilterPathMatching() {
  const cfg = getPrivacyFilterConfig({ PRIVACY_FILTER_URL: 'http://localhost:9500' });

  assert(shouldFilterPath(cfg, '/v1/messages') === true, '/v1/messages should be filtered by default config');
  assert(shouldFilterPath(cfg, '/v1/chat/completions') === true, '/v1/chat/completions should be filtered');
  assert(shouldFilterPath(cfg, '/v1/responses') === true, '/v1/responses should be filtered');
  assert(shouldFilterPath(cfg, '/v1/interactions') === true, '/v1/interactions should be filtered');
  assert(shouldFilterPath(cfg, '/v1/embeddings') === false, '/v1/embeddings is not in the default endpoint set');
  assert(shouldFilterPath(cfg, '/dashboard/api/config') === false, 'dashboard paths should not be filtered');

  // /v1beta/models/ and /v1/models/ prefixes are special-cased against a
  // bare '/v1beta/models' / '/v1/models' endpoint entry, which is NOT in the
  // default set, so these should not match unless explicitly configured.
  assert(
    shouldFilterPath(cfg, '/v1beta/models/gemini-2.5-flash:generateContent') === false,
    'generateContent path should not match without an explicit /v1beta/models endpoint entry'
  );

  const cfgWithModels = getPrivacyFilterConfig({
    PRIVACY_FILTER_URL: 'http://localhost:9500',
    PRIVACY_FILTER_ENDPOINTS: '/v1beta/models,/v1/models'
  });
  assert(
    shouldFilterPath(cfgWithModels, '/v1beta/models/gemini-2.5-flash:generateContent') === true,
    'generateContent path should match when /v1beta/models is explicitly configured'
  );
  assert(
    shouldFilterPath(cfgWithModels, '/v1/models/some-model:generateContent') === true,
    '/v1/models/ prefix should match when /v1/models is explicitly configured'
  );
}

// ---------------------------------------------------------------------------
// TC2107: restoreText replaces sentinels with mapped originals
// ---------------------------------------------------------------------------
async function testRestoreTextReplacesSentinels() {
  const mapping = { '\u27e6PII:0\u27e7': 'John Doe', '\u27e6PII:1\u27e7': 'john@example.com' };
  const result = restoreText('Contact \u27e6PII:0\u27e7 at \u27e6PII:1\u27e7 please', mapping);
  assert(
    result === 'Contact John Doe at john@example.com please',
    `Expected sentinels replaced, got: ${result}`
  );
}

// ---------------------------------------------------------------------------
// TC2108: restoreText is a no-op when there are no sentinels
// ---------------------------------------------------------------------------
async function testRestoreTextNoSentinels() {
  const mapping = { '\u27e6PII:0\u27e7': 'John Doe' };
  const result = restoreText('nothing to restore here', mapping);
  assert(result === 'nothing to restore here', `Expected unchanged text, got: ${result}`);
}

// ---------------------------------------------------------------------------
// TC2109: redactBody fail-open returns original body when sidecar unreachable
// ---------------------------------------------------------------------------
async function testRedactBodyFailOpen() {
  const cfg = getPrivacyFilterConfig({
    PRIVACY_FILTER_URL: 'http://localhost:9999',
    PRIVACY_FILTER_FAIL_OPEN: 'true'
  });
  const body = { messages: [{ role: 'user', content: 'Hello there' }] };
  const result = await redactBody(cfg, body);
  assert(
    result.body.messages[0].content === 'Hello there',
    `Expected body unmodified on fail-open, got: ${JSON.stringify(result.body)}`
  );
  assert(
    Object.keys(result.mapping).length === 0,
    `Expected empty mapping on fail-open, got: ${JSON.stringify(result.mapping)}`
  );
}

// ---------------------------------------------------------------------------
// TC2110: redactBody fail-closed (default) throws when sidecar unreachable
// ---------------------------------------------------------------------------
async function testRedactBodyFailClosed() {
  const cfg = getPrivacyFilterConfig({ PRIVACY_FILTER_URL: 'http://localhost:9999' });
  const body = { messages: [{ role: 'user', content: 'Hello there' }] };

  let threw = false;
  try {
    await redactBody(cfg, body);
  } catch (e) {
    threw = true;
    assert(/privacy filter unavailable/.test(e.message), `Expected fail-closed error, got: ${e.message}`);
  }
  assert(threw, 'Expected redactBody to throw fail-closed when the sidecar is unreachable and failOpen is not set');
}

// ---------------------------------------------------------------------------
// TC2111: redactBody no-op for a body with no extractable text refs
// ---------------------------------------------------------------------------
async function testRedactBodyNoTextRefs() {
  const cfg = getPrivacyFilterConfig({ PRIVACY_FILTER_URL: 'http://localhost:9999' });
  const body = { foo: 'bar' };
  // Should return immediately without attempting a fetch (and therefore not throw,
  // even though failOpen is false and the sidecar is unreachable).
  const result = await redactBody(cfg, body);
  assert(result.body === body, 'Expected the same body reference to be returned unmodified');
  assert(Object.keys(result.mapping).length === 0, 'Expected empty mapping for a body with no text refs');
}

// ---------------------------------------------------------------------------
// TC2112 (live proxy): no privacy-filter artifacts when PRIVACY_FILTER_URL unset
// ---------------------------------------------------------------------------
async function testLiveProxyNoFilterArtifacts() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'My name is John Doe, email john@example.com.' }],
      max_tokens: 20
    }
  });

  assert(
    response.status === 200 || response.status >= 400,
    'Should respond'
  );

  // If the live proxy's environment has no PRIVACY_FILTER_URL configured
  // (the assumed default test-environment state), the request body is
  // forwarded unredacted and the response must contain no PII sentinels
  // (⟦PII:n⟧), since redaction/restoration never ran.
  assert(
    !/\u27e6PII:\d+\u27e7/.test(response.text || ''),
    'Response should not contain PII sentinel artifacts when the privacy filter is not configured'
  );
}

module.exports = {
  testConfigNullWhenUnset,
  testConfigRejectsExternalHost,
  testConfigAcceptsLocalhostWithDefaults,
  testConfigRejectsMalformedUrl,
  testConfigRejectsNonHttpProtocol,
  testShouldFilterPathMatching,
  testRestoreTextReplacesSentinels,
  testRestoreTextNoSentinels,
  testRedactBodyFailOpen,
  testRedactBodyFailClosed,
  testRedactBodyNoTextRefs,
  testLiveProxyNoFilterArtifacts
};

if (require.main === module) {
  loadModule().then(() => runTestSuite('Privacy Filter Unit Tests', [
    { name: 'TC2101: config null when unset', fn: testConfigNullWhenUnset },
    { name: 'TC2102: rejects external host', fn: testConfigRejectsExternalHost },
    { name: 'TC2103: accepts localhost + defaults', fn: testConfigAcceptsLocalhostWithDefaults },
    { name: 'TC2104: rejects malformed URL', fn: testConfigRejectsMalformedUrl },
    { name: 'TC2105: rejects non-http(s) protocol', fn: testConfigRejectsNonHttpProtocol },
    { name: 'TC2106: shouldFilterPath matching', fn: testShouldFilterPathMatching },
    { name: 'TC2107: restoreText replaces sentinels', fn: testRestoreTextReplacesSentinels },
    { name: 'TC2108: restoreText no-op without sentinels', fn: testRestoreTextNoSentinels },
    { name: 'TC2109: redactBody fail-open', fn: testRedactBodyFailOpen },
    { name: 'TC2110: redactBody fail-closed', fn: testRedactBodyFailClosed },
    { name: 'TC2111: redactBody no text refs', fn: testRedactBodyNoTextRefs },
    { name: 'TC2112: live proxy no filter artifacts', fn: testLiveProxyNoFilterArtifacts }
  ]));
}
