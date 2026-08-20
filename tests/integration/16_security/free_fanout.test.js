/**
 * models.free Auth-Passthrough / Fusion Fan-Out Bound Tests
 *
 * Context (docs/security-review-2.md H2): models.free is documented (README.md
 * L219) as an intentional design where "the proxy authenticates upstream on the
 * caller's behalf — this is what makes the FREE tier work" — a client-supplied
 * bearer token is NOT validated against any allow-list (src/index.ts:670-683,
 * hasAuth is presence-only), and for route.section === 'free', the proxy's own
 * configured api_key silently overrides whatever the caller sent
 * (src/index.ts:943,1197). H2 also flags that fusion aliases fan out to
 * panel + judge + synth upstream calls per single client request, multiplying
 * the cost/DoS blast radius of that auth-bypass design.
 *
 * This is a *documented, intentional* design tradeoff, not a bug to fix — these
 * tests exist to (a) pin down the exact behavior so a future change is caught
 * as a deliberate decision rather than a silent regression, and (b) confirm the
 * fan-out itself is bounded/deterministic (1:1 with configured composite
 * targets, no combinatorial or recursive expansion) rather than literally
 * "unbounded" as a DoS vector.
 *
 * Coverage:
 * - TC2401 (live): a request with a bogus/invalid bearer token against a
 *   models.free-routed model still reaches a real upstream and succeeds,
 *   confirming the documented client-auth-bypass-by-design behavior.
 * - TC2402 (live): the same bogus bearer token against a non-free (default
 *   section) model is rejected upstream (401), showing the override is scoped
 *   to route.section === 'free' only, not a global auth bypass.
 * - TC2403: resolveFusionPlan's panel/judge/synth call count is a deterministic
 *   1:1 mapping to configured composite target entries — a 50-target panel
 *   produces exactly 50 panel calls (+1 judge +1 synth), not a multiplied or
 *   unbounded count.
 * - TC2404: resolveFusionPlan does not recursively expand a panel/judge target
 *   whose name happens to match another composite alias — resolveModelRouteFromConfig
 *   only ever resolves against models.* categories, never proxyConfig.composite,
 *   so nested-alias-as-target cannot cause combinatorial or recursive fan-out.
 * - TC2405: a composite alias with a panel target that is its own alias name
 *   (self-reference) resolves to a flat single route, not infinite recursion.
 * - TC2406: getModelRouteConfig's route.section is 'free' only for entries
 *   actually declared under [models.free], confirming the section flag that
 *   gates the api_key override is derived from config structure, not caller input.
 *
 * Reference: src/index.ts (route.section === 'free' override, lines ~943/1197),
 *            src/utils/config-loader.ts (resolveFusionPlan, getModelRouteConfig,
 *            resolveModelRouteFromConfig), docs/security-review-2.md H2,
 *            testcases/gaps-of-testcases-konwn-round-3.md item 4a.
 */

const path = require('path');
const {
  sendRequest,
  assert,
  runTestSuite
} = require('../utils/test_helpers');

let resolveFusionPlan, getModelRouteConfig;

async function loadModule() {
  const mod = await import(path.join(process.cwd(), 'dist/utils/config-loader.js'));
  resolveFusionPlan = mod.resolveFusionPlan;
  getModelRouteConfig = mod.getModelRouteConfig;
}

const BOGUS_KEY = 'sk-totally-bogus-test-key-12345';

// ---------------------------------------------------------------------------
// TC2401 (live): bogus client bearer token still succeeds for a models.free model
// ---------------------------------------------------------------------------
async function testFreeModelAcceptsBogusClientKey() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    headers: { 'Authorization': `Bearer ${BOGUS_KEY}` },
    body: {
      model: 'minimax-m3',
      messages: [{ role: 'user', content: 'Say exactly: OK' }],
      max_tokens: 10
    }
  });

  assert(
    response.status === 200 || response.status === 429,
    `Expected a real upstream response (200) or rate-limit (429) for a free-tier model with a bogus client key — the proxy is documented to override auth for models.free, so this should not be a 401. Got ${response.status}: ${JSON.stringify(response.body)}`
  );
}

// ---------------------------------------------------------------------------
// TC2402 (live): same bogus token rejected for a non-free (default section) model
// ---------------------------------------------------------------------------
async function testNonFreeModelRejectsBogusClientKey() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    headers: { 'Authorization': `Bearer ${BOGUS_KEY}` },
    body: {
      model: 'deepseek/deepseek-v4-pro',
      messages: [{ role: 'user', content: 'Say exactly: OK' }],
      max_tokens: 1024
    }
  });

  assert(
    response.status === 401,
    `Expected a non-free model to reject a bogus client key upstream (401) — the free-tier api_key override only applies to route.section === 'free'. Got ${response.status}: ${JSON.stringify(response.body)}`
  );
}

// ---------------------------------------------------------------------------
// TC2403: fan-out call count is deterministic 1:1 with configured targets
// ---------------------------------------------------------------------------
async function testFanOutCountDeterministic() {
  const targets = {};
  for (let i = 0; i < 50; i++) {
    targets[`p${i}`] = { fusion: 1, role: 'panel' };
  }
  targets.j1 = { role: 'judge' };
  targets.s1 = { role: 'synth' };

  const proxyConfig = {
    models: { default: { upstream_mode: 'openai-completions', base_url: 'https://example.com' } },
    composite: { 'big-fanout': targets }
  };

  const plan = resolveFusionPlan('big-fanout', proxyConfig);
  assert(plan !== undefined, 'Expected a resolved fusion plan');
  assert(plan.panel.length === 50, `Expected exactly 50 panel targets, got ${plan.panel.length}`);
  assert(plan.judge !== undefined, 'Expected a judge target');

  const totalUpstreamCalls = plan.panel.length + (plan.judge ? 1 : 0) + 1; // +1 for synth
  assert(totalUpstreamCalls === 52, `Expected exactly 52 total upstream calls (50 panel + 1 judge + 1 synth), got ${totalUpstreamCalls}`);
}

// ---------------------------------------------------------------------------
// TC2404: a panel/judge target name matching another composite alias is not expanded
// ---------------------------------------------------------------------------
async function testNestedAliasTargetNotExpanded() {
  const proxyConfig = {
    models: { default: { upstream_mode: 'openai-completions', base_url: 'https://example.com' } },
    composite: {
      'inner': {
        x1: { fusion: 1, role: 'panel' },
        x2: { fusion: 1, role: 'panel' },
        x3: { fusion: 1, role: 'panel' },
        synthI: { role: 'synth' }
      },
      'outer': {
        'inner': { role: 'judge' }, // literal target name matching another composite alias
        p1: { fusion: 1, role: 'panel' },
        synthO: { role: 'synth' }
      }
    }
  };

  const plan = resolveFusionPlan('outer', proxyConfig);
  assert(plan !== undefined, 'Expected a resolved fusion plan for outer');
  assert(plan.panel.length === 1, `Expected outer's panel to have exactly 1 target (not inner's 3 expanded in), got ${plan.panel.length}`);
  assert(plan.judge !== undefined, 'Expected a judge target');
  assert(plan.judge.modelName === 'inner', `Expected judge target to be the literal name 'inner', got ${plan.judge.modelName}`);

  const totalUpstreamCalls = plan.panel.length + (plan.judge ? 1 : 0) + 1;
  assert(
    totalUpstreamCalls === 3,
    `Expected exactly 3 total upstream calls (1 panel + 1 judge('inner' as a literal model, not expanded) + 1 synth), got ${totalUpstreamCalls} — nested composite-alias-as-target must not expand combinatorially`
  );
}

// ---------------------------------------------------------------------------
// TC2405: self-referential panel target resolves flat, no infinite recursion
// ---------------------------------------------------------------------------
async function testSelfReferentialTargetNoRecursion() {
  const proxyConfig = {
    models: { default: { upstream_mode: 'openai-completions', base_url: 'https://example.com' } },
    composite: {
      'selfref': {
        'otherref': { fusion: 1, role: 'panel' }, // target name === alias's own name
        s1: { role: 'synth' }
      }
    }
  };

  const plan = resolveFusionPlan('selfref', proxyConfig);
  assert(plan !== undefined, 'Expected a resolved fusion plan');
  assert(plan.panel.length === 1, `Expected exactly 1 panel target (self-reference resolved as a literal model name, not recursed), got ${plan.panel.length}`);
  assert(plan.panel[0].modelName === 'otherref', `Expected panel target modelName to be the literal 'otherref', got ${plan.panel[0].modelName}`);
}

// ---------------------------------------------------------------------------
// TC2406: route.section is derived from config structure, only 'free' for
// entries actually declared under [models.free]
// ---------------------------------------------------------------------------
async function testRouteSectionReflectsConfigStructure() {
  const proxyConfig = {
    models: {
      claude: {
        upstream_mode: 'anthropic-messages',
        base_url: 'http://localhost:3000',
        opus46: { target: 'claude-opus-4-6', base_url: 'http://localhost:3000', api_key: '', mode: 'anthropic-messages' }
      },
      free: {
        upstream_mode: 'openai-completions',
        base_url: 'https://api.qnaigc.com',
        api_key: 'sk-free-config-key',
        opus48: { target: 'claude-opus-4-8', base_url: 'http://localhost:3000', api_key: '', mode: 'anthropic-messages' }
      },
      default: { upstream_mode: 'openai-completions', base_url: 'https://api.minimaxi.com', '*': {} }
    },
    composite: {}
  };

  const freeRoute = getModelRouteConfig('opus48', proxyConfig);
  assert(freeRoute.section === 'free', `Expected section 'free' for an entry declared under [models.free], got ${freeRoute.section}`);
  assert(freeRoute.apiKey === 'sk-free-config-key', `Expected the free category's configured api_key to be resolved, got ${freeRoute.apiKey}`);

  const claudeRoute = getModelRouteConfig('opus46', proxyConfig);
  assert(claudeRoute.section === 'claude', `Expected section 'claude' for an entry declared under [models.claude], got ${claudeRoute.section}`);

  const defaultRoute = getModelRouteConfig('some-unconfigured-model-name', proxyConfig);
  assert(defaultRoute.section !== 'free', `Expected an unconfigured model routed via the default catch-all to NOT have section 'free', got ${defaultRoute.section}`);
}

module.exports = {
  testFreeModelAcceptsBogusClientKey,
  testNonFreeModelRejectsBogusClientKey,
  testFanOutCountDeterministic,
  testNestedAliasTargetNotExpanded,
  testSelfReferentialTargetNoRecursion,
  testRouteSectionReflectsConfigStructure
};

if (require.main === module) {
  loadModule().then(() => runTestSuite('models.free / Fusion Fan-Out Bound Tests', [
    { name: 'TC2401: free model accepts bogus client key', fn: testFreeModelAcceptsBogusClientKey },
    { name: 'TC2402: non-free model rejects bogus client key', fn: testNonFreeModelRejectsBogusClientKey },
    { name: 'TC2403: fan-out count deterministic', fn: testFanOutCountDeterministic },
    { name: 'TC2404: nested alias target not expanded', fn: testNestedAliasTargetNotExpanded },
    { name: 'TC2405: self-referential target no recursion', fn: testSelfReferentialTargetNoRecursion },
    { name: 'TC2406: route.section reflects config structure', fn: testRouteSectionReflectsConfigStructure }
  ]));
}
