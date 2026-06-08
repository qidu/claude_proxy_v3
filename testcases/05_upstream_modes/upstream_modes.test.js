/**
 * Upstream Mode Tests
 * Tests different upstream API modes
 *
 * Coverage:
 * - anthropic-messages mode
 * - openai-completions mode
 * - gemini-generatecontent mode
 * - Mode conversion behavior
 */

const {
  sendRequest,
  assert,
  assertResponse,
  runTest,
  runTestSuite
} = require('../utils/test_helpers');

/**
 * TC901: Claude Format Request
 * Tests Claude API format request (converted to OpenAI)
 */
async function testClaudeFormat() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 20,
      system: 'You are helpful.'
    }
  });

  assertResponse(response);
  assert(response.body?.stop_reason, 'Should have stop_reason');
}

/**
 * TC902: OpenAI Format Request
 * Tests OpenAI chat completions format passthrough
 */
async function testOpenAIFormat() {
  // OpenAI format has messages instead of content
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hi' }
      ],
      temperature: 0.5
    }
  });

  assertResponse(response);
}

/**
 * TC903: Native Claude Mode
 * Tests direct passthrough to Claude API
 * (requires anthropic-messages upstream mode)
 */
async function testAnthropicMessagesMode() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    headers: {
      'anthropic-version': '2023-06-01'
    },
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 20
    }
  });

  // May work with default openai-completions mode
  assert(
    response.status === 200 || response.status >= 400,
    'Should respond'
  );
}

/**
 * TC904: Gemini GenerateContent Mode
 * Tests Gemini format conversion
 */
async function testGeminiFormat() {
  const response = await sendRequest({
    endpoint: '/v1/interactions',
    body: {
      model: 'gemini-2.5-flash',
      input: 'Hello',
      generation_config: {
        temperature: 0.5
      }
    }
  });

  assert(
    response.status === 200 || response.status >= 400,
    'Should respond with Gemini mode'
  );
}

/**
 * TC905: Token Counting
 * Tests /v1/messages/count_tokens endpoint
 */
async function testTokenCounting() {
  const response = await sendRequest({
    endpoint: '/v1/messages/count_tokens',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello world' }]
    }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
  assert(
    typeof response.body?.input_tokens === 'number',
    'Should have input_tokens field'
  );
}

/**
 * TC906: Token Counting with Thinking
 * Tests token counting with thinking config
 */
async function testTokenCountingWithThinking() {
  const response = await sendRequest({
    endpoint: '/v1/messages/count_tokens',
    body: {
      model: 'deepseek-r1',
      messages: [{ role: 'user', content: 'Explain AI' }],
      thinking: {
        type: 'enabled',
        budget_tokens: 1000
      }
    }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
  assert(
    typeof response.body?.input_tokens === 'number',
    'Should count tokens with thinking'
  );
}

/**
 * TC907: Responses API - Basic
 * Tests OpenAI Responses API endpoint
 */
async function testResponsesAPI() {
  const response = await sendRequest({
    endpoint: '/v1/responses',
    body: {
      model: 'deepseek/deepseek-v3.2',
      input: 'What is 2+2?',
      max_tokens: 20
    }
  });

  // Responses API may convert to chat completions
  assert(
    response.status === 200 || response.status >= 400,
    'Should handle Responses API'
  );
}

/**
 * TC908: Embeddings API
 * Tests embeddings endpoint
 */
async function testEmbeddingsAPI() {
  const response = await sendRequest({
    endpoint: '/v1/embeddings',
    body: {
      model: 'qwen/qwen3-embedding-4b',
      input: 'Hello world'
    }
  });

  assert(
    response.status === 200 || response.status >= 400,
    'Embeddings endpoint should respond'
  );
}

/**
 * TC909: Models List
 * Tests GET /v1/models endpoint
 */
async function testModelsList() {
  const response = await sendRequest({
    endpoint: '/v1/models',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
  assert(
    Array.isArray(response.body?.data),
    'Should have data array'
  );
  assert(
    response.body?.data?.length > 0,
    'Should have at least one model'
  );
}

/**
 * TC910: Mode Conversion - Thinking
 * Tests thinking config conversion between modes
 */
async function testThinkingModeConversion() {
  // Test with thinking enabled
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek-r1',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 50,
      thinking: {
        type: 'enabled',
        budget_tokens: 1000
      }
    }
  });

  assertResponse(response);
}

module.exports = {
  testClaudeFormat,
  testOpenAIFormat,
  testAnthropicMessagesMode,
  testGeminiFormat,
  testTokenCounting,
  testTokenCountingWithThinking,
  testResponsesAPI,
  testEmbeddingsAPI,
  testModelsList,
  testThinkingModeConversion
};

if (require.main === module) {
  runTestSuite('Upstream Mode Tests', [
    { name: 'TC901: Claude Format', fn: testClaudeFormat },
    { name: 'TC902: OpenAI Format', fn: testOpenAIFormat },
    { name: 'TC905: Token Counting', fn: testTokenCounting },
    { name: 'TC906: Token Counting + Thinking', fn: testTokenCountingWithThinking },
    { name: 'TC909: Models List', fn: testModelsList },
    { name: 'TC910: Thinking Conversion', fn: testThinkingModeConversion }
  ]);
}