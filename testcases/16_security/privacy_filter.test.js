/**
 * Privacy Filter Unit Tests
 * Tests src/utils/privacy-filter.ts directly against dist/utils/privacy-filter.js
 * — no running proxy or live PRIVACY_FILTER_URL sidecar required.
 *
 * The plugin is entirely inert unless `PRIVACY_FILTER_URL` is set (per its own
 * docstring), and no sidecar (submodules/privacy-filter/serve.py) is assumed
 * to be running in the test environment, so these tests exercise the pure
 * config-loading / text-restoration functions directly, plus the
 * fail-closed behavior of redactBody() against an intentionally-unreachable
 * local port (no real sidecar required — the connection failure itself is
 * the behavior under test).
 *
 * Coverage:
 * - TC2101: getPrivacyFilterConfig returns null when PRIVACY_FILTER_URL unset (inert by default)
 * - TC2102: getPrivacyFilterConfig rejects a non-internal (public) host
 * - TC2103: getPrivacyFilterConfig accepts a localhost URL and applies documented defaults
 * - TC2104: getPrivacyFilterConfig rejects a malformed URL
 * - TC2105: getPrivacyFilterConfig rejects a non-http(s) protocol
 * - TC2106: restoreText replaces PII sentinels with original values from the mapping
 * - TC2107: restoreText leaves text without sentinels untouched
 * - TC2108: redactBody fail-closed (default) throws when the sidecar is unreachable
 * - TC2109: redactBody is a no-op (no fetch attempted, empty mapping) for a
 *           body with no extractable text refs
 * - TC2110 (live proxy): with no PRIVACY_FILTER_URL configured in the live
 *           test environment, a normal /v1/messages request completes without
 *           any privacy-filter artifacts (sentinels) leaking into the response
 * - TC2111: restoreText replaces HASH sentinels (the new entropy-based
 *           hash/API-key detection from hash_detect.py) — these use the
 *           `⟦HASH:n⟧` prefix, distinct from the `⟦PII:n⟧` prefix
 * - TC2112: restoreText handles mixed PII + HASH sentinels in a single text,
 *           confirming the regex covers both prefixes without interference
 * - TC2113: getPrivacyFilterConfig activates `local` mode from toml `filter_mode = "local"`
 *           with no URL — covers the deployment where the OPF sidecar is absent
 * - TC2114: getPrivacyFilterConfig activates `sidecar` mode from toml `filter_mode = "sidecar"`
 *           + a valid `filter_url` when `PRIVACY_FILTER_URL` is unset — covers the toml-only deployment
 * - TC2115: findHashSpans flags API-key-shaped tokens (HIGH entropy, 16-256 chars,
 *           multiple of 8) and ignores whitelisted hexspeak words
 * - TC2116: detectHashPriority returns HASH_HIGH for 32-char hex with high entropy,
 *           HASH_LOW for short high-entropy hex, HASH_NO for whitelisted tokens
 * - TC2117: redactBody in local mode replaces detected hash spans with
 *           `⟦HASH:n⟧` sentinels and populates the mapping so restoreText
 *           returns the original token
 * - TC2118: redactBody in local mode leaves whitelisted tokens (e.g. `deadbeef`)
 *           untouched in the body — no sentinels minted
 * - TC2119: redactBody in local mode respects toml `whitelist_add` additions
 * - TC2120: redactBody in local mode does NOT throw when the sidecar URL is
 *           absent (the whole point of local mode is to skip the network call)
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

let getPrivacyFilterConfig, restoreText, redactBody;
let findHashSpans, detectHashPriority;

async function loadModule() {
  const mod = await import(path.join(process.cwd(), 'dist/utils/privacy-filter.js'));
  getPrivacyFilterConfig = mod.getPrivacyFilterConfig;
  restoreText = mod.restoreText;
  redactBody = mod.redactBody;
  const hashMod = await import(path.join(process.cwd(), 'dist/utils/hash-detect.js'));
  findHashSpans = hashMod.findHashSpans;
  detectHashPriority = hashMod.detectHashPriority;
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
  assert(cfg.timeoutMs === 40000, `Expected default timeoutMs=40000, got ${cfg.timeoutMs}`);
  assert(cfg.maxChars === 1024000, `Expected default maxChars=1024000, got ${cfg.maxChars}`);
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
// TC2106: restoreText replaces sentinels with mapped originals
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
// TC2107: restoreText is a no-op when there are no sentinels
// ---------------------------------------------------------------------------
async function testRestoreTextNoSentinels() {
  const mapping = { '\u27e6PII:0\u27e7': 'John Doe' };
  const result = restoreText('nothing to restore here', mapping);
  assert(result === 'nothing to restore here', `Expected unchanged text, got: ${result}`);
}

// ---------------------------------------------------------------------------
// TC2108: redactBody fail-closed throws when sidecar unreachable
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
  assert(threw, 'Expected redactBody to throw fail-closed when the sidecar is unreachable');
}

// ---------------------------------------------------------------------------
// TC2109: redactBody no-op for a body with no extractable text refs
// ---------------------------------------------------------------------------
async function testRedactBodyNoTextRefs() {
  const cfg = getPrivacyFilterConfig({ PRIVACY_FILTER_URL: 'http://localhost:9999' });
  const body = { foo: 'bar' };
  // Should return immediately without attempting a fetch (and therefore not throw,
  // even though the sidecar is unreachable).
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

// ---------------------------------------------------------------------------
// TC2113: restoreText replaces HASH sentinels (entropy-based hash detection)
// ---------------------------------------------------------------------------
async function testRestoreTextReplacesHashSentinels() {
  // The hash_detect.py sidecar emits `⟦HASH:n⟧` sentinels for
  // cryptographic-hash-shaped secrets (API keys, tokens). The mapping
  // keys are unique full sentinel strings, so restoration must work for
  // HASH sentinels just like for PII sentinels.
  const mapping = {
    '\u27e6HASH:0\u27e7': '5d41402abc4b2a76b9719d911017c592',
    '\u27e6HASH:1\u27e7': 'sk-deadbeefcafebabe0123456789abcdef'
  };
  const result = restoreText(
    'API key=\u27e6HASH:0\u27e7 leaked; token=\u27e6HASH:1\u27e7 rotated',
    mapping
  );
  assert(
    result === 'API key=5d41402abc4b2a76b9719d911017c592 leaked; token=sk-deadbeefcafebabe0123456789abcdef rotated',
    `Expected HASH sentinels replaced, got: ${result}`
  );
}

// ---------------------------------------------------------------------------
// TC2114: restoreText handles mixed PII + HASH sentinels in a single text
// ---------------------------------------------------------------------------
async function testRestoreTextHandlesMixedPiiAndHashSentinels() {
  // A single redaction batch may produce both PII and HASH sentinels; both
  // prefixes must be matched and replaced independently. The order in
  // which the sidecar mints them is independent of their type.
  const mapping = {
    '\u27e6HASH:0\u27e7': '5d41402abc4b2a76b9719d911017c592',
    '\u27e6PII:1\u27e7': 'alice@example.com'
  };
  const result = restoreText(
    'API key=\u27e6HASH:0\u27e7 leaked for \u27e6PII:1\u27e7',
    mapping
  );
  assert(
    result === 'API key=5d41402abc4b2a76b9719d911017c592 leaked for alice@example.com',
    `Expected mixed sentinels restored, got: ${result}`
  );

  // Reverse order should also work, and unknown sentinels must be left intact.
  const mapping2 = {
    '\u27e6PII:0\u27e7': 'John Doe',
    '\u27e6HASH:2\u27e7': 'feedfacefeedfacefeedfacefeedface'
  };
  const result2 = restoreText(
    'user \u27e6PII:0\u27e7 key=\u27e6HASH:2\u27e7 unknown=\u27e6PII:99\u27e7',
    mapping2
  );
  assert(
    result2 === 'user John Doe key=feedfacefeedfacefeedfacefeedface unknown=\u27e6PII:99\u27e7',
    `Expected unknown sentinel preserved, got: ${result2}`
  );
}

// ---------------------------------------------------------------------------
// TC2115: getPrivacyFilterConfig activates `local` mode from toml without a URL
// ---------------------------------------------------------------------------
async function testConfigLocalModeFromToml() {
  // In local mode, no sidecar URL is required — this is the deployment
  // shape where the OPF Python sidecar is intentionally absent and only
  // the in-process hash detector runs.
  const cfg = getPrivacyFilterConfig({}, { filter_mode: 'local' });
  assert(cfg !== null, 'Expected non-null config for toml filter_mode=local');
  assert(cfg.mode === 'local', `Expected mode=local, got ${cfg.mode}`);
  assert(cfg.url === '', `Expected empty url in local mode, got ${cfg.url}`);
  // Default entropy threshold for hash detection (matches the Python reference).
  assert(cfg.entropyThreshold === 3.0, `Expected entropyThreshold=3.0, got ${cfg.entropyThreshold}`);
  // The whitelist is materialized even in sidecar mode, so it must be a Set.
  assert(cfg.whitelist instanceof Set, `Expected Set whitelist, got ${typeof cfg.whitelist}`);
}

// ---------------------------------------------------------------------------
// TC2116: getPrivacyFilterConfig activates `sidecar` mode from toml `filter_mode`
// + a valid `filter_url` (independent of PRIVACY_FILTER_URL)
// ---------------------------------------------------------------------------
async function testConfigSidecarModeFromTomlUrl() {
  const cfg = getPrivacyFilterConfig({}, { filter_mode: 'sidecar', filter_url: 'http://localhost:9500' });
  assert(cfg !== null, 'Expected non-null config for toml filter_mode=sidecar + filter_url');
  assert(cfg.mode === 'sidecar', `Expected mode=sidecar, got ${cfg.mode}`);
  assert(cfg.url === 'http://localhost:9500', `Expected url unchanged, got ${cfg.url}`);
}

// ---------------------------------------------------------------------------
// TC2117: findHashSpans flags API-key-shaped tokens and ignores hexspeak
// ---------------------------------------------------------------------------
async function testFindHashSpansFlagsApiKeys() {
  // 32-char hex with high entropy is the canonical MD5 / API-key shape.
  const md5 = '5d41402abc4b2a76b9719d911017c592';
  const spans = findHashSpans('key=' + md5);
  assert(spans.length === 1, `Expected 1 span, got ${spans.length}`);
  assert(spans[0].token === md5, `Expected token=${md5}, got ${spans[0].token}`);
  assert(spans[0].priority === 'HIGH', `Expected HIGH priority, got ${spans[0].priority}`);

  // Hexspeak magic numbers (in the built-in whitelist) must NOT match,
  // even though they are 9+ hex chars.
  assert(findHashSpans('marker=deadbeef').length === 0, 'deadbeef should be whitelisted');
  assert(findHashSpans('marker=cafebabe').length === 0, 'cafebabe should be whitelisted');

  // Tokens under the 9-char threshold are not hash candidates.
  assert(findHashSpans('short=abcdef1').length === 0, '8-char hex should not match');

  // Non-hex text is not a hash.
  assert(findHashSpans('hello world').length === 0, 'non-hex text should not match');
}

// ---------------------------------------------------------------------------
// TC2118: detectHashPriority classification
// ---------------------------------------------------------------------------
async function testDetectHashPriorityClassification() {
  // 32 hex chars, multiple of 8, high entropy -> HIGH.
  assert(detectHashPriority('5d41402abc4b2a76b9719d911017c592') === 'HIGH', 'md5-shape should be HIGH');
  // 40 hex chars (SHA-1 length) -> HIGH (multiple of 8).
  assert(detectHashPriority('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d') === 'HIGH', 'sha1-shape should be HIGH');
  // 16 hex chars (md5 prefix) -> HIGH (16 % 8 === 0).
  assert(detectHashPriority('5d41402abc4b2a76') === 'HIGH', '16-char hex should be HIGH');
  // 24 hex chars (multiple of 8) -> HIGH.
  assert(detectHashPriority('5d41402abc4b2a76b971d9ab') === 'HIGH', '24-char hex should be HIGH');
  // 9-char hex, high entropy, NOT multiple of 8 -> LOW.
  assert(detectHashPriority('1234567ab') === 'LOW', '9-char high-entropy hex should be LOW');
  // Whitelisted -> NO.
  assert(detectHashPriority('deadbeefdeadbeef') === 'NO', 'whitelisted token should be NO');
  // 8-char hex -> NO (under threshold).
  assert(detectHashPriority('abcdef12') === 'NO', '8-char hex should be NO');
}

// ---------------------------------------------------------------------------
// TC2119: redactBody in local mode redacts hash-shaped tokens to sentinels
//         and the mapping round-trips through restoreText
// ---------------------------------------------------------------------------
async function testRedactBodyLocalModeRoundTrip() {
  const cfg = getPrivacyFilterConfig({}, { filter_mode: 'local' });
  const body = {
    messages: [{ role: 'user', content: 'API key=5d41402abc4b2a76b9719d911017c592 leaked' }],
  };
  const result = await redactBody(cfg, body);
  const content = result.body.messages[0].content;
  assert(
    content.includes('\u27e6HASH:0\u27e7'),
    `Expected HASH:0 sentinel in body, got: ${content}`
  );
  assert(
    !content.includes('5d41402abc4b2a76b9719d911017c592'),
    `Original token should be replaced, got: ${content}`
  );
  assert(
    Object.keys(result.mapping).length === 1,
    `Expected 1 mapping entry, got ${JSON.stringify(result.mapping)}`
  );
  assert(
    result.mapping['\u27e6HASH:0\u27e7'] === '5d41402abc4b2a76b9719d911017c592',
    `Mapping should round-trip the original token, got: ${JSON.stringify(result.mapping)}`
  );
  // Round-trip: restoreText with the mapping returns the original.
  const restored = restoreText(content, result.mapping);
  assert(
    restored === 'API key=5d41402abc4b2a76b9719d911017c592 leaked',
    `Round-trip failed, got: ${restored}`
  );
}

// ---------------------------------------------------------------------------
// TC2120: redactBody in local mode leaves whitelisted tokens untouched
// ---------------------------------------------------------------------------
async function testRedactBodyLocalModeRespectsBuiltinWhitelist() {
  const cfg = getPrivacyFilterConfig({}, { filter_mode: 'local' });
  const body = {
    messages: [{ role: 'user', content: 'marker=deadbeef and key=5d41402abc4b2a76b9719d911017c592' }],
  };
  const result = await redactBody(cfg, body);
  const content = result.body.messages[0].content;
  assert(
    content.includes('deadbeef'),
    `Whitelisted deadbeef should be preserved, got: ${content}`
  );
  assert(
    !content.includes('5d41402abc4b2a76b9719d911017c592'),
    `High-entropy token should still be redacted, got: ${content}`
  );
  // Only one mapping entry (for the high-entropy token).
  assert(
    Object.keys(result.mapping).length === 1,
    `Expected 1 mapping entry, got ${Object.keys(result.mapping).length}`
  );
}

// ---------------------------------------------------------------------------
// TC2121: redactBody in local mode respects toml `whitelist_add`
// ---------------------------------------------------------------------------
async function testRedactBodyLocalModeRespectsTomlWhitelistAdd() {
  // Mark a specific high-entropy token as whitelisted via toml; it should
  // pass through unredacted, while a different high-entropy token still
  // gets redacted.
  const token = '5d41402abc4b2a76b9719d911017c592';
  const cfg = getPrivacyFilterConfig({}, {
    filter_mode: 'local',
    whitelist_add: [token],
  });
  const body = {
    messages: [{ role: 'user', content: 'a=' + token + ' b=aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d' }],
  };
  const result = await redactBody(cfg, body);
  const content = result.body.messages[0].content;
  assert(
    content.includes(token),
    `Token added to whitelist should be preserved, got: ${content}`
  );
  assert(
    !content.includes('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d'),
    `Non-whitelisted high-entropy token should be redacted, got: ${content}`
  );
}

// ---------------------------------------------------------------------------
// TC2122: redactBody in local mode does not touch the network
// (no sidecar URL, so a sidecar unreachable test does not apply)
// ---------------------------------------------------------------------------
async function testRedactBodyLocalModeNoNetwork() {
  // filter_mode=local means no fetch is ever attempted; filter_url is ignored.
  const cfg = getPrivacyFilterConfig({}, { filter_mode: 'local', filter_url: '' });
  const body = {
    messages: [{ role: 'user', content: 'key=5d41402abc4b2a76b9719d911017c592' }],
  };
  // Should not throw, even though no sidecar is reachable.
  const result = await redactBody(cfg, body);
  assert(
    result.body.messages[0].content.includes('\u27e6HASH:'),
    `Expected HASH sentinel minted locally, got: ${result.body.messages[0].content}`
  );
}

module.exports = {
  testConfigNullWhenUnset,
  testConfigRejectsExternalHost,
  testConfigAcceptsLocalhostWithDefaults,
  testConfigRejectsMalformedUrl,
  testConfigRejectsNonHttpProtocol,
  testRestoreTextReplacesSentinels,
  testRestoreTextNoSentinels,
  testRedactBodyFailClosed,
  testRedactBodyNoTextRefs,
  testLiveProxyNoFilterArtifacts,
  testRestoreTextReplacesHashSentinels,
  testRestoreTextHandlesMixedPiiAndHashSentinels,
  testConfigLocalModeFromToml,
  testConfigSidecarModeFromTomlUrl,
  testFindHashSpansFlagsApiKeys,
  testDetectHashPriorityClassification,
  testRedactBodyLocalModeRoundTrip,
  testRedactBodyLocalModeRespectsBuiltinWhitelist,
  testRedactBodyLocalModeRespectsTomlWhitelistAdd,
  testRedactBodyLocalModeNoNetwork
};

if (require.main === module) {
  loadModule().then(() => runTestSuite('Privacy Filter Unit Tests', [
    { name: 'TC2101: config null when unset', fn: testConfigNullWhenUnset },
    { name: 'TC2102: rejects external host', fn: testConfigRejectsExternalHost },
    { name: 'TC2103: accepts localhost + defaults', fn: testConfigAcceptsLocalhostWithDefaults },
    { name: 'TC2104: rejects malformed URL', fn: testConfigRejectsMalformedUrl },
    { name: 'TC2105: rejects non-http(s) protocol', fn: testConfigRejectsNonHttpProtocol },
    { name: 'TC2106: restoreText replaces sentinels', fn: testRestoreTextReplacesSentinels },
    { name: 'TC2107: restoreText no-op without sentinels', fn: testRestoreTextNoSentinels },
    { name: 'TC2108: redactBody fail-closed', fn: testRedactBodyFailClosed },
    { name: 'TC2109: redactBody no text refs', fn: testRedactBodyNoTextRefs },
    { name: 'TC2110: live proxy no filter artifacts', fn: testLiveProxyNoFilterArtifacts },
    { name: 'TC2111: restoreText replaces HASH sentinels', fn: testRestoreTextReplacesHashSentinels },
    { name: 'TC2112: restoreText handles mixed PII + HASH sentinels', fn: testRestoreTextHandlesMixedPiiAndHashSentinels },
    { name: 'TC2113: config local mode from toml', fn: testConfigLocalModeFromToml },
    { name: 'TC2114: config sidecar mode from toml url', fn: testConfigSidecarModeFromTomlUrl },
    { name: 'TC2115: findHashSpans flags API keys', fn: testFindHashSpansFlagsApiKeys },
    { name: 'TC2116: detectHashPriority classification', fn: testDetectHashPriorityClassification },
    { name: 'TC2117: redactBody local mode round trip', fn: testRedactBodyLocalModeRoundTrip },
    { name: 'TC2118: redactBody local mode respects built-in whitelist', fn: testRedactBodyLocalModeRespectsBuiltinWhitelist },
    { name: 'TC2119: redactBody local mode respects toml whitelist_add', fn: testRedactBodyLocalModeRespectsTomlWhitelistAdd },
    { name: 'TC2120: redactBody local mode no network', fn: testRedactBodyLocalModeNoNetwork }
  ]));
}
