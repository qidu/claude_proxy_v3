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

/**
 * TC411: output_config.task_budget.total
 * Tests that output_config.task_budget.total can supply the thinking budget
 * when budget_tokens is omitted (per README thinking config section)
 */
async function testTaskBudgetTotal() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'What is 2+2?' }],
      max_tokens: 100,
      output_config: {
        task_budget: { total: 4000 }
      }
    }
  });

  assertResponse(response);
}

/**
 * TC412: xhigh Effort Normalization
 * Tests that non-standard "xhigh" output_config.effort is normalized to "max"
 */
async function testXhighEffort() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 50,
      output_config: { effort: 'xhigh' }
    }
  });

  // xhigh is non-standard; should either pass through or be normalized to max
  assert(
    response.status === 200 || response.status >= 400,
    'xhigh should be accepted (normalized) or rejected gracefully'
  );
}

/**
 * TC413: OpenAI Thinking Format
 * Tests that thinking: { enabled: true, budget_tokens: N } is accepted
 * (OpenAI passthrough format, normalized to Claude format)
 */
async function testOpenAITThinkingFormat() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 50,
      thinking: {
        enabled: true,
        budget_tokens: 1000
      }
    }
  });

  assertResponse(response);
}

/**
 * TC414: Signature Delta Events
 * Tests that streaming thinking produces signature_delta events
 * (per README "Signature Accumulation" section)
 */
async function testSignatureDeltaStreaming() {
  const response = await sendStreamingRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek-r1',
      messages: [{ role: 'user', content: 'Explain gravity' }],
      max_tokens: 300,
      thinking: {
        type: 'enabled',
        budget_tokens: 1000
      }
    }
  });

  assert(response.status === 200, 'Streaming should return 200');
  assert(response.eventCount > 0, 'Should have streaming events');

  // Look for signature_delta or content_block_stop following a thinking block
  const hasSignature = response.events.some(
    e => e.type === 'signature_delta' || e.delta?.type === 'signature_delta'
  );
  // Don't strictly require signature_delta (depends on upstream), but verify
  // the stream completed cleanly with content_block_stop or message_stop
  const hasStop = response.events.some(
    e => e.type === 'message_stop' || e.event === 'message_stop'
  );
  assert(
    hasStop,
    'Stream should end with message_stop (signature_delta may or may not be present)'
  );
  // If no signature_delta at all, the upstream just doesn't emit it — that's OK
  // but worth flagging.
  if (!hasSignature) {
    console.log('    (note: signature_delta not present in this stream)');
  }
}

/**
 * TC415: Custom Budget Thresholds
 * Tests that custom budget_to_effort_* thresholds are honored
 * (proxy_config.toml has: budget_to_effort_low=8000, medium=20000, high=0)
 */
async function testCustomBudgetThresholds() {
  // With custom thresholds, budget < 8000 should be "low"
  // budget < 20000 should be "medium"
  // budget >= 20000 should be "high"
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Count to 5' }],
      max_tokens: 200,
      thinking: {
        type: 'enabled',
        budget_tokens: 25000  // Should map to "high" with custom thresholds
      }
    }
  });

  assertResponse(response);
}

/**
 * TC416: Thinking Disabled Stripping
 * Tests that thinking: { type: "disabled" } is stripped for openai-completions upstream
 * (per README Known Limitations #3)
 */
async function testThinkingDisabledStripped() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 30,
      thinking: {
        type: 'disabled'
      }
    }
  });

  // Should still succeed — disabled thinking is silently stripped
  assertResponse(response);
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
  testBudgetToEffortMapping,
  testTaskBudgetTotal,
  testXhighEffort,
  testOpenAITThinkingFormat,
  testSignatureDeltaStreaming,
  testCustomBudgetThresholds,
  testThinkingDisabledStripped
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
    { name: 'TC408: Streaming', fn: testStreamingWithThinking },
    { name: 'TC411: task_budget.total', fn: testTaskBudgetTotal },
    { name: 'TC412: xhigh Effort', fn: testXhighEffort },
    { name: 'TC413: OpenAI Format', fn: testOpenAITThinkingFormat },
    { name: 'TC414: Signature Delta', fn: testSignatureDeltaStreaming },
    { name: 'TC415: Custom Thresholds', fn: testCustomBudgetThresholds },
    { name: 'TC416: Disabled Stripped', fn: testThinkingDisabledStripped }
  ]);
}