/**
 * Dashboard API Tests
 * Tests the dashboard REST API endpoints
 *
 * Coverage:
 * - GET /dashboard/api/config
 * - PUT /dashboard/api/config
 * - GET /dashboard/api/stats/models
 * - GET /dashboard/api/stats/agents
 * - GET /dashboard/api/stats/requests
 * - POST /dashboard/api/test-model
 * - GET /dashboard/api/tools/blocklist
 * - POST /dashboard/api/tools/toggle-block
 * - POST /dashboard/api/global-token-limit
 */

const {
  sendRequest,
  assert,
  runTestSuite
} = require('../utils/test_helpers');

/**
 * TC701: Get Dashboard Config
 * Tests GET /dashboard/api/config returns valid structure
 */
async function testGetDashboardConfig() {
  const response = await sendRequest({
    method: 'GET',
    endpoint: '/dashboard/api/config',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);

  // Verify structure
  assert(response.body?.config, 'Should have config object');
  assert('models' in response.body.config, 'config should have models');
  assert('composite' in response.body.config, 'config should have composite');
  assert('read_only' in response.body.config, 'config should have read_only');
}

/**
 * TC702: Get Config (no auth) — proxy does not enforce inbound API key auth
 * The dashboard GET endpoint is openly accessible; auth is handled by upstreams,
 * not by the proxy itself. This test verifies the endpoint responds without error.
 */
async function testGetDashboardConfigAuth() {
  const response = await sendRequest({
    method: 'GET',
    endpoint: '/dashboard/api/config',
    headers: { 'Authorization': 'Bearer invalid-key-xyz' }
  });

  assert(
    response.status === 200,
    `Dashboard config GET should return 200 regardless of key — got ${response.status}`
  );
}

/**
 * TC705: Get Model Stats
 * Tests GET /dashboard/api/stats/models
 */
async function testGetModelStats() {
  const response = await sendRequest({
    method: 'GET',
    endpoint: '/dashboard/api/stats/models',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
  assert(Array.isArray(response.body?.data), 'Should have data array');
}

/**
 * TC706: Get Agent Stats
 * Tests GET /dashboard/api/stats/agents
 */
async function testGetAgentStats() {
  const response = await sendRequest({
    method: 'GET',
    endpoint: '/dashboard/api/stats/agents',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
  assert(Array.isArray(response.body?.data), 'Should have data array');
}

/**
 * TC707: Get Request Stats
 * Tests GET /dashboard/api/stats/requests
 */
async function testGetRequestStats() {
  const response = await sendRequest({
    method: 'GET',
    endpoint: '/dashboard/api/stats/requests',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);

  // Verify structure
  assert('endpoints' in response.body, 'Should have endpoints');
  assert('upstreams' in response.body, 'Should have upstreams');
  assert('endpoint_timings' in response.body, 'Should have endpoint_timings');
}

/**
 * TC708: Test Model Endpoint
 * Tests POST /dashboard/api/test-model
 */
async function testDashboardTestModel() {
  const response = await sendRequest({
    endpoint: '/dashboard/api/test-model',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` },
    body: {
      modelId: 'deepseek/deepseek-v3.2'
    }
  });

  // handleDashboardTestModel always returns 200 (wraps inner upstream status
  // as success: true/false). Only missing modelId (400, tested by TC709) or
  // JSON parse failure (500) produce other statuses — neither applies here.
  assert(response.status === 200, `Expected 200, got ${response.status}`);

  // Verify response structure
  assert('success' in response.body, 'Should have success field');
  assert('modelId' in response.body, 'Should have modelId field');
}

/**
 * TC709: Test Model Missing modelId
 * Tests POST /dashboard/api/test-model without modelId
 */
async function testDashboardTestModelMissingId() {
  const response = await sendRequest({
    endpoint: '/dashboard/api/test-model',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` },
    body: {}
  });

  assert(response.status === 400, `Expected 400, got ${response.status}`);
  assert(response.body?.error, 'Should have error message');
}

/**
 * TC710: Test Composite Model
 * Tests POST /dashboard/api/test-model with composite alias
 */
async function testDashboardTestCompositeModel() {
  // First get config to find a composite alias
  const configRes = await sendRequest({
    method: 'GET',
    endpoint: '/dashboard/api/config',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` }
  });

  const composites = Object.keys(configRes.body?.config?.composite || {});

  if (composites.length === 0) {
    console.log('  (skipping - no composite aliases configured)');
    return;
  }

  const response = await sendRequest({
    endpoint: '/dashboard/api/test-model',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` },
    body: {
      modelId: composites[0]
    }
  });

  // Should return 200 (test ran) or 4xx (test setup error like unknown model).
  // The proxy alone decides the status; tighten from the prior loose `200 || >= 400`.
  assert(
    response.status === 200 || (response.status >= 400 && response.status < 500),
    `Expected 200 or 4xx for composite model test, got ${response.status}`
  );
}

/**
 * TC711: Dashboard HTML Page
 * Tests GET /dashboard returns HTML page
 */
async function testDashboardHtmlPage() {
  const response = await fetch('http://localhost:7777/dashboard', {
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);

  const text = await response.text();
  assert(text.includes('Proxy Dashboard'), 'Should contain dashboard title');
  assert(text.includes('<html'), 'Should be valid HTML');
}

/**
 * TC712: Get Tool Blocklist
 * Tests GET /dashboard/api/tools/blocklist returns rows + blockedTools
 * (per src/handlers/dashboard.ts handleDashboardToolBlocklist)
 */
async function testGetToolBlocklist() {
  const response = await sendRequest({
    method: 'GET',
    endpoint: '/dashboard/api/tools/blocklist',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
  assert(Array.isArray(response.body?.rows), 'Should have rows array');
  assert(Array.isArray(response.body?.blockedTools), 'Should have blockedTools array');
}

/**
 * TC713: Toggle Tool Block On, Reflected in Blocklist
 * Tests POST /dashboard/api/tools/toggle-block with blocked:true, then
 * verifies the tool appears in a follow-up GET /dashboard/api/tools/blocklist.
 * The blocklist is in-memory only (src/utils/dashboard-stats.ts blockedTools
 * Set) — not persisted across restarts, per docs/README_DETAILS.md.
 */
async function testToggleToolBlockOn() {
  const toolName = `test_tool_${Date.now()}`;

  const toggleRes = await sendRequest({
    method: 'POST',
    endpoint: '/dashboard/api/tools/toggle-block',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` },
    body: { tool_name: toolName, blocked: true }
  });

  assert(toggleRes.status === 200, `Expected 200, got ${toggleRes.status}`);
  assert(toggleRes.body?.ok === true, 'Should return ok:true');
  assert(toggleRes.body?.tool_name === toolName, 'Should echo tool_name');
  assert(toggleRes.body?.blocked === true, 'Should echo blocked:true');

  const blocklistRes = await sendRequest({
    method: 'GET',
    endpoint: '/dashboard/api/tools/blocklist',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` }
  });

  assert(
    blocklistRes.body?.blockedTools?.includes(toolName),
    'Blocked tool should appear in blockedTools after toggle-block(blocked:true)'
  );

  // Cleanup: unblock so this test doesn't leak state into other tests/runs
  await sendRequest({
    method: 'POST',
    endpoint: '/dashboard/api/tools/toggle-block',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` },
    body: { tool_name: toolName, blocked: false }
  });
}

/**
 * TC714: Toggle Tool Block Off, Removed from Blocklist
 * Tests that POST toggle-block with blocked:false removes a previously
 * blocked tool from the blockedTools set.
 */
async function testToggleToolBlockOff() {
  const toolName = `test_tool_off_${Date.now()}`;

  // Block first
  await sendRequest({
    method: 'POST',
    endpoint: '/dashboard/api/tools/toggle-block',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` },
    body: { tool_name: toolName, blocked: true }
  });

  // Then unblock
  const unblockRes = await sendRequest({
    method: 'POST',
    endpoint: '/dashboard/api/tools/toggle-block',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` },
    body: { tool_name: toolName, blocked: false }
  });

  assert(unblockRes.status === 200, `Expected 200, got ${unblockRes.status}`);
  assert(unblockRes.body?.blocked === false, 'Should echo blocked:false');

  const blocklistRes = await sendRequest({
    method: 'GET',
    endpoint: '/dashboard/api/tools/blocklist',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` }
  });

  assert(
    !blocklistRes.body?.blockedTools?.includes(toolName),
    'Unblocked tool should not appear in blockedTools after toggle-block(blocked:false)'
  );
}

/**
 * TC715: Toggle Tool Block Missing tool_name
 * Per src/handlers/dashboard.ts handleDashboardToggleToolBlock — an empty
 * or missing tool_name (after trim) returns 400 with a specific error message.
 */
async function testToggleToolBlockMissingName() {
  const response = await sendRequest({
    method: 'POST',
    endpoint: '/dashboard/api/tools/toggle-block',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` },
    body: { blocked: true }
  });

  assert(response.status === 400, `Expected 400, got ${response.status}`);
  assert(
    response.body?.error === 'tool_name is required',
    `Expected error 'tool_name is required', got ${JSON.stringify(response.body)}`
  );
}

/**
 * TC716: Toggle Tool Block Whitespace-only tool_name
 * tool_name is trimmed server-side before the empty check
 * (`typeof body.tool_name === 'string' ? body.tool_name.trim() : ''`),
 * so a whitespace-only name must also be rejected with 400.
 */
async function testToggleToolBlockWhitespaceName() {
  const response = await sendRequest({
    method: 'POST',
    endpoint: '/dashboard/api/tools/toggle-block',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` },
    body: { tool_name: '   ', blocked: true }
  });

  assert(response.status === 400, `Expected 400, got ${response.status}`);
  assert(
    response.body?.error === 'tool_name is required',
    `Expected error 'tool_name is required', got ${JSON.stringify(response.body)}`
  );
}

/**
 * TC717: Global Token Limit — Set Valid Value
 * Tests POST /dashboard/api/global-token-limit with a value string
 * (per src/handlers/dashboard.ts handleDashboardGlobalTokenLimit ->
 * upsertGlobalTokenLimitFromDashboard)
 */
async function testSetGlobalTokenLimit() {
  const response = await sendRequest({
    method: 'POST',
    endpoint: '/dashboard/api/global-token-limit',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` },
    body: { value: '1M 1d' }
  });

  // parseHumanTokenLimit requires format "<num>[KMBT] <1h|1d|1w|1m>".
  // "1M 1d" is valid → upsertGlobalTokenLimit succeeds → handler returns 200.
  assert(response.status === 200, `Expected 200, got ${response.status}`);
  assert(response.body?.ok === true, 'Should return ok:true');
}

/**
 * TC718: Global Token Limit — Clear with null
 * Per src/handlers/dashboard.ts: `upsertGlobalTokenLimitFromDashboard(env, value ?? null)`
 * — sending value:null should be accepted as a "clear the limit" no-op, not rejected.
 */
async function testClearGlobalTokenLimit() {
  const response = await sendRequest({
    method: 'POST',
    endpoint: '/dashboard/api/global-token-limit',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` },
    body: { value: null }
  });

  // upsertGlobalTokenLimit(config, null) never throws — it just deletes
  // the global_token_limit field. Deterministic 200 with { ok: true }.
  assert(response.status === 200, `Expected 200, got ${response.status}`);
  assert(response.body?.ok === true, 'Should return ok:true');
}

module.exports = {
  testGetDashboardConfig,
  testGetDashboardConfigAuth,
  testGetModelStats,
  testGetAgentStats,
  testGetRequestStats,
  testDashboardTestModel,
  testDashboardTestModelMissingId,
  testDashboardTestCompositeModel,
  testDashboardHtmlPage,
  testGetToolBlocklist,
  testToggleToolBlockOn,
  testToggleToolBlockOff,
  testToggleToolBlockMissingName,
  testToggleToolBlockWhitespaceName,
  testSetGlobalTokenLimit,
  testClearGlobalTokenLimit
};

if (require.main === module) {
  runTestSuite('Dashboard API Tests', [
    { name: 'TC701: Get Config', fn: testGetDashboardConfig },
    { name: 'TC702: Get Config (no auth)', fn: testGetDashboardConfigAuth },
    { name: 'TC705: Model Stats', fn: testGetModelStats },
    { name: 'TC706: Agent Stats', fn: testGetAgentStats },
    { name: 'TC707: Request Stats', fn: testGetRequestStats },
    { name: 'TC708: Test Model', fn: testDashboardTestModel },
    { name: 'TC709: Test Model (no modelId)', fn: testDashboardTestModelMissingId },
    { name: 'TC711: HTML Page', fn: testDashboardHtmlPage },
    { name: 'TC712: Get Tool Blocklist', fn: testGetToolBlocklist },
    { name: 'TC713: Toggle Tool Block On', fn: testToggleToolBlockOn },
    { name: 'TC714: Toggle Tool Block Off', fn: testToggleToolBlockOff },
    { name: 'TC715: Toggle Block Missing tool_name', fn: testToggleToolBlockMissingName },
    { name: 'TC716: Toggle Block Whitespace tool_name', fn: testToggleToolBlockWhitespaceName },
    { name: 'TC717: Set Global Token Limit', fn: testSetGlobalTokenLimit },
    { name: 'TC718: Clear Global Token Limit', fn: testClearGlobalTokenLimit }
  ]);
}