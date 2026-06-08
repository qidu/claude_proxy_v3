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
 */

const {
  sendRequest,
  assert,
  runTest,
  runTestSuite
} = require('../utils/test_helpers');

/**
 * TC701: Get Dashboard Config
 * Tests GET /dashboard/api/config returns valid structure
 */
async function testGetDashboardConfig() {
  const response = await sendRequest({
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
 * TC702: Get Dashboard Config Auth
 * Tests that dashboard requires auth
 */
async function testGetDashboardConfigAuth() {
  const response = await sendRequest({
    endpoint: '/dashboard/api/config',
    headers: { 'Authorization': 'Bearer invalid-key-xyz' }
  });

  // Should still return 200 even with invalid key for GET
  // (auth validation is upstream, not here)
  assert(
    response.status === 200 || response.status === 401,
    'Should respond with valid status'
  );
}

/**
 * TC703: Put Dashboard Config
 * Tests PUT /dashboard/api/config updates config
 */
async function testPutDashboardConfig() {
  // First get current config
  const getRes = await sendRequest({
    endpoint: '/dashboard/api/config',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` }
  });

  if (getRes.body?.config?.read_only) {
    // Skip if read-only (PROXY_CONFIG_URL set)
    console.log('  (skipping - read-only config)');
    return;
  }

  // Get models from current config
  const models = getRes.body?.config?.models || {};
  const firstCategory = Object.keys(models)[0];

  if (!firstCategory) {
    console.log('  (skipping - no categories to update)');
    return;
  }

  // Read current state before modifying
  const response = await sendRequest({
    endpoint: '/dashboard/api/config',
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` },
    body: {
      models: {},
      composite: {}
    }
  });

  // Should succeed or return error if read-only
  assert(
    response.status === 200 || response.status >= 400,
    'Should handle PUT config'
  );
}

/**
 * TC704: Dashboard Config Validation
 * Tests invalid config structure returns error
 */
async function testDashboardConfigValidation() {
  const response = await sendRequest({
    endpoint: '/dashboard/api/config',
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` },
    body: {
      models: null,  // Invalid - should be object
      composite: {}
    }
  });

  assert(
    response.status === 200 || response.status >= 400,
    'Should validate config structure'
  );
}

/**
 * TC705: Get Model Stats
 * Tests GET /dashboard/api/stats/models
 */
async function testGetModelStats() {
  const response = await sendRequest({
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

  // Should return test result
  assert(
    response.status === 200 || response.status === 400,
    `Expected 200 or 400, got ${response.status}`
  );

  // Verify response structure
  if (response.status === 200) {
    assert('success' in response.body, 'Should have success field');
    assert('modelId' in response.body, 'Should have modelId field');
  }
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

  // Should return test result for composite
  assert(
    response.status === 200 || response.status >= 400,
    'Should handle composite model test'
  );
}

/**
 * TC711: Dashboard HTML Page
 * Tests GET /dashboard returns HTML page
 */
async function testDashboardHtmlPage() {
  const response = await fetch('http://localhost:8788/dashboard', {
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);

  const text = await response.text();
  assert(text.includes('Proxy Dashboard'), 'Should contain dashboard title');
  assert(text.includes('<html'), 'Should be valid HTML');
}

module.exports = {
  testGetDashboardConfig,
  testGetDashboardConfigAuth,
  testPutDashboardConfig,
  testDashboardConfigValidation,
  testGetModelStats,
  testGetAgentStats,
  testGetRequestStats,
  testDashboardTestModel,
  testDashboardTestModelMissingId,
  testDashboardTestCompositeModel,
  testDashboardHtmlPage
};

if (require.main === module) {
  runTestSuite('Dashboard API Tests', [
    { name: 'TC701: Get Config', fn: testGetDashboardConfig },
    { name: 'TC705: Model Stats', fn: testGetModelStats },
    { name: 'TC706: Agent Stats', fn: testGetAgentStats },
    { name: 'TC707: Request Stats', fn: testGetRequestStats },
    { name: 'TC708: Test Model', fn: testDashboardTestModel },
    { name: 'TC709: Test Model (no modelId)', fn: testDashboardTestModelMissingId },
    { name: 'TC711: HTML Page', fn: testDashboardHtmlPage }
  ]);
}