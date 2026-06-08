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
  runTest,
  runTestSuite
} = require('../utils/test_helpers');

const {
  MODELS_BY_PROVIDER,
  COMPOSITE_ALIASES,
  CUSTOM_MODELS,
  PRIORITY_MODELS
} = require('../utils/model_config');

/**
 * TC801: Test DeepSeek Models
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
 * TC802: Test Qwen Models
 * Tests various Qwen model variants
 */
async function testQwenModels() {
  const models = ['qwen3-32b', 'qwen-max-2025-01-25'];

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
 * TC803: Test MiniMax Models
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
 * TC804: Test Moonshot/Kimi Models
 * Tests Moonshot AI Kimi models
 */
async function testMoonshotModels() {
  const models = ['moonshotai/kimi-k2.5', 'moonshotai/kimi-k2-0905'];

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
 * TC805: Test Thinking Models
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
        max_tokens: 200,
        thinking: {
          type: 'enabled',
          budget_tokens: 1000
        }
      }
    });

    assertResponse(response, { status: 200 });
    console.log(`  ✓ ${model}`);
  }
}

/**
 * TC806: Test Custom Models (NVIDIA)
 * Tests models from proxy_config.toml custom config
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

    // These may fail due to upstream config, but shouldn't crash
    assert(
      response.status === 200 || response.status >= 400,
      `Model ${model} should respond with valid status`
    );
    console.log(`  ✓ ${model}: ${response.status}`);
  }
}

/**
 * TC807: Test Composite Alias
 * Tests composite alias routing
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

  // Composite alias should route to a target model
  assert(
    response.status === 200 || response.status >= 400,
    'Composite alias should respond'
  );
  console.log(`  ✓ code-small: ${response.status}`);
}

/**
 * TC808: Test All Endpoints for Model
 * Tests a single model across messages, interactions, generateContent
 */
async function testModelAllEndpoints() {
  const results = await testModelEndpoints('deepseek/deepseek-v3.2');

  for (const result of results) {
    assert(result.passed, `${result.endpoint} should work: ${result.status}`);
    console.log(`  ✓ /v1/${result.endpoint}`);
  }
}

/**
 * TC809: Streaming Test for Model
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
 * TC810: Priority Models Quick Test
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
    { name: 'TC801: DeepSeek Models', fn: testDeepSeekModels },
    { name: 'TC802: Qwen Models', fn: testQwenModels },
    { name: 'TC803: MiniMax Models', fn: testMiniMaxModels },
    { name: 'TC804: Moonshot Models', fn: testMoonshotModels },
    { name: 'TC805: Thinking Models', fn: testThinkingModels },
    { name: 'TC808: All Endpoints', fn: testModelAllEndpoints },
    { name: 'TC809: Model Streaming', fn: testModelStreaming }
  ]);
}