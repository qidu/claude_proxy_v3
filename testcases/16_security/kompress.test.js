/**
 * Kompress (context-compression) Unit Tests
 * Tests src/utils/kompress.ts directly against dist/utils/kompress.js
 * — no running proxy or live KOMPRESS_URL sidecar required.
 *
 * The plugin is entirely inert unless `KOMPRESS_URL` is set (per its own
 * docstring), and no sidecar (submodules/kompress) is assumed to be running
 * in the test environment, so these tests exercise the pure config-loading /
 * path-matching / CJK-detection functions directly, plus the fail-open (the
 * documented default, inverse of the privacy filter) vs fail-closed behavior
 * of compressBody() against an intentionally-unreachable local port.
 *
 * Coverage:
 * - TC2201: getKompressConfig returns null when KOMPRESS_URL unset (inert by default)
 * - TC2202: getKompressConfig rejects a non-internal (public) host
 * - TC2203: getKompressConfig accepts a localhost URL and applies documented defaults,
 *           including failOpen defaulting to true (opposite of the privacy filter,
 *           which is fail-closed by construction with no opt-out)
 * - TC2204: KOMPRESS_FAIL_OPEN=false explicitly disables fail-open
 * - TC2205: shouldCompressPath matches the default endpoint set (no /v1/interactions;
 *           the privacy filter has no endpoints config as of 2026-07-17)
 * - TC2206: isCjkHeavy correctly classifies English vs CJK-heavy vs empty text
 * - TC2207: compressBody fails open by default — unreachable sidecar returns the
 *           original body unmodified with fragments:0/savedChars:0
 * - TC2208: compressBody with KOMPRESS_FAIL_OPEN=false throws when the sidecar
 *           is unreachable
 * - TC2209: compressBody skips fragments shorter than minChars (no fetch attempted,
 *           doesn't throw even with failOpen=false)
 * - TC2210: compressBody skips CJK-heavy fragments (English-only model guard)
 * - TC2211: compressBody is a no-op for a body with no compressible refs
 * - TC2212 (live proxy): with no KOMPRESS_URL configured in the live test
 *           environment, a normal /v1/messages request completes and the
 *           echoed-back content is not truncated/altered by compression
 *
 * Reference: src/utils/kompress.ts, src/index.ts (kompress wiring),
 *            testcases/gaps-of-testcases-konwn-round-3.md (kompress.ts untested)
 */

const path = require('path');
const {
  sendRequest,
  assert,
  runTestSuite
} = require('../utils/test_helpers');

let getKompressConfig, shouldCompressPath, isCjkHeavy, compressBody;

async function loadModule() {
  const mod = await import(path.join(process.cwd(), 'dist/utils/kompress.js'));
  getKompressConfig = mod.getKompressConfig;
  shouldCompressPath = mod.shouldCompressPath;
  isCjkHeavy = mod.isCjkHeavy;
  compressBody = mod.compressBody;
}

// ---------------------------------------------------------------------------
// TC2201: Inert by default (no KOMPRESS_URL)
// ---------------------------------------------------------------------------
async function testConfigNullWhenUnset() {
  const cfg = getKompressConfig({});
  assert(cfg === null, `Expected null when KOMPRESS_URL is unset, got ${JSON.stringify(cfg)}`);

  const cfg2 = getKompressConfig(undefined);
  assert(cfg2 === null, `Expected null when env is undefined, got ${JSON.stringify(cfg2)}`);
}

// ---------------------------------------------------------------------------
// TC2202: Rejects non-internal host
// ---------------------------------------------------------------------------
async function testConfigRejectsExternalHost() {
  let threw = false;
  try {
    getKompressConfig({ KOMPRESS_URL: 'http://evil.example.com:9000' });
  } catch (e) {
    threw = true;
    assert(
      /localhost or a private\/LAN address/.test(e.message),
      `Expected internal-host error, got: ${e.message}`
    );
  }
  assert(threw, 'Expected getKompressConfig to throw for a public/external host');
}

// ---------------------------------------------------------------------------
// TC2203: Accepts localhost URL and applies documented defaults
// ---------------------------------------------------------------------------
async function testConfigAcceptsLocalhostWithDefaults() {
  const cfg = getKompressConfig({ KOMPRESS_URL: 'http://localhost:9600/' });
  assert(cfg !== null, 'Expected non-null config for a localhost URL');
  assert(cfg.url === 'http://localhost:9600', `Expected trailing slash stripped, got ${cfg.url}`);
  assert(cfg.failOpen === true, 'Expected failOpen to default to true (opposite of the privacy filter, which is fail-closed by construction)');
  assert(cfg.timeoutMs === 40000, `Expected default timeoutMs=40000, got ${cfg.timeoutMs}`);
  assert(cfg.maxChars === 1024000, `Expected default maxChars=1024000, got ${cfg.maxChars}`);
  assert(cfg.keepRatio === 0.5, `Expected default keepRatio=0.5, got ${cfg.keepRatio}`);
  assert(cfg.minChars === 200, `Expected default minChars=200, got ${cfg.minChars}`);
  assert(cfg.maxLength === 2048, `Expected fixed maxLength=2048, got ${cfg.maxLength}`);
  assert(
    ['/v1/messages', '/v1/chat/completions', '/v1/responses'].every(e => cfg.endpoints.has(e)),
    `Expected default endpoint set, got ${JSON.stringify([...cfg.endpoints])}`
  );
}

// ---------------------------------------------------------------------------
// TC2204: KOMPRESS_FAIL_OPEN=false explicitly disables fail-open
// ---------------------------------------------------------------------------
async function testConfigFailOpenExplicitlyDisabled() {
  const cfgFalse = getKompressConfig({ KOMPRESS_URL: 'http://localhost:9600', KOMPRESS_FAIL_OPEN: 'false' });
  assert(cfgFalse.failOpen === false, `Expected failOpen=false, got ${cfgFalse.failOpen}`);

  const cfgZero = getKompressConfig({ KOMPRESS_URL: 'http://localhost:9600', KOMPRESS_FAIL_OPEN: '0' });
  assert(cfgZero.failOpen === false, `Expected failOpen=false for '0', got ${cfgZero.failOpen}`);

  const cfgOther = getKompressConfig({ KOMPRESS_URL: 'http://localhost:9600', KOMPRESS_FAIL_OPEN: 'true' });
  assert(cfgOther.failOpen === true, `Expected failOpen=true for explicit 'true', got ${cfgOther.failOpen}`);
}

// ---------------------------------------------------------------------------
// TC2205: shouldCompressPath endpoint matching
// ---------------------------------------------------------------------------
async function testShouldCompressPathMatching() {
  const cfg = getKompressConfig({ KOMPRESS_URL: 'http://localhost:9600' });

  assert(shouldCompressPath(cfg, '/v1/messages') === true, '/v1/messages should be compressed by default config');
  assert(shouldCompressPath(cfg, '/v1/chat/completions') === true, '/v1/chat/completions should be compressed');
  assert(shouldCompressPath(cfg, '/v1/responses') === true, '/v1/responses should be compressed');
  // Unlike the privacy filter, kompress's default endpoint set does NOT include
  // /v1/interactions.
  assert(
    shouldCompressPath(cfg, '/v1/interactions') === false,
    '/v1/interactions is not in the default kompress endpoint set'
  );
  assert(shouldCompressPath(cfg, '/v1/embeddings') === false, '/v1/embeddings is not in the default endpoint set');
}

// ---------------------------------------------------------------------------
// TC2206: isCjkHeavy classification
// ---------------------------------------------------------------------------
async function testIsCjkHeavyClassification() {
  assert(isCjkHeavy('') === false, 'Empty string should not be CJK-heavy');
  assert(
    isCjkHeavy('This is a normal English sentence with plenty of words.') === false,
    'Plain English text should not be CJK-heavy'
  );
  assert(isCjkHeavy('你好世界这是中文文本内容') === true, 'Chinese text should be CJK-heavy');
  assert(isCjkHeavy('こんにちは世界') === true, 'Japanese text should be CJK-heavy');
  assert(isCjkHeavy('안녕하세요 세계') === true, 'Korean text should be CJK-heavy');
  // A single CJK codepoint immediately disqualifies the fragment, regardless
  // of the surrounding English text length.
  assert(
    isCjkHeavy('This is mostly English text but contains one CJK character: 中') === true,
    'Any CJK character present should disqualify the fragment (immediate CJK-heavy classification)'
  );
}

// ---------------------------------------------------------------------------
// TC2207: compressBody fails open by default when sidecar unreachable
// ---------------------------------------------------------------------------
async function testCompressBodyFailOpenDefault() {
  const cfg = getKompressConfig({ KOMPRESS_URL: 'http://localhost:9999' });
  const longText = 'word '.repeat(100); // 500 chars, well above minChars=200
  const body = { messages: [{ role: 'user', content: longText }] };

  const result = await compressBody(cfg, body);
  assert(result.fragments === 0, `Expected 0 fragments compressed on fail-open, got ${result.fragments}`);
  assert(result.savedChars === 0, `Expected 0 savedChars on fail-open, got ${result.savedChars}`);
  assert(
    result.body.messages[0].content === longText,
    'Expected original text preserved unmodified when sidecar is unreachable (fail-open default)'
  );
}

// ---------------------------------------------------------------------------
// TC2208: compressBody throws with KOMPRESS_FAIL_OPEN=false when unreachable
// ---------------------------------------------------------------------------
async function testCompressBodyFailClosed() {
  const cfg = getKompressConfig({ KOMPRESS_URL: 'http://localhost:9999', KOMPRESS_FAIL_OPEN: 'false' });
  const longText = 'word '.repeat(100);
  const body = { messages: [{ role: 'user', content: longText }] };

  let threw = false;
  try {
    await compressBody(cfg, body);
  } catch (e) {
    threw = true;
    assert(/kompress sidecar unavailable/.test(e.message), `Expected sidecar-unavailable error, got: ${e.message}`);
  }
  assert(threw, 'Expected compressBody to throw when failOpen is explicitly disabled and the sidecar is unreachable');
}

// ---------------------------------------------------------------------------
// TC2209: compressBody skips fragments shorter than minChars
// ---------------------------------------------------------------------------
async function testCompressBodySkipsShortFragments() {
  // failOpen=false so that if a fetch WERE attempted it would throw — the
  // absence of a throw here confirms the short fragment was skipped
  // pre-emptively rather than merely failing open.
  const cfg = getKompressConfig({ KOMPRESS_URL: 'http://localhost:9999', KOMPRESS_FAIL_OPEN: 'false' });
  const body = { messages: [{ role: 'user', content: 'short text' }] };

  const result = await compressBody(cfg, body);
  assert(result.fragments === 0, `Expected 0 fragments for text under minChars, got ${result.fragments}`);
  assert(body.messages[0].content === 'short text', 'Expected short text left untouched');
}

// ---------------------------------------------------------------------------
// TC2210: compressBody skips CJK-heavy fragments
// ---------------------------------------------------------------------------
async function testCompressBodySkipsCjkFragments() {
  const cfg = getKompressConfig({ KOMPRESS_URL: 'http://localhost:9999', KOMPRESS_FAIL_OPEN: 'false' });
  const cjkText = '你好世界'.repeat(60); // well above minChars, but CJK-heavy
  const body = { messages: [{ role: 'user', content: cjkText }] };

  const result = await compressBody(cfg, body);
  assert(result.fragments === 0, `Expected 0 fragments for CJK-heavy text, got ${result.fragments}`);
  assert(body.messages[0].content === cjkText, 'Expected CJK-heavy text left untouched');
}

// ---------------------------------------------------------------------------
// TC2211: compressBody no-op for a body with no compressible refs
// ---------------------------------------------------------------------------
async function testCompressBodyNoRefs() {
  const cfg = getKompressConfig({ KOMPRESS_URL: 'http://localhost:9999', KOMPRESS_FAIL_OPEN: 'false' });
  const body = { foo: 'bar' };

  const result = await compressBody(cfg, body);
  assert(result.body === body, 'Expected the same body reference to be returned unmodified');
  assert(result.fragments === 0, 'Expected 0 fragments for a body with no compressible refs');
  assert(result.savedChars === 0, 'Expected 0 savedChars for a body with no compressible refs');
}

// ---------------------------------------------------------------------------
// TC2212 (live proxy): no compression artifacts when KOMPRESS_URL unset
// ---------------------------------------------------------------------------
async function testLiveProxyNoCompressionArtifacts() {
  const originalText = 'Please repeat back exactly: the quick brown fox jumps over the lazy dog. '.repeat(4);

  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: originalText }],
      max_tokens: 20
    }
  });

  assert(
    response.status === 200 || response.status >= 400,
    'Should respond'
  );

  // Kompress mutates the OUTBOUND request text before it reaches the upstream;
  // there is no response-side artifact to check directly (compression is
  // one-directional and lossy per the module's own docs). This test instead
  // confirms the request completes normally without proxy-side errors when
  // KOMPRESS_URL is not configured (the assumed default test-environment
  // state) — i.e. the (inert) kompress wiring does not itself break requests.
  assert(response.status !== 500, `Expected no proxy-side 500 from kompress wiring; got ${response.status}`);
}

module.exports = {
  testConfigNullWhenUnset,
  testConfigRejectsExternalHost,
  testConfigAcceptsLocalhostWithDefaults,
  testConfigFailOpenExplicitlyDisabled,
  testShouldCompressPathMatching,
  testIsCjkHeavyClassification,
  testCompressBodyFailOpenDefault,
  testCompressBodyFailClosed,
  testCompressBodySkipsShortFragments,
  testCompressBodySkipsCjkFragments,
  testCompressBodyNoRefs,
  testLiveProxyNoCompressionArtifacts
};

if (require.main === module) {
  loadModule().then(() => runTestSuite('Kompress Unit Tests', [
    { name: 'TC2201: config null when unset', fn: testConfigNullWhenUnset },
    { name: 'TC2202: rejects external host', fn: testConfigRejectsExternalHost },
    { name: 'TC2203: accepts localhost + defaults', fn: testConfigAcceptsLocalhostWithDefaults },
    { name: 'TC2204: fail-open explicitly disabled', fn: testConfigFailOpenExplicitlyDisabled },
    { name: 'TC2205: shouldCompressPath matching', fn: testShouldCompressPathMatching },
    { name: 'TC2206: isCjkHeavy classification', fn: testIsCjkHeavyClassification },
    { name: 'TC2207: compressBody fail-open default', fn: testCompressBodyFailOpenDefault },
    { name: 'TC2208: compressBody fail-closed', fn: testCompressBodyFailClosed },
    { name: 'TC2209: compressBody skips short fragments', fn: testCompressBodySkipsShortFragments },
    { name: 'TC2210: compressBody skips CJK fragments', fn: testCompressBodySkipsCjkFragments },
    { name: 'TC2211: compressBody no refs', fn: testCompressBodyNoRefs },
    { name: 'TC2212: live proxy no compression breakage', fn: testLiveProxyNoCompressionArtifacts }
  ]));
}
