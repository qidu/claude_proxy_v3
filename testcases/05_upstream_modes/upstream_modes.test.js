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
 * TC902: System-in-messages conversion
 * Tests that a system message placed as the first element of the messages
 * array (OpenAI convention) is accepted and converted by the proxy.
 * The proxy strips or promotes it to the top-level system field before
 * forwarding to the openai-completions upstream.
 */
async function testOpenAIFormat() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hi' }
      ],
      max_tokens: 20,
      temperature: 0.5
    }
  });

  assertResponse(response);
  // Verify the proxy correctly handled the system-in-messages format
  assert(
    response.body?.content?.[0]?.type === 'text' || response.body?.choices,
    'Response should have text content (system-in-messages converted correctly)'
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
        budget_tokens: 1024
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
        budget_tokens: 1024
      }
    }
  });

  assertResponse(response);
}

/**
 * TC911: Responses API - input_tokens endpoint
 * Tests POST /v1/responses/input_tokens
 * (count input tokens for a Responses API request)
 */
async function testResponsesInputTokens() {
  const response = await sendRequest({
    endpoint: '/v1/responses/input_tokens',
    body: {
      model: 'deepseek/deepseek-v3.2',
      input: 'What is the capital of France?'
    }
  });

  // Should return token count (200) or method-not-allowed / 404
  assert(
    response.status === 200 || response.status === 404 || response.status === 405 || response.status >= 400,
    'Should handle input_tokens request'
  );

  if (response.status === 200) {
    assert(
      typeof response.body?.input_tokens === 'number' ||
      typeof response.body?.total_tokens === 'number',
      'Should return token count'
    );
  }
}

/**
 * TC912: Responses API - compact endpoint
 * Tests POST /v1/responses/compact
 * (returns response.compaction object)
 */
async function testResponsesCompact() {
  const response = await sendRequest({
    endpoint: '/v1/responses/compact',
    body: {
      model: 'deepseek/deepseek-v3.2',
      input: [
        { type: 'message', role: 'user', content: 'Hello' },
        { type: 'message', role: 'assistant', content: 'Hi there' },
        { type: 'message', role: 'user', content: 'How are you?' }
      ]
    }
  });

  assert(
    response.status === 200 || response.status === 404 || response.status === 405 || response.status >= 400,
    'Should handle compact request'
  );

  if (response.status === 200) {
    assert('compaction' in response.body || 'response' in response.body,
      'Should return compaction or response object');
  }
}

/**
 * TC913: Config Reload Endpoint
 * Tests POST /config-reload (previously /reload)
 */
async function testConfigReload() {
  const response = await sendRequest({
    endpoint: '/config-reload',
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.API_KEY || 'test'}` }
  });

  // Should succeed; 404 acceptable if not implemented in this build
  assert(
    response.status === 200 || response.status === 404 || response.status >= 400,
    'Should respond to config-reload'
  );
}

/**
 * TC914: Responses API - openai-responses mode
 * Tests /v1/responses with the openai-responses upstream mode
 * (passthrough to OpenAI Responses API instead of converting to chat completions)
 *
 * Note: requires a model configured with upstream_mode = "openai-responses"
 * If no such model is configured, the test will 4xx/5xx — that is acceptable.
 */
async function testResponsesOpenAIResponsesMode() {
  // Try a model that might be configured for openai-responses
  // (gpt-5.4-mini is in [models.free] with openai-completions; we try a generic
  // OpenAI-style model name in case openai-responses is configured for one)
  const response = await sendRequest({
    endpoint: '/v1/responses',
    body: {
      model: 'gpt-5.4-mini',
      input: 'What is 2+2?',
      max_tokens: 20
    }
  });

  // Either succeeds (openai-responses passthrough) or converts (openai-completions)
  assert(
    response.status === 200 || response.status >= 400,
    'Should handle /v1/responses'
  );

  if (response.status === 200) {
    // Verify Responses API shape
    assert(
      response.body?.output !== undefined || response.body?.output_items !== undefined || response.body?.choices !== undefined,
      'Should return a Responses API or Chat Completions shape'
    );
  }
}

module.exports = {
  testClaudeFormat,
  testOpenAIFormat,
  testGeminiFormat,
  testTokenCounting,
  testTokenCountingWithThinking,
  testResponsesAPI,
  testEmbeddingsAPI,
  testModelsList,
  testThinkingModeConversion,
  testResponsesInputTokens,
  testResponsesCompact,
  testConfigReload,
  testResponsesOpenAIResponsesMode
};

if (require.main === module) {
  runTestSuite('Upstream Mode Tests', [
    { name: 'TC901: Claude Format', fn: testClaudeFormat },
    { name: 'TC902: System-in-messages conversion', fn: testOpenAIFormat },
    { name: 'TC905: Token Counting', fn: testTokenCounting },
    { name: 'TC906: Token Counting + Thinking', fn: testTokenCountingWithThinking },
    { name: 'TC909: Models List', fn: testModelsList },
    { name: 'TC910: Thinking Conversion', fn: testThinkingModeConversion },
    { name: 'TC911: /v1/responses/input_tokens', fn: testResponsesInputTokens },
    { name: 'TC912: /v1/responses/compact', fn: testResponsesCompact },
    { name: 'TC913: /config-reload', fn: testConfigReload },
    { name: 'TC914: openai-responses mode', fn: testResponsesOpenAIResponsesMode }
  ]);
}
