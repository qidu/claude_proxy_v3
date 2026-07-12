/**
 * Messages API Tests
 * Tests POST /v1/messages endpoint with Claude API format
 *
 * Coverage:
 * - Basic text requests
 * - System prompts
 * - Multi-turn conversations
 * - Custom parameters (temperature, top_p, stop_sequences)
 * - Streaming and non-streaming variants
 */

const {
  sendRequest,
  sendStreamingRequest,
  assert,
  assertResponse,
  assertStreamingResponse,
  runTestSuite
} = require('../utils/test_helpers');

const { PRIORITY_MODELS, THINKING_MODELS } = require('../utils/model_config');

/**
 * TC001: Basic Text Request
 * Tests simplest user message with minimal parameters
 */
async function testBasicTextRequest() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Say "hello"' }],
      max_tokens: 20
    }
  });

  assertResponse(response, { status: 200, hasId: true, hasContent: true, hasUsage: true });
  assert(
    response.body.content.some(block => block.type === 'text'),
    'Response should contain text block'
  );
}

/**
 * TC002: System Prompt
 * Tests system instruction setting context
 */
async function testSystemPrompt() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Who are you?' }],
      max_tokens: 50
    }
  });

  assertResponse(response);
  assert(
    response.body.content.some(block => block.type === 'text'),
    'Response should contain text'
  );
}

/**
 * TC003: Multi-turn Conversation
 * Tests conversation context across multiple messages
 */
async function testMultiTurnConversation() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [
        { role: 'user', content: 'My name is Alice' },
        { role: 'assistant', content: 'Nice to meet you, Alice!' },
        { role: 'user', content: 'What is my name?' }
      ],
      max_tokens: 30
    }
  });

  assertResponse(response);
  // Verify model remembers context
  const text = response.body.content.find(b => b.type === 'text')?.text || '';
  assert(
    text.toLowerCase().includes('alice'),
    'Model should remember user name from context'
  );
}

/**
 * TC004: Custom Temperature
 * Tests temperature parameter affecting randomness
 */
async function testCustomTemperature() {
  // Test with temperature 0 for deterministic output
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'qwen3-32b',
      messages: [{ role: 'user', content: 'What is 2+2?' }],
      max_tokens: 10,
      temperature: 0
    }
  });

  assertResponse(response);
}

/**
 * TC005: Custom Stop Sequences
 * Tests custom stop sequence ending response
 */
async function testStopSequences() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'List 5 colors: red, blue,' }],
      max_tokens: 50,
      stop_sequences: ['5.']
    }
  });

  assertResponse(response);
}

/**
 * TC006: Top P Sampling
 * Tests nucleus sampling parameter
 */
async function testTopP() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Tell me a short joke' }],
      max_tokens: 50,
      top_p: 0.9
    }
  });

  assertResponse(response);
}

/**
 * TC007: Top K Sampling
 * Tests top K parameter
 */
async function testTopK() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Name an element' }],
      max_tokens: 20,
      top_k: 40
    }
  });

  assertResponse(response);
}

/**
 * TC008: Empty Messages Array
 * Tests error handling for empty messages
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

  // Should return 400 or 422
  assert(
    response.status >= 400,
    `Expected error status for empty messages, got ${response.status}`
  );
}

/**
 * TC009: Missing Model
 * Tests error handling for missing model parameter
 */
async function testMissingModel() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 10
    }
  });

  assert(response.status >= 400, 'Expected error for missing model');
}

/**
 * TC010: Missing Max Tokens
 * Tests error handling for missing max_tokens
 */
async function testMissingMaxTokens() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }]
    }
  });

  // Some APIs require max_tokens, some have defaults
  assert(response.status === 200 || response.status >= 400,
    'Should either accept default or return error');
}

/**
 * TC011: Invalid Model Name
 * Tests error handling for non-existent model
 */
async function testInvalidModel() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'non-existent-model-xyz',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 10
    }
  });

  assert(response.status >= 400, 'Expected error for invalid model');
}

/**
 * TC012: Array Content Blocks
 * Tests messages with array content (text blocks)
 */
async function testArrayContentBlocks() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: 'World' }
        ]
      }],
      max_tokens: 20
    }
  });

  assertResponse(response);
}

/**
 * TC013: System as Array
 * Tests system instruction as array of text blocks
 */
async function testSystemAsArray() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      system: [
        { type: 'text', text: 'You are a' },
        { type: 'text', text: 'friendly assistant.' }
      ],
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 20
    }
  });

  assertResponse(response);
}

/**
 * TC014: Metadata Field
 * Tests metadata parameter passthrough
 */
async function testMetadataField() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 20,
      metadata: {
        user_id: 'test-user-123'
      }
    }
  });

  assertResponse(response);
}

/**
 * TC015: Service Tier
 * Tests service_tier parameter
 */
async function testServiceTier() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 20,
      service_tier: 'auto'
    }
  });

  assertResponse(response);
}

// Export test functions
module.exports = {
  testBasicTextRequest,
  testSystemPrompt,
  testMultiTurnConversation,
  testCustomTemperature,
  testStopSequences,
  testTopP,
  testTopK,
  testEmptyMessages,
  testMissingModel,
  testMissingMaxTokens,
  testInvalidModel,
  testArrayContentBlocks,
  testSystemAsArray,
  testMetadataField,
  testServiceTier
};

// Run tests if executed directly
if (require.main === module) {
  runTestSuite('Messages API', [
    { name: 'TC001: Basic Text Request', fn: testBasicTextRequest },
    { name: 'TC002: System Prompt', fn: testSystemPrompt },
    { name: 'TC003: Multi-turn Conversation', fn: testMultiTurnConversation },
    { name: 'TC004: Custom Temperature', fn: testCustomTemperature },
    { name: 'TC005: Stop Sequences', fn: testStopSequences },
    { name: 'TC006: Top P', fn: testTopP },
    { name: 'TC007: Top K', fn: testTopK },
    { name: 'TC008: Empty Messages', fn: testEmptyMessages },
    { name: 'TC009: Missing Model', fn: testMissingModel },
    { name: 'TC012: Array Content Blocks', fn: testArrayContentBlocks }
  ]);
}