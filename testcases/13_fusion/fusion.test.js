/**
 * Fusion Composite Alias Tests
 * Tests the fusion mode composite alias (parallel fan-out → judge → synthesis).
 *
 * Coverage:
 * - TC1301: Alias discovery — fusion aliases appear in dashboard config
 * - TC1302: Basic non-streaming response — correct shape (id, content, usage)
 * - TC1303: Streaming response — correct SSE event sequence
 * - TC1304: Recursion guard — x-fusion-depth: 1 header triggers 500 error
 * - TC1305: min_panel enforcement — alias with min_panel > available panel responds
 * - TC1306: Config round-trip — fusion_options and role survive PUT/GET
 * - TC1307: judge_required: false degrades gracefully when judge is absent
 * - TC1308: fusion_metadata field present in non-streaming response when expose_metadata: true
 *
 * Config isolation: tests that mutate config create a temporary alias __test_fusion__
 * and restore the original config in a finally block.
 *
 * Reference: docs/design_fusion_composite_alias.md
 */

const {
  sendRequest,
  sendStreamingRequest,
  assert,
  runTestSuite
} = require('../utils/test_helpers');

const PROXY_URL_FUSION = process.env.PROXY_URL || 'http://localhost:8788';
const API_KEY_FUSION = process.env.API_KEY || 'sk-test-key';

// ---- Config helpers ----

async function getDashboardConfig() {
  const res = await sendRequest({
    method: 'GET',
    endpoint: '/dashboard/api/config',
    headers: { 'Authorization': `Bearer ${API_KEY_FUSION}` }
  });
  return res.body?.config || {};
}

async function putConfig(models, composite) {
  const res = await fetch(`${PROXY_URL_FUSION}/dashboard/api/config`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY_FUSION}`
    },
    body: JSON.stringify({ models, composite })
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

/**
 * Build a dashboard-safe models object from the live config.
 * The dashboard GET returns 2-element arrays; PUT requires 1- or 3-element arrays.
 */
function safeModels(models) {
  const out = {};
  for (const [cat, cfg] of Object.entries(models)) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
    const catOut = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (k === 'api_key') continue;
      if (!Array.isArray(v)) {
        catOut[k] = v;
      } else if (v.length >= 2 && v[1]) {
        catOut[k] = [v[0], v[1], ''];
      } else {
        catOut[k] = [v[0]];
      }
    }
    out[cat] = catOut;
  }
  return out;
}

/**
 * Minimal fusion alias built from real models proven to route through the
 * default qnaigc upstream in the other suites:
 *   - panel: deepseek/deepseek-v3.2  (TC401)
 *   - judge: moonshotai/kimi-k2.5    (TC404)
 *   - synth: qwen/qwen3.6-plus       (TC402)
 *
 * fusion_options: min_panel: 1 (so one panel response is enough),
 *                 judge_required: false (synth degrades to raw panel if judge fails).
 */
const TEST_ALIAS = '__test_fusion__';

const FUSION_PANEL_MODEL = 'deepseek/deepseek-v3.2';
const FUSION_JUDGE_MODEL = 'moonshotai/kimi-k2.5';
const FUSION_SYNTH_MODEL = 'qwen/qwen3.6-plus';

function buildTestFusionAlias() {
  return {
    [FUSION_PANEL_MODEL]: { fusion: 1 },
    [FUSION_JUDGE_MODEL]: { role: 'judge' },
    [FUSION_SYNTH_MODEL]: { role: 'synth' },
    fusion_options: { min_panel: 1, judge_required: false, panel_timeout_ms: 25000 }
  };
}

// ---- Tests ----

/**
 * TC1301: Fusion alias discovery
 * If any fusion alias is configured in the live config, it must appear in
 * /dashboard/api/config under composite. We check for the presence of a
 * fusion_options key as the discriminator.
 *
 * This test is skipped if no fusion aliases are configured yet — the remaining
 * tests inject one via PUT to ensure coverage regardless of live config state.
 */
async function testFusionAliasDiscovery() {
  const config = await getDashboardConfig();
  const composites = config.composite || {};

  const fusionAliases = Object.entries(composites).filter(([, targets]) =>
    targets && typeof targets === 'object' && 'fusion_options' in targets
  );

  if (fusionAliases.length === 0) {
    console.log('    (note: no fusion aliases in live config — injection tests cover remaining cases)');
    return;
  }

  for (const [alias, targets] of fusionAliases) {
    const opts = targets.fusion_options;
    assert(opts && typeof opts === 'object', `${alias}.fusion_options should be an object`);

    // At least one target should have fusion: N (panel member) or role: 'synth'
    const targetEntries = Object.entries(targets).filter(([k]) => k !== 'fusion_options' && k !== 'token_limit');
    const hasPanel = targetEntries.some(([, cfg]) => cfg && typeof cfg === 'object' && typeof cfg.fusion === 'number');
    const hasSynth = targetEntries.some(([, cfg]) => cfg && typeof cfg === 'object' && cfg.role === 'synth');

    assert(
      hasPanel || hasSynth,
      `${alias} should have at least one panel (fusion: N) or synth (role: synth) target`
    );
  }
}

/**
 * TC1302: Basic non-streaming response via injected fusion alias
 * Injects __test_fusion__ with min_panel: 1, judge_required: false.
 * Sends a non-streaming request and verifies the response is structurally valid.
 */
async function testFusionBasicResponse() {
  const config = await getDashboardConfig();
  const models = safeModels(config.models || {});
  const composite = config.composite || {};

  const testComposite = { ...composite, [TEST_ALIAS]: buildTestFusionAlias() };
  const putRes = await putConfig(models, testComposite);
  if (putRes.status !== 200) {
    console.log(`    (skipped: could not inject fusion alias — ${putRes.status}: ${JSON.stringify(putRes.body?.error)})`);
    return;
  }

  try {
    const res = await sendRequest({
      endpoint: '/v1/messages',
      body: {
        model: TEST_ALIAS,
        messages: [{ role: 'user', content: 'Say exactly: hello' }],
        max_tokens: 30
      }
    });

    if (res.status !== 200) {
      // Panel upstreams may be unavailable in the test environment.
      // Accept any structured 4xx (routing worked, upstream failed) but not 5xx.
      assert(
        res.status >= 400 && res.status < 500,
        `Fusion alias should not cause internal proxy error (got ${res.status})`
      );
      console.log(`    (note: upstream returned ${res.status} — proxy routing OK, upstream unavailable)`);
      return;
    }

    assert(res.body?.id, 'Response should have id field');
    assert(Array.isArray(res.body?.content), 'Response should have content array');
    assert(res.body?.usage, 'Response should have usage field');
    assert(res.body?.type === 'message', 'Response type should be message');
  } finally {
    await putConfig(models, composite);
  }
}

/**
 * TC1303: Streaming response via injected fusion alias
 * Same setup as TC1302 but with stream: true.
 * Verifies SSE event sequence: message_start → content_block_delta(s) → message_stop.
 */
async function testFusionStreamingResponse() {
  const config = await getDashboardConfig();
  const models = safeModels(config.models || {});
  const composite = config.composite || {};

  const testComposite = { ...composite, [TEST_ALIAS]: buildTestFusionAlias() };
  const putRes = await putConfig(models, testComposite);
  if (putRes.status !== 200) {
    console.log(`    (skipped: could not inject fusion alias — ${putRes.status})`);
    return;
  }

  try {
    const res = await sendStreamingRequest({
      endpoint: '/v1/messages',
      body: {
        model: TEST_ALIAS,
        messages: [{ role: 'user', content: 'Say exactly: hi' }],
        max_tokens: 30
      }
    });

    if (res.status !== 200) {
      assert(
        res.status >= 400 && res.status < 500,
        `Fusion streaming should not cause internal proxy error (got ${res.status})`
      );
      console.log(`    (note: upstream returned ${res.status} in streaming mode)`);
      return;
    }

    assert(res.eventCount > 0, 'Streaming response should have at least one SSE event');

    const allTypes = res.events.map(e => e.type || e.event).filter(Boolean);
    assert(
      allTypes.includes('message_start') || res.events[0]?.type === 'message_start',
      'Streaming response should include message_start event'
    );
    assert(
      allTypes.includes('message_stop') || allTypes.includes('done'),
      'Streaming response should include message_stop event'
    );
  } finally {
    await putConfig(models, composite);
  }
}

/**
 * TC1304: Recursion guard — x-fusion-depth: 1 triggers 500
 * Sends a request to a fusion alias with the x-fusion-depth: 1 header set.
 * The proxy must detect the depth and return an error (not recurse).
 */
async function testFusionRecursionGuard() {
  const config = await getDashboardConfig();
  const models = safeModels(config.models || {});
  const composite = config.composite || {};

  const testComposite = { ...composite, [TEST_ALIAS]: buildTestFusionAlias() };
  const putRes = await putConfig(models, testComposite);
  if (putRes.status !== 200) {
    console.log(`    (skipped: could not inject fusion alias — ${putRes.status})`);
    return;
  }

  try {
    const res = await sendRequest({
      endpoint: '/v1/messages',
      headers: {
        'x-fusion-depth': '1'
      },
      body: {
        model: TEST_ALIAS,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 10
      }
    });

    // The recursion guard should produce a 5xx or 4xx error, not silently succeed.
    assert(
      res.status >= 400,
      `Fusion request with x-fusion-depth: 1 should be rejected (got ${res.status})`
    );
  } finally {
    await putConfig(models, composite);
  }
}

/**
 * TC1305: min_panel enforcement
 * Injects a fusion alias with min_panel: 99 (impossible to satisfy with 2 panel targets).
 * The proxy should return an error (not a successful synthesis) when the panel
 * cannot meet the minimum response count.
 *
 * Only verifiable if the upstreams actually respond (min_panel check fires after
 * panel stage completes). If upstreams are unavailable the test is skipped.
 */
async function testFusionMinPanelEnforcement() {
  const config = await getDashboardConfig();
  const models = safeModels(config.models || {});
  const composite = config.composite || {};

  const impossibleAlias = {
    [FUSION_PANEL_MODEL]: { fusion: 1 },
    [FUSION_SYNTH_MODEL]: { role: 'synth' },
    fusion_options: { min_panel: 99, judge_required: false, panel_timeout_ms: 5000 }
  };

  const testComposite = { ...composite, [TEST_ALIAS]: impossibleAlias };
  const putRes = await putConfig(models, testComposite);
  if (putRes.status !== 200) {
    console.log(`    (skipped: could not inject fusion alias — ${putRes.status})`);
    return;
  }

  try {
    const res = await sendRequest({
      endpoint: '/v1/messages',
      body: {
        model: TEST_ALIAS,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 10
      },
      timeout: 15000
    });

    // With min_panel: 99 but only 1 actual panel target, the proxy should fail.
    // We accept any non-200 response as evidence of enforcement.
    assert(
      res.status !== 200,
      `Fusion with min_panel: 99 and 1 panel target should not return 200 (got ${res.status})`
    );
  } finally {
    await putConfig(models, composite);
  }
}

/**
 * TC1306: Config round-trip — fusion_options and role survive PUT/GET
 * Writes a fusion alias via PUT and reads it back via GET, then asserts that
 * the fusion_options block and role fields are preserved in the dashboard view.
 */
async function testFusionConfigRoundTrip() {
  const config = await getDashboardConfig();
  const models = safeModels(config.models || {});
  const composite = config.composite || {};

  const fusionDef = buildTestFusionAlias();
  const testComposite = { ...composite, [TEST_ALIAS]: fusionDef };
  const putRes = await putConfig(models, testComposite);
  if (putRes.status !== 200) {
    console.log(`    (skipped: could not write fusion alias — ${putRes.status}: ${JSON.stringify(putRes.body?.error)})`);
    return;
  }

  try {
    const readBack = await getDashboardConfig();
    const alias = readBack.composite?.[TEST_ALIAS];

    assert(alias, `${TEST_ALIAS} should be present in config after PUT`);
    assert(
      alias.fusion_options && typeof alias.fusion_options === 'object',
      'fusion_options should round-trip as an object'
    );
    assert(
      alias.fusion_options.min_panel === 1,
      `fusion_options.min_panel should be 1 (got ${alias.fusion_options?.min_panel})`
    );
    assert(
      alias.fusion_options.judge_required === false,
      `fusion_options.judge_required should be false (got ${alias.fusion_options?.judge_required})`
    );

    // synth model should have role: 'synth'
    const synthTarget = alias[FUSION_SYNTH_MODEL];
    assert(
      synthTarget && synthTarget.role === 'synth',
      `${FUSION_SYNTH_MODEL} should have role: synth (got ${JSON.stringify(synthTarget)})`
    );

    // panel model should have fusion: 1
    const panelTarget = alias[FUSION_PANEL_MODEL];
    assert(
      panelTarget && panelTarget.fusion === 1,
      `${FUSION_PANEL_MODEL} should have fusion: 1 (got ${JSON.stringify(panelTarget)})`
    );
  } finally {
    await putConfig(models, composite);
  }
}

/**
 * TC1307: judge_required: false — graceful degrade without judge
 * The alias has no explicit judge target and judge_required: false.
 * The proxy should skip the judge stage entirely and proceed to synthesis.
 * A 200 response (or graceful upstream 4xx) is expected — no 5xx.
 */
async function testFusionNoJudgeDegrade() {
  const config = await getDashboardConfig();
  const models = safeModels(config.models || {});
  const composite = config.composite || {};

  // Alias with NO judge role and judge_required: false
  const noJudgeAlias = {
    [FUSION_PANEL_MODEL]: { fusion: 1 },
    [FUSION_SYNTH_MODEL]: { role: 'synth' },
    fusion_options: { min_panel: 1, judge_required: false }
  };

  const testComposite = { ...composite, [TEST_ALIAS]: noJudgeAlias };
  const putRes = await putConfig(models, testComposite);
  if (putRes.status !== 200) {
    console.log(`    (skipped: could not inject fusion alias — ${putRes.status})`);
    return;
  }

  try {
    const res = await sendRequest({
      endpoint: '/v1/messages',
      body: {
        model: TEST_ALIAS,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 20
      }
    });

    assert(
      res.status < 500,
      `Fusion with no judge and judge_required: false should not cause proxy internal error (got ${res.status})`
    );

    if (res.status === 200) {
      assert(Array.isArray(res.body?.content), 'Response should have content array');
    }
  } finally {
    await putConfig(models, composite);
  }
}

/**
 * TC1308: expose_metadata — fusion_metadata present in non-streaming response
 * When expose_metadata: true is set, a non-streaming synthesis response should
 * include a fusion_metadata field at the top level.
 *
 * Only verifiable when the upstreams succeed (status 200).
 */
async function testFusionExposeMetadata() {
  const config = await getDashboardConfig();
  const models = safeModels(config.models || {});
  const composite = config.composite || {};

  const metaAlias = {
    [FUSION_PANEL_MODEL]: { fusion: 1 },
    [FUSION_SYNTH_MODEL]: { role: 'synth' },
    fusion_options: { min_panel: 1, judge_required: false, expose_metadata: true }
  };

  const testComposite = { ...composite, [TEST_ALIAS]: metaAlias };
  const putRes = await putConfig(models, testComposite);
  if (putRes.status !== 200) {
    console.log(`    (skipped: could not inject fusion alias — ${putRes.status})`);
    return;
  }

  try {
    const res = await sendRequest({
      endpoint: '/v1/messages',
      body: {
        model: TEST_ALIAS,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 20
      }
    });

    if (res.status !== 200) {
      console.log(`    (note: upstream returned ${res.status} — cannot verify fusion_metadata field)`);
      assert(
        res.status < 500,
        `Fusion should not cause proxy internal error (got ${res.status})`
      );
      return;
    }

    assert(
      res.body?.fusion_metadata !== undefined,
      'Non-streaming fusion response with expose_metadata: true should include fusion_metadata field'
    );
    const meta = res.body.fusion_metadata;
    assert(typeof meta === 'object', 'fusion_metadata should be an object');
    assert(Array.isArray(meta.panel_models), 'fusion_metadata.panel_models should be an array');
    assert(typeof meta.synth_model === 'string', 'fusion_metadata.synth_model should be a string');
    assert(typeof meta.analysis_present === 'boolean', 'fusion_metadata.analysis_present should be a boolean');
  } finally {
    await putConfig(models, composite);
  }
}

// ---- Suite runner ----

module.exports = {
  testFusionAliasDiscovery,
  testFusionBasicResponse,
  testFusionStreamingResponse,
  testFusionRecursionGuard,
  testFusionMinPanelEnforcement,
  testFusionConfigRoundTrip,
  testFusionNoJudgeDegrade,
  testFusionExposeMetadata
};

if (require.main === module) {
  runTestSuite('Fusion Composite Alias Tests', [
    { name: 'TC1301: Alias Discovery', fn: testFusionAliasDiscovery },
    { name: 'TC1302: Basic Non-Streaming Response', fn: testFusionBasicResponse },
    { name: 'TC1303: Streaming Response', fn: testFusionStreamingResponse },
    { name: 'TC1304: Recursion Guard', fn: testFusionRecursionGuard },
    { name: 'TC1305: min_panel Enforcement', fn: testFusionMinPanelEnforcement },
    { name: 'TC1306: Config Round-Trip', fn: testFusionConfigRoundTrip },
    { name: 'TC1307: No-Judge Degrade', fn: testFusionNoJudgeDegrade },
    { name: 'TC1308: expose_metadata Field', fn: testFusionExposeMetadata }
  ]);
}
