/**
 * Test Helpers and Utilities
 * Common functions for all test cases
 */

const PROXY_URL = process.env.PROXY_URL || 'http://localhost:7777';
const API_KEY = process.env.API_KEY || 'sk-test-key';
const TIMEOUT = parseInt(process.env.TEST_TIMEOUT || '30000', 10);
// TEST_CONFIG prefix for the isolated test config file.
// The proxy loads ./${TEST_CONFIG}proxy_config.toml when this is set.
// Always force it into process.env so a directly-invoked test file
// (node testcases/.../foo.test.js) never silently targets the real
// proxy_config.toml just because TEST_CONFIG was unset/empty.
if (!process.env.TEST_CONFIG) process.env.TEST_CONFIG = 'test_';
const TEST_CONFIG = process.env.TEST_CONFIG;

/**
 * Send HTTP request with retry logic
 */
async function sendRequest(options) {
  const {
    method = 'POST',
    endpoint,
    headers = {},
    body,
    timeout = TIMEOUT,
    retries = 2
  } = options;

  const url = endpoint.startsWith('http') ? endpoint : `${PROXY_URL}${endpoint}`;
  const requestHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_KEY}`,
    ...headers
  };

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      const responseText = await response.text();
      let responseBody;
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = responseText;
      }

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
        text: responseText
      };
    } catch (error) {
      lastError = error;
      if (error.name === 'AbortError' && attempt < retries) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
    }
  }

  throw lastError;
}

/**
 * Send streaming request and collect SSE events
 */
async function sendStreamingRequest(options) {
  const {
    endpoint,
    headers = {},
    body,
    timeout = TIMEOUT
  } = options;

  const url = endpoint.startsWith('http') ? endpoint : `${PROXY_URL}${endpoint}`;
  const requestHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_KEY}`,
    ...headers
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  const response = await fetch(url, {
    method: 'POST',
    headers: requestHeaders,
    body: JSON.stringify({ ...body, stream: true }),
    signal: controller.signal
  });

  clearTimeout(timeoutId);

  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data.trim() && data !== '[DONE]') {
          try {
            events.push(JSON.parse(data));
          } catch {
            events.push({ raw: data });
          }
        }
      } else if (line.startsWith('event: ')) {
        events.push({ event: line.slice(7).trim() });
      }
    }
  }

  return {
    status: response.status,
    events,
    eventCount: events.length
  };
}

/**
 * Simple assertion helper
 */
function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

/**
 * Assert response has expected structure
 */
function assertResponse(response, options = {}) {
  const { status = 200, hasId = true, hasContent = true, hasUsage = true } = options;

  assert(response.status === status,
    `Expected status ${status}, got ${response.status}`);

  if (hasId) {
    assert(response.body?.id, 'Response should have id field');
  }

  if (hasContent) {
    assert(response.body?.content, 'Response should have content field');
  }

  if (hasUsage) {
    assert(response.body?.usage, 'Response should have usage field');
  }
}

/**
 * Assert streaming response has expected events
 */
function assertStreamingResponse(response, options = {}) {
  const {
    minEvents = 1,
    hasMessageStart = true,
    hasContentDelta = false,
    hasMessageStop = true
  } = options;

  assert(response.status === 200, 'Streaming should return 200');

  const eventTypes = response.events.map(e => e.event || e.type).filter(Boolean);
  const hasStart = eventTypes.includes('message_start') || response.events[0]?.type === 'message_start';
  const hasStop = eventTypes.includes('message_stop') || eventTypes.includes('done');

  if (hasMessageStart) {
    assert(hasStart, 'Should have message_start event');
  }

  if (hasMessageStop) {
    assert(hasStop, 'Should have message_stop event');
  }

  assert(response.eventCount >= minEvents,
    `Expected at least ${minEvents} events, got ${response.eventCount}`);
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run test with timing
 */
async function runTest(name, testFn) {
  const start = Date.now();
  try {
    await testFn();
    const duration = Date.now() - start;
    return { name, passed: true, duration, error: null };
  } catch (error) {
    const duration = Date.now() - start;
    return { name, passed: false, duration, error: error.message };
  }
}

/**
 * Run multiple tests and report results
 */
async function runTestSuite(name, tests) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Test Suite: ${name}`);
  console.log(`${'='.repeat(60)}`);

  const results = [];
  for (const test of tests) {
    const result = await runTest(test.name, test.fn);
    results.push(result);

    if (result.passed) {
      console.log(`  ✅ ${result.name} (${result.duration}ms)`);
    } else {
      console.log(`  ❌ ${result.name} (${result.duration}ms)`);
      console.log(`     Error: ${result.error}`);
    }
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(60)}\n`);

  // Fail loud: propagate failures to the runner via the process exit code.
  // Without this, run-tests.js (which counts suite child exit codes) reports
  // "0 failed" even when individual tests inside a suite failed.
  if (failed > 0) process.exitCode = 1;

  return { passed, failed, results };
}

/**
 * Test model across multiple endpoints
 */
async function testModelEndpoints(model, endpoints = ['messages', 'interactions', 'generateContent']) {
  const results = [];

  for (const endpoint of endpoints) {
    try {
      let response;
      switch (endpoint) {
        case 'messages':
          response = await sendRequest({
            endpoint: '/v1/messages',
            body: {
              model,
              messages: [{ role: 'user', content: 'Hi' }],
              max_tokens: 20
            }
          });
          break;

        case 'interactions':
          response = await sendRequest({
            endpoint: '/v1/interactions',
            body: {
              model,
              input: { messages: [{ role: 'user', content: 'Hi' }] }
            }
          });
          break;

        case 'generateContent':
          response = await sendRequest({
            endpoint: `/v1beta/models/${model}:generateContent`,
            body: {
              contents: [{ role: 'user', parts: [{ text: 'Hi' }] }]
            }
          });
          break;
      }

      results.push({
        endpoint,
        status: response.status,
        passed: response.status === 200
      });
    } catch (error) {
      results.push({
        endpoint,
        status: 0,
        passed: false,
        error: error.message
      });
    }
  }

  return results;
}

module.exports = {
  PROXY_URL,
  API_KEY,
  TIMEOUT,
  TEST_CONFIG,
  sendRequest,
  sendStreamingRequest,
  assert,
  assertResponse,
  assertStreamingResponse,
  sleep,
  runTest,
  runTestSuite,
  testModelEndpoints
};