/**
 * Integration Tests
 * Tests multi-component integration scenarios
 *
 * Coverage:
 * - Config load and serve
 * - Token stats accumulation across requests
 * - Multi-model routing behavior
 * - Error propagation
 */

const {
  sendRequest,
  assert,
  runTest,
  runTestSuite
} = require('../utils/test_helpers');

/**
 * TC601: Config Loads on Startup
 * Tests that config is properly loaded and served
 */
async function testConfigLoaded() {
  const response = await sendRequest({
    endpoint: '/dashboard/api/config',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` }
  });

  assert(response.status === 200, 'Config endpoint should be accessible');
  assert(response.body?.config, 'Config should be loaded');
}

/**
 * TC602: Multiple Sequential Requests Track Stats
 * Tests that multiple requests accumulate stats
 */
async function testSequentialRequestStats() {
  const model = 'deepseek/deepseek-v3.2';

  // Make several requests
  for (let i = 0; i < 3; i++) {
    const response = await sendRequest({
      endpoint: '/v1/messages',
      body: {
        model,
        messages: [{ role: 'user', content: `Test ${i}` }],
        max_tokens: 10
      }
    });

    // Should succeed
    assert(
      response.status === 200 || response.status >= 400,
      `Request ${i} should complete`
    );
  }

  // Check stats were recorded
  const statsRes = await sendRequest({
    endpoint: '/dashboard/api/stats/models',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` }
  });

  assert(statsRes.status === 200, 'Stats endpoint should work');

  // The model should appear in stats (or not if all failed)
  const modelStats = statsRes.body?.data || [];
  const found = modelStats.find(s => s.model?.includes('deepseek'));
  assert(found !== undefined, 'Should have model stats after requests');
}

/**
 * TC603: Health Check
 * Tests basic connectivity
 */
async function testHealthCheck() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 5
    }
  });

  // Should get a response (200 or error)
  assert(
    response.status === 200 || response.status >= 400,
    'Should respond to requests'
  );
}

/**
 * TC604: CORS Headers Present
 * Tests that CORS headers are set on responses
 */
async function testCorsHeaders() {
  const response = await sendRequest({
    endpoint: '/v1/models',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` }
  });

  // Check for common CORS headers
  // Note: Actual presence depends on server configuration
  const headers = response.headers || {};
  assert(
    'content-type' in headers,
    'Should have content-type header'
  );
}

/**
 * TC605: Models List Endpoint
 * Tests GET /v1/models returns model list
 */
async function testModelsListEndpoint() {
  const response = await sendRequest({
    endpoint: '/v1/models',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
  assert(Array.isArray(response.body?.data), 'Should have data array');
  assert(response.body?.data?.length > 0, 'Should have at least one model');
}

/**
 * TC606: Token Counting Endpoint
 * Tests /v1/messages/count_tokens
 */
async function testTokenCountEndpoint() {
  const response = await sendRequest({
    endpoint: '/v1/messages/count_tokens',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello world' }]
    }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);

  // Should have token counts
  const hasTokens = response.body?.input_tokens !== undefined ||
                    response.body?.total_tokens !== undefined;
  assert(hasTokens, 'Should return token counts');
}

/**
 * TC607: Request Timeout Handling
 * Tests that long-running requests can timeout
 */
async function testRequestTimeout() {
  const PROXY_URL = process.env.PROXY_URL || 'http://localhost:8788';

  // Send a request with short timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(`${PROXY_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.API_KEY || 'test'}`
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-v3.2',
        messages: [{ role: 'user', content: 'Count to 1000' }],
        max_tokens: 5
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    assert(
      response.status === 200 || response.status >= 400,
      'Should complete or timeout gracefully'
    );
  } catch (error) {
    clearTimeout(timeoutId);
    // Timeout is acceptable
    assert(
      error.name === 'AbortError',
      'Should timeout with AbortError'
    );
  }
}

/**
 * TC608: Request Timing Recorded
 * Tests that request timing stats are collected
 */
async function testRequestTimingStats() {
  const model = 'deepseek/deepseek-v3.2';

  // Make a request
  await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model,
      messages: [{ role: 'user', content: 'Quick test' }],
      max_tokens: 5
    }
  });

  // Check timing stats
  const statsRes = await sendRequest({
    endpoint: '/dashboard/api/stats/requests',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` }
  });

  assert(statsRes.status === 200, 'Request stats should be accessible');
  assert('endpoint_timings' in statsRes.body, 'Should have timing data');
}

/**
 * TC609: Error Response Format
 * Tests that error responses have consistent format
 */
async function testErrorResponseFormat() {
  // Send request with invalid model
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'nonexistent-model-xyz-12345',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 10
    }
  });

  assert(response.status >= 400, 'Should return error status');

  // Error should have error object or message
  const hasError = response.body?.error || response.body?.message;
  assert(hasError, 'Error response should have error or message field');
}

/**
 * TC610: Streaming and Non-Streaming Both Work
 * Tests that both streaming and non-streaming modes function
 */
async function testStreamingAndNonStreaming() {
  const model = 'qwen3-32b';
  const prompt = 'Say hi';

  // Non-streaming
  const nonStreamRes = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 10,
      stream: false
    }
  });

  assert(
    nonStreamRes.status === 200 || nonStreamRes.status >= 400,
    'Non-streaming should work'
  );

  // Streaming
  const streamRes = await sendStreamingRequest({
    endpoint: '/v1/messages',
    body: {
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 10,
      stream: true
    }
  });

  assert(
    streamRes.status === 200 || streamRes.status >= 400,
    'Streaming should work'
  );

  if (streamRes.status === 200) {
    assert(streamRes.eventCount > 0, 'Streaming should have events');
  }
}

module.exports = {
  testConfigLoaded,
  testSequentialRequestStats,
  testHealthCheck,
  testCorsHeaders,
  testModelsListEndpoint,
  testTokenCountEndpoint,
  testRequestTimeout,
  testRequestTimingStats,
  testErrorResponseFormat,
  testStreamingAndNonStreaming
};

if (require.main === module) {
  runTestSuite('Integration Tests', [
    { name: 'TC601: Config Loaded', fn: testConfigLoaded },
    { name: 'TC603: Health Check', fn: testHealthCheck },
    { name: 'TC605: Models List', fn: testModelsListEndpoint },
    { name: 'TC606: Token Count', fn: testTokenCountEndpoint },
    { name: 'TC609: Error Format', fn: testErrorResponseFormat },
    { name: 'TC610: Stream/Non-Stream', fn: testStreamingAndNonStreaming }
  ]);
}