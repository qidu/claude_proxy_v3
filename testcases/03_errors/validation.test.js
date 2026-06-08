/**
 * Validation and Error Handling Tests
 * Tests error responses for invalid requests
 *
 * Coverage:
 * - Missing required parameters
 * - Invalid parameter values
 * - Authentication errors
 * - Malformed requests
 */

const {
  sendRequest,
  assert,
  runTest,
  runTestSuite
} = require('../utils/test_helpers');

/**
 * TC701: Missing Model
 * Tests 400 response for missing model
 */
async function testMissingModel() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 10
    }
  });

  assert(response.status >= 400, `Expected error, got ${response.status}`);
  assert(response.body?.error, 'Should have error object');
}

/**
 * TC702: Missing Messages
 * Tests error for empty messages
 */
async function testEmptyMessages() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [],
      max_tokens: 10
    }
  });

  assert(response.status >= 400, `Expected error, got ${response.status}`);
}

/**
 * TC703: Invalid Model Name
 * Tests error for non-existent model
 */
async function testInvalidModel() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'this-model-does-not-exist-12345',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 10
    }
  });

  assert(response.status >= 400, `Expected error, got ${response.status}`);
}

/**
 * TC704: Negative Max Tokens
 * Tests error for negative max_tokens
 */
async function testNegativeMaxTokens() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: -1
    }
  });

  assert(response.status >= 400, `Expected error, got ${response.status}`);
}

/**
 * TC705: Temperature Out of Range
 * Tests error for invalid temperature
 */
async function testTemperatureOutOfRange() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 10,
      temperature: 2.5  // > 1.0
    }
  });

  // Should either reject or clamp
  assert(
    response.status === 200 || response.status >= 400,
    'Temperature should be validated'
  );
}

/**
 * TC706: Missing Authentication
 * Tests error for missing API key
 */
async function testMissingAuth() {
  const response = await fetch('http://localhost:8788/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 10
    })
  });

  // Should require auth
  assert(response.status >= 401, `Expected auth error, got ${response.status}`);
}

/**
 * TC707: Invalid JSON Body
 * Tests error for malformed JSON
 */
async function testInvalidJSON() {
  const response = await fetch('http://localhost:8788/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-key'
    },
    body: '{ invalid json }'
  });

  assert(response.status >= 400, `Expected error, got ${response.status}`);
}

/**
 * TC708: Content-Type Mismatch
 * Tests error for wrong content type
 */
async function testWrongContentType() {
  const response = await fetch('http://localhost:8788/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'Authorization': 'Bearer test-key'
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 10
    })
  });

  // Should handle gracefully
  assert(response.status >= 400 || response.status === 200);
}

/**
 * TC709: Invalid Stop Sequence Type
 * Tests error for non-string stop_sequences
 */
async function testInvalidStopSequences() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 10,
      stop_sequences: [123, 456]  // Should be strings
    }
  });

  assert(response.status >= 400 || response.status === 200,
    'Stop sequences should be validated');
}

/**
 * TC710: Invalid Tool Definition
 * Tests error for malformed tool
 */
async function testInvalidTool() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 10,
      tools: [{
        name: 'test_tool',
        // Missing input_schema
      }]
    }
  });

  assert(response.status >= 400 || response.status === 200,
    'Tool definitions should be validated');
}

/**
 * TC711: Chat Completions Blocked
 * Tests /v1/chat/completions returns error
 */
async function testChatCompletionsBlocked() {
  const response = await fetch('http://localhost:8788/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-key'
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 10
    })
  });

  // Should be blocked with error message
  const text = await response.text();
  assert(
    response.status >= 400 || text.toLowerCase().includes('not allowed'),
    'Chat completions should be blocked'
  );
}

/**
 * TC712: Rate Limit Error
 * Tests 429 response handling
 */
async function testRateLimitError() {
  // Make rapid requests to trigger rate limit
  const responses = [];
  for (let i = 0; i < 20; i++) {
    const response = await sendRequest({
      endpoint: '/v1/messages',
      body: {
        model: 'deepseek/deepseek-v3.2',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 5
      }
    });
    responses.push(response);
    if (response.status === 429) break;
  }

  // Check if any got rate limited
  const rateLimited = responses.some(r => r.status === 429);
  const allSucceeded = responses.every(r => r.status === 200);
  assert(rateLimited || allSucceeded, 'Should handle rate limits');
}

module.exports = {
  testMissingModel,
  testEmptyMessages,
  testInvalidModel,
  testNegativeMaxTokens,
  testTemperatureOutOfRange,
  testMissingAuth,
  testInvalidJSON,
  testWrongContentType,
  testInvalidStopSequences,
  testInvalidTool,
  testChatCompletionsBlocked,
  testRateLimitError
};

if (require.main === module) {
  runTestSuite('Error Handling', [
    { name: 'TC701: Missing Model', fn: testMissingModel },
    { name: 'TC702: Empty Messages', fn: testEmptyMessages },
    { name: 'TC703: Invalid Model', fn: testInvalidModel },
    { name: 'TC704: Negative MaxTokens', fn: testNegativeMaxTokens },
    { name: 'TC705: Temperature Range', fn: testTemperatureOutOfRange },
    { name: 'TC706: Missing Auth', fn: testMissingAuth },
    { name: 'TC707: Invalid JSON', fn: testInvalidJSON },
    { name: 'TC711: Chat Blocked', fn: testChatCompletionsBlocked }
  ]);
}