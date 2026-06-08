/**
 * Extended Thinking Tests
 * Tests thinking/reasoning configuration and behavior
 *
 * Coverage:
 * - Thinking enabled with budget
 * - Thinking disabled
 * - Boolean thinking format
 * - Adaptive thinking
 * - streaming with thinking
 * - reasoning_effort mapping
 */

const {
  sendRequest,
  sendStreamingRequest,
  assert,
  assertResponse,
  runTest,
  runTestSuite
} = require('../utils/test_helpers');

const { THINKING_MODELS } = require('../utils/model_config');

/**
 * TC401: Thinking Enabled with Budget
 * Tests thinking with token budget
 */
async function testThinkingEnabled() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek-r1',
      messages: [{
        role: 'user',
        content: 'Explain the theory of relativity'
      }],
      max_tokens: 500,
      thinking: {
        type: 'enabled',
        budget_tokens: 2000
      }
    }
  });

  assertResponse(response);
  // Thinking responses typically have stop_reason of end_turn
  assert(
    ['end_turn', 'max_tokens'].includes(response.body.stop_reason),
    'Stop reason should be valid'
  );
}

/**
 * TC402: Thinking Disabled
 * Tests explicit thinking disabled
 */
async function testThinkingDisabled() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{
        role: 'user',
        content: 'What is 2+2?'
      }],
      max_tokens: 20,
      thinking: {
        type: 'disabled'
      }
    }
  });

  assertResponse(response);
}

/**
 * TC403: Boolean Thinking Format
 * Tests boolean thinking type (true/false)
 */
async function testBooleanThinking() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek-r1',
      messages: [{
        role: 'user',
        content: 'What is machine learning?'
      }],
      max_tokens: 200,
      thinking: {
        type: true,
        budget_tokens: 1000
      }
    }
  });

  assertResponse(response);
}

/**
 * TC404: Adaptive Thinking
 * Tests adaptive thinking type
 */
async function testAdaptiveThinking() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{
        role: 'user',
        content: 'Explain quantum computing'
      }],
      max_tokens: 300,
      thinking: {
        type: 'adaptive'
      }
    }
  });

  assertResponse(response);
}

/**
 * TC405: reasoning_effort Parameter
 * Tests reasoning_effort for OpenAI-compatible models
 */
async function testReasoningEffort() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{
        role: 'user',
        content: 'Solve: x^2 - 5x + 6 = 0'
      }],
      max_tokens: 300,
      reasoning_effort: 'high'
    }
  });

  assertResponse(response);
}

/**
 * TC406: output_config.effort
 * Tests output_config.effort parameter
 */
async function testOutputConfigEffort() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{
        role: 'user',
        content: 'Explain photosynthesis'
      }],
      max_tokens: 300,
      output_config: {
        effort: 'medium'
      }
    }
  });

  assertResponse(response);
}

/**
 * TC407: Low Budget Thinking
 * Tests thinking with low token budget
 */
async function testLowBudgetThinking() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek-r1',
      messages: [{
        role: 'user',
        content: 'What is AI?'
      }],
      max_tokens: 100,
      thinking: {
        type: 'enabled',
        budget_tokens: 512
      }
    }
  });

  assertResponse(response);
}

/**
 * TC408: Streaming with Thinking
 * Tests SSE streaming with thinking enabled
 */
async function testStreamingWithThinking() {
  const response = await sendStreamingRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek-r1',
      messages: [{
        role: 'user',
        content: 'Explain recursion'
      }],
      max_tokens: 300,
      thinking: {
        type: 'enabled',
        budget_tokens: 1000
      },
      stream: true
    }
  });

  assert(response.status === 200, 'Streaming should return 200');
  assert(response.eventCount > 0, 'Should have streaming events');
}

/**
 * TC409: thinking disabled via false
 * Tests thinking: { type: false }
 */
async function testThinkingFalse() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek-r1',
      messages: [{
        role: 'user',
        content: 'What is 1+1?'
      }],
      max_tokens: 20,
      thinking: {
        type: false
      }
    }
  });

  assertResponse(response);
}

/**
 * TC410: Budget to Effort Mapping
 * Tests automatic budget to reasoning_effort conversion
 */
async function testBudgetToEffortMapping() {
  // High budget (>= 4096)
  const response1 = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 100,
      thinking: {
        type: 'enabled',
        budget_tokens: 5000
      }
    }
  });
  assertResponse(response1);

  // Low budget (< 2048)
  const response2 = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 100,
      thinking: {
        type: 'enabled',
        budget_tokens: 1000
      }
    }
  });
  assertResponse(response2);
}

module.exports = {
  testThinkingEnabled,
  testThinkingDisabled,
  testBooleanThinking,
  testAdaptiveThinking,
  testReasoningEffort,
  testOutputConfigEffort,
  testLowBudgetThinking,
  testStreamingWithThinking,
  testThinkingFalse,
  testBudgetToEffortMapping
};

if (require.main === module) {
  runTestSuite('Thinking Tests', [
    { name: 'TC401: Thinking Enabled', fn: testThinkingEnabled },
    { name: 'TC402: Thinking Disabled', fn: testThinkingDisabled },
    { name: 'TC403: Boolean Format', fn: testBooleanThinking },
    { name: 'TC404: Adaptive Thinking', fn: testAdaptiveThinking },
    { name: 'TC405: reasoning_effort', fn: testReasoningEffort },
    { name: 'TC406: output_config.effort', fn: testOutputConfigEffort },
    { name: 'TC407: Low Budget', fn: testLowBudgetThinking },
    { name: 'TC408: Streaming', fn: testStreamingWithThinking }
  ]);
}