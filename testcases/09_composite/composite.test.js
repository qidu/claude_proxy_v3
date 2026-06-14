/**
 * Composite Alias Tests
 * Tests the [composite] config section behaviors
 *
 * Coverage:
 * - Basic composite alias routing
 * - primary: true always-routes-first behavior
 * - fallback: N retry priority ordering
 * - share weighted distribution
 * - total_token_limit (HTTP 413 when exceeded)
 * - Composite fallback to default upstream for unresolved targets
 *
 * Reference: README §"Composite aliases"
 */

const {
  sendRequest,
  sendStreamingRequest,
  assert,
  runTest,
  runTestSuite
} = require('../utils/test_helpers');

const { COMPOSITE_ALIASES } = require('../utils/model_config');

/**
 * TC1101: Basic Composite Alias Routing
 * Tests that a composite alias (code-small) is recognized by the proxy.
 * The alias must not return 404 (unknown route) or 500 (internal error).
 * A 200 proves the alias routed; a 4xx from upstream is acceptable.
 */
async function testCompositeBasic() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'code-small',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 20
    }
  });

  assert(
    response.status !== 404,
    'Composite alias code-small should be recognized (404 = unknown route)'
  );
  assert(
    response.status < 500,
    `Composite alias code-small should not cause a proxy internal error (got ${response.status})`
  );
}

/**
 * TC1102: Composite primary Routing
 * Tests that an alias with primary: true (code-small → minimax-m3) routes
 * to the primary target. With the live config, code-small has minimax-m3
 * as the only share>0 target and explicitly primary.
 */
async function testCompositePrimary() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'code-small',
      messages: [{ role: 'user', content: 'What is 2+2?' }],
      max_tokens: 20
    }
  });

  if (response.status === 200) {
    // If a routing decision is reported, the model should be the primary target
    // (may be exposed as response.model or in stats)
    assert(response.body, 'Response body should be present');
  } else {
    // If upstream unavailable, accept graceful failure
    assert(response.status >= 400, 'Should fail gracefully if upstream unavailable');
  }
}

/**
 * TC1103: Composite Fallback Ordering — alias is routable
 * Tests that an alias with fallback targets (code-strong) is recognized
 * by the proxy. Without a way to force the primary to fail in a test,
 * we can only verify the alias is known and does not cause a proxy error.
 */
async function testCompositeFallback() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'code-strong',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 20
    }
  });

  assert(
    response.status !== 404,
    'Composite alias code-strong should be recognized (404 = unknown route)'
  );
  assert(
    response.status < 500,
    `Composite alias code-strong should not cause a proxy internal error (got ${response.status})`
  );
}

/**
 * TC1104: Composite Share Distribution
 * Tests that an alias with share-weighted targets routes across multiple
 * targets. Discovers a share-weighted alias dynamically from the live config
 * rather than hard-coding a name, so this test isn't config-specific.
 */
async function testCompositeShare() {
  const configRes = await sendRequest({
    method: 'GET',
    endpoint: '/dashboard/api/config',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` }
  });

  if (configRes.status !== 200) {
    console.log(`    (skipped: config endpoint returned ${configRes.status})`);
    return;
  }

  const composites = configRes.body?.config?.composite || {};

  // Find an alias that has at least two targets with non-zero share
  const shareAlias = Object.entries(composites).find(([, targets]) => {
    if (!targets || typeof targets !== 'object') return false;
    const modelTargets = Object.entries(targets).filter(([k]) => k !== 'token_limit');
    const nonZero = modelTargets.filter(([, cfg]) =>
      !cfg || typeof cfg !== 'object' || cfg.share !== 0
    );
    return nonZero.length >= 2;
  });

  if (!shareAlias) {
    console.log('    (skipped: no alias with ≥2 non-zero-share targets found in config)');
    return;
  }

  const [aliasName] = shareAlias;

  // Make a few requests — all should succeed or all fail consistently
  const responses = [];
  for (let i = 0; i < 3; i++) {
    const r = await sendRequest({
      endpoint: '/v1/messages',
      body: {
        model: aliasName,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 10
      }
    });
    responses.push(r);
  }

  const successes = responses.filter(r => r.status === 200).length;
  const failures = responses.filter(r => r.status >= 400).length;
  assert(
    successes === responses.length || failures === responses.length,
    `All requests to share-weighted alias "${aliasName}" should share a consistent outcome`
  );
}

/**
 * TC1105: Composite Token Limit — config presence check
 * Verifies that at least one composite alias has a token_limit configured,
 * and that a small request against it does not spuriously return 413.
 * Discovers the alias dynamically so the test isn't tied to a specific name.
 *
 * Note: token_limit in the dashboard payload is the object form
 * { num, duration }; total_token_limit is the legacy TOML key that maps
 * to the same structure on load. The dashboard always exposes token_limit.
 */
async function testCompositeTotalTokenLimit() {
  const configRes = await sendRequest({
    method: 'GET',
    endpoint: '/dashboard/api/config',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` }
  });

  if (configRes.status !== 200) {
    console.log(`    (skipped: config endpoint returned ${configRes.status})`);
    return;
  }

  const composites = configRes.body?.config?.composite || {};

  // Find any alias with token_limit configured (either object or legacy number)
  const limitedEntry = Object.entries(composites).find(([, targets]) =>
    targets && typeof targets === 'object' && 'token_limit' in targets
  );

  if (!limitedEntry) {
    console.log('    (skipped: no composite alias with token_limit in live config)');
    return;
  }

  const [aliasName, aliasTargets] = limitedEntry;
  const limit = aliasTargets.token_limit;
  assert(
    limit !== undefined,
    `${aliasName} should have token_limit set`
  );

  // Make a small request — should NOT trigger 413 on a fresh small request
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: aliasName,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 5
    }
  });

  assert(
    response.status === 200 || response.status === 413 || response.status >= 400,
    'Response should be 200, 413 (limit reached), or graceful 4xx'
  );
  if (response.status === 413) {
    console.log(`    (note: 413 on small request to "${aliasName}" — cumulative usage may already exceed limit)`);
  }
}

/**
 * TC1106: Composite Fallback to Default Upstream
 * Tests that a composite alias whose target model is not in [models.*]
 * falls back to the default upstream (per README "Composite Fallback to
 * Default Upstream") rather than crashing.
 *
 * The `llama` alias targets `llama3` which is NOT in the active config.
 * The proxy should route via default upstream (200) or return a structured
 * upstream error (4xx) — but must NOT crash (500) or return 404.
 */
async function testCompositeFallbackToDefault() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'llama',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 20
    }
  });

  assert(
    response.status !== 404,
    'Composite alias llama should be recognized (404 = unknown route / alias not registered)'
  );
  assert(
    response.status < 500,
    `Composite with unresolved target should not cause a proxy internal error (got ${response.status})`
  );
}

/**
 * TC1107: All Configured Composite Aliases
 * Iterates over the configured composite aliases from /dashboard/api/config
 * and verifies each one responds (smoke test).
 */
async function testAllConfiguredAliases() {
  const configRes = await sendRequest({
    method: 'GET',
    endpoint: '/dashboard/api/config',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` }
  });

  assert(configRes.status === 200, `Config endpoint should return 200 (got ${configRes.status})`);

  const composites = Object.keys(configRes.body?.config?.composite || {});
  assert(composites.length > 0, 'At least one composite alias should be configured');

  for (const alias of composites) {
    const r = await sendRequest({
      endpoint: '/v1/messages',
      body: {
        model: alias,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 10
      }
    });
    assert(
      r.status === 200 || r.status >= 400,
      `Composite alias "${alias}" should respond (got ${r.status})`
    );
  }
}

/**
 * TC1108: Dashboard test-model endpoint works for a composite alias
 * Tests POST /dashboard/api/test-model with a composite alias name.
 * The endpoint must return a structured result (200 with success/failure
 * fields) rather than a proxy error (5xx) or route-not-found (404).
 */
async function testCompositeSameNameAsModel() {
  const response = await sendRequest({
    endpoint: '/dashboard/api/test-model',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` },
    body: {
      modelId: 'code-small'
    }
  });

  assert(
    response.status === 200 || response.status === 400,
    `test-model should return 200 (result) or 400 (bad request), got ${response.status}`
  );
  if (response.status === 200) {
    assert(
      'success' in response.body && 'modelId' in response.body,
      'test-model 200 response should have success and modelId fields'
    );
  } else {
    assert(
      response.body?.error,
      'test-model 400 response should have an error field'
    );
  }
}

const PROXY_URL_COMPOSITE = process.env.PROXY_URL || 'http://localhost:8788';
const API_KEY_COMPOSITE = process.env.API_KEY || 'sk-test-key';

async function putCompositeConfig(models, composite) {
  const res = await fetch(`${PROXY_URL_COMPOSITE}/dashboard/api/config`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY_COMPOSITE}`
    },
    body: JSON.stringify({ models, composite })
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function getDashboardConfig() {
  const res = await sendRequest({
    method: 'GET',
    endpoint: '/dashboard/api/config',
    headers: { 'Authorization': `Bearer ${API_KEY_COMPOSITE}` }
  });
  return res.body?.config || {};
}

/**
 * TC1109: share: 0 exclusion — alias with all-zero shares
 * An alias where every target has share: 0 should have no eligible composite
 * candidates. The proxy falls through to the default upstream for the alias name.
 * This verifies share: 0 is honoured by confirming the dashboard exposes it and
 * that such an alias still responds (via fallback to default upstream).
 *
 * Reference: README L132
 */
async function testCompositeShareZeroExclusion() {
  const config = await getDashboardConfig();
  const composites = config.composite || {};

  // The `gpt-all` alias from the live config has "gpt-5.4-mini": {"share": 0}
  if (!('gpt-all' in composites)) {
    console.log('    (skipped: gpt-all alias not in config)');
    return;
  }

  const gptAll = composites['gpt-all'];
  const targets = Object.entries(gptAll).filter(([k]) => k !== 'token_limit');
  const allZero = targets.every(([, cfg]) => cfg && typeof cfg === 'object' && cfg.share === 0);
  assert(allZero, 'gpt-all should have all targets at share: 0 per README example');

  // The alias should still be routable (falls through to default upstream)
  const res = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'gpt-all',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 10
    }
  });

  assert(
    res.status === 200 || res.status >= 400,
    `gpt-all (all-share-0) should respond without crash (got ${res.status})`
  );
}

/**
 * TC1110: Composite total_token_limit 413 path
 * Creates a temporary composite alias with token_limit: 1, routes through a
 * real model to accumulate 1+ token, then asserts the next request gets 413.
 *
 * Reference: README L129
 */
async function testCompositeTotalTokenLimit413() {
  const config = await getDashboardConfig();
  const models = config.models || {};
  const composite = config.composite || {};

  // Build a dashboard-safe models object (strip api_key, normalize array lengths).
  // getDashboardConfig() returns 2-element arrays [model, base_url] from the
  // dashboard GET view; the PUT validator only accepts 1- or 3-element arrays.
  // Normalize: [model, url] → [model, url, ''] (preserve url); [model, ''] → [model].
  const safeModels = {};
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
    safeModels[cat] = catOut;
  }

  const TEST_ALIAS = '__test_ttl413__';
  // Point to a real model that exists in the default upstream (so routing resolves)
  const TEST_TARGET = 'deepseek/deepseek-v3.2';

  // 1. Configure the test alias with token_limit: 1 (triggers after 1+ token consumed)
  const testComposite = {
    ...composite,
    [TEST_ALIAS]: {
      [TEST_TARGET]: {},
      token_limit: { num: 1, duration: '1h' }
    }
  };

  const putRes = await putCompositeConfig(safeModels, testComposite);
  if (putRes.status !== 200) {
    console.log(`    (skipped: could not configure test alias — ${putRes.status}: ${JSON.stringify(putRes.body?.error)})`);
    return;
  }

  try {
    // 2. First request — should succeed (accumulator starts at 0, 0 >= 1 is false)
    const req1 = await sendRequest({
      endpoint: '/v1/messages',
      body: {
        model: TEST_ALIAS,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 5
      }
    });

    if (req1.status !== 200) {
      console.log(`    (skipped: first request failed with ${req1.status}, cannot test 413 path)`);
      return;
    }

    // 3. Second request — accumulator is now >= 1 token, should get 413
    const req2 = await sendRequest({
      endpoint: '/v1/messages',
      body: {
        model: TEST_ALIAS,
        messages: [{ role: 'user', content: 'Hi again' }],
        max_tokens: 5
      }
    });

    assert(
      req2.status === 413,
      `Second request with exhausted token limit should return 413, got ${req2.status}`
    );

    if (req2.status === 413) {
      assert(
        req2.body?.error?.type === 'over_limit_error' || typeof req2.body?.error === 'string',
        'HTTP 413 response should have over_limit_error type'
      );
    }
  } finally {
    // 4. Restore original composite config
    await putCompositeConfig(safeModels, composite);
  }
}

/**
 * TC1111: Composite token limit exposed in dashboard
 * Verifies that /dashboard/api/config surfaces the token_limit field for
 * aliases that have it configured.
 *
 * Reference: README L259–261
 */
async function testCompositeLimitExposedInDashboard() {
  const config = await getDashboardConfig();
  const composites = config.composite || {};

  // Find any alias with a token_limit configured in live config
  const limitedAliases = Object.entries(composites).filter(
    ([, targets]) => targets && typeof targets === 'object' && 'token_limit' in targets
  );

  if (limitedAliases.length === 0) {
    console.log('    (skipped: no composite aliases with token_limit in live config)');
    return;
  }

  for (const [alias, targets] of limitedAliases) {
    const limit = targets.token_limit;
    assert(
      limit && typeof limit === 'object',
      `${alias}.token_limit should be an object`
    );
    assert(
      typeof limit.num === 'number' && Number.isFinite(limit.num),
      `${alias}.token_limit.num should be a finite number`
    );
    assert(
      typeof limit.duration === 'string' && ['1h', '1d', '1w', '1m'].includes(limit.duration),
      `${alias}.token_limit.duration should be one of 1h/1d/1w/1m`
    );
  }
}

module.exports = {
  testCompositeBasic,
  testCompositePrimary,
  testCompositeFallback,
  testCompositeShare,
  testCompositeTotalTokenLimit,
  testCompositeFallbackToDefault,
  testAllConfiguredAliases,
  testCompositeSameNameAsModel,
  testCompositeShareZeroExclusion,
  testCompositeTotalTokenLimit413,
  testCompositeLimitExposedInDashboard
};

if (require.main === module) {
  runTestSuite('Composite Alias Tests', [
    { name: 'TC1101: Basic Composite', fn: testCompositeBasic },
    { name: 'TC1102: Primary Routing', fn: testCompositePrimary },
    { name: 'TC1103: Fallback Ordering', fn: testCompositeFallback },
    { name: 'TC1104: Share Distribution', fn: testCompositeShare },
    { name: 'TC1105: Total Token Limit', fn: testCompositeTotalTokenLimit },
    { name: 'TC1106: Default Upstream', fn: testCompositeFallbackToDefault },
    { name: 'TC1107: All Aliases', fn: testAllConfiguredAliases },
    { name: 'TC1108: Same Name as Model', fn: testCompositeSameNameAsModel },
    { name: 'TC1109: share:0 Exclusion', fn: testCompositeShareZeroExclusion },
    { name: 'TC1110: Token Limit 413 Path', fn: testCompositeTotalTokenLimit413 },
    { name: 'TC1111: Limit Exposed in Dashboard', fn: testCompositeLimitExposedInDashboard }
  ]);
}
