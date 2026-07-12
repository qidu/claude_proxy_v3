/**
 * Model-Specific Tests
 * Tests various models from different providers
 *
 * Coverage:
 * - DeepSeek models
 * - Qwen models
 * - MiniMax models
 * - Moonshot/Kimi models
 * - NVIDIA models
 * - Composite aliases
 */

const {
  sendRequest,
  sendStreamingRequest,
  assert,
  assertResponse,
  testModelEndpoints,
  runTestSuite
} = require('../utils/test_helpers');

const {
  MODELS_BY_PROVIDER,
  COMPOSITE_ALIASES,
  CUSTOM_MODELS,
  PRIORITY_MODELS
} = require('../utils/model_config');

/**
 * TC401: Test DeepSeek Models
 * Tests DeepSeek V3 and R1 models
 */
async function testDeepSeekModels() {
  const models = ['deepseek/deepseek-v3.2', 'deepseek-r1'];

  for (const model of models) {
    const response = await sendRequest({
      endpoint: '/v1/messages',
      body: {
        model,
        messages: [{ role: 'user', content: 'Say "ok"' }],
        max_tokens: 10
      }
    });

    assertResponse(response, { status: 200 });
    console.log(`  ✓ ${model}`);
  }
}

/**
 * TC402: Test Qwen Models
 * Tests various Qwen model variants
 */
async function testQwenModels() {
  const models = ['qwen/qwen3.6-plus', 'qwen/qwen3.7-max'];

  for (const model of models) {
    const response = await sendRequest({
      endpoint: '/v1/messages',
      body: {
        model,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 20
      }
    });

    assertResponse(response, { status: 200 });
    console.log(`  ✓ ${model}`);
  }
}

/**
 * TC403: Test MiniMax Models
 * Tests MiniMax model variants
 */
async function testMiniMaxModels() {
  const models = ['minimax/minimax-m2.1', 'minimax/minimax-m2.5'];

  for (const model of models) {
    const response = await sendRequest({
      endpoint: '/v1/messages',
      body: {
        model,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 20
      }
    });

    assertResponse(response, { status: 200 });
    console.log(`  ✓ ${model}`);
  }
}

/**
 * TC404: Test Moonshot/Kimi Models
 * Tests Moonshot AI Kimi models
 */
async function testMoonshotModels() {
  const models = ['moonshotai/kimi-k2.6', 'moonshotai/kimi-k2.7-code'];

  for (const model of models) {
    const response = await sendRequest({
      endpoint: '/v1/messages',
      body: {
        model,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 20
      }
    });

    assertResponse(response, { status: 200 });
    console.log(`  ✓ ${model}`);
  }
}

/**
 * TC405: Test Thinking Models
 * Tests models with thinking/reasoning support
 */
async function testThinkingModels() {
  const models = ['deepseek-r1', 'deepseek/deepseek-v3.2-exp-thinking'];

  for (const model of models) {
    const response = await sendRequest({
      endpoint: '/v1/messages',
      body: {
        model,
        messages: [{ role: 'user', content: 'Explain recursion' }],
        max_tokens: 1024,
        thinking: {
          type: 'enabled',
          budget_tokens: 1024
        }
      }
    });

    assertResponse(response, { status: 200 });
    console.log(`  ✓ ${model}`);
  }
}

/**
 * TC406: Test Custom Models (NVIDIA)
 * Tests models from proxy_config.toml custom config.
 * These models require NVIDIA API keys; the proxy must either route them
 * successfully (200) or return a structured error (4xx) — not crash (5xx).
 */
async function testCustomModels() {
  const models = [
    'nvidia/nemotron-3-ultra-550b-a55b',
    'nvidia/nemotron-3-super-120b-a12b'
  ];

  for (const model of models) {
    const response = await sendRequest({
      endpoint: '/v1/messages',
      body: {
        model,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 10
      }
    });

    // Must not be a proxy-internal crash (5xx from our own code)
    assert(
      response.status !== 500,
      `Model ${model} should not return 500 (proxy crash)`
    );
    // Should be upstream success or a structured auth/config error (not a proxy 5xx)
    assert(
      response.status === 200 || (response.status >= 400 && response.status < 500),
      `Model ${model} should respond with 200 or 4xx, got ${response.status}`
    );
    if (response.status >= 400) {
      assert(
        response.body?.error || response.body?.message,
        `Error response for ${model} should have error or message field`
      );
    }
    console.log(`  ✓ ${model}: ${response.status}`);
  }
}

/**
 * TC407: Test Composite Alias Routing
 * Tests that the code-small composite alias resolves and routes to a
 * configured target — the proxy must not return 404 (unknown route) or
 * 500 (internal error). A 200 proves the alias routed; a 4xx from upstream
 * (auth/quota) is also acceptable.
 */
async function testCompositeAlias() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'code-small',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 10
    }
  });

  assert(
    response.status !== 404,
    'Composite alias code-small should be recognized by the proxy (got 404 = unknown route)'
  );
  assert(
    response.status < 500,
    `Composite alias code-small should not cause a proxy internal error (got ${response.status})`
  );
  console.log(`  ✓ code-small: ${response.status}`);
}

/**
 * TC408: Test All Endpoints for Model
 * Tests a single model across messages, interactions, generateContent
 * model.default.upstream_mode should be 'openai-completions' 
 */
async function testModelAllEndpoints() {
  const results = await testModelEndpoints('deepseek/deepseek-v4-flash');

  for (const result of results) {
    assert(result.passed, `${result.endpoint} should work: ${result.status}`);
    console.log(`  ✓ /v1/${result.endpoint}`);
  }
}

/**
 * TC409: Streaming Test for Model
 * Tests streaming for specific model
 */
async function testModelStreaming() {
  const response = await sendStreamingRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'qwen3-32b',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 30,
      stream: true
    }
  });

  assert(response.status === 200, 'Streaming should work');
  assert(response.eventCount > 0, 'Should have events');
  console.log(`  ✓ Streaming with ${response.eventCount} events`);
}

/**
 * TC410: Priority Models Quick Test
 * Tests the most important models quickly
 */
async function testPriorityModels() {
  const allPassed = [];

  for (const model of PRIORITY_MODELS.tier1) {
    const response = await sendRequest({
      endpoint: '/v1/messages',
      body: {
        model,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 10
      }
    });

    const passed = response.status === 200;
    allPassed.push({ model, passed });
    console.log(`  ${passed ? '✓' : '✗'} ${model}`);
  }

  const failedCount = allPassed.filter(r => !r.passed).length;
  console.log(`\n  ${allPassed.length - failedCount}/${allPassed.length} models passed`);
}

module.exports = {
  testDeepSeekModels,
  testQwenModels,
  testMiniMaxModels,
  testMoonshotModels,
  testThinkingModels,
  testCustomModels,
  testCompositeAlias,
  testModelAllEndpoints,
  testModelStreaming,
  testPriorityModels
};

if (require.main === module) {
  runTestSuite('Model Tests', [
    { name: 'TC401: DeepSeek Models', fn: testDeepSeekModels },
    { name: 'TC402: Qwen Models', fn: testQwenModels },
    { name: 'TC403: MiniMax Models', fn: testMiniMaxModels },
    { name: 'TC404: Moonshot Models', fn: testMoonshotModels },
    { name: 'TC405: Thinking Models', fn: testThinkingModels },
    { name: 'TC408: All Endpoints', fn: testModelAllEndpoints },
    { name: 'TC409: Model Streaming', fn: testModelStreaming }
  ]);
}
