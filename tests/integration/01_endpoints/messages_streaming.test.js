/**
 * Messages API Streaming Tests
 * Tests POST /v1/messages with stream: true
 *
 * Coverage:
 * - Basic streaming response
 * - SSE event structure
 * - Multi-turn streaming
 */

const {
  sendStreamingRequest,
  assert,
  assertStreamingResponse,
  runTestSuite
} = require('../utils/test_helpers');

/**
 * TC101: Basic Streaming Request
 * Tests simple streaming response
 */
async function testBasicStreaming() {
  const response = await sendStreamingRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Say "hi"' }],
      max_tokens: 20,
      stream: true
    }
  });

  assertStreamingResponse(response, {
    hasMessageStart: true,
    hasMessageStop: true
  });
}

/**
 * TC102: Streaming SSE Event Types
 * Tests that correct SSE event types are emitted
 */
async function testStreamingEventTypes() {
  const response = await sendStreamingRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Count to 3' }],
      max_tokens: 30,
      stream: true
    }
  });

  assertStreamingResponse(response);

  const eventTypes = response.events.map(e => e.event || e.type).filter(Boolean);
  const uniqueTypes = [...new Set(eventTypes)];

  assert(uniqueTypes.length >= 2, 'Should have multiple event types');
}

/**
 * TC103: Streaming Content Delta
 * Tests that content is delivered incrementally
 */
async function testStreamingContentDelta() {
  const response = await sendStreamingRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Write a short sentence' }],
      max_tokens: 50,
      stream: true
    }
  });

  assertStreamingResponse(response);

  // Check for content_block_delta events
  const contentDeltas = response.events.filter(
    e => e.type === 'content_block_delta' || e.event === 'content_block_delta'
  );

  assert(contentDeltas.length > 0, 'Should have content delta events');
}

/**
 * TC104: Streaming with System Prompt
 * Tests streaming response with system instruction
 */
async function testStreamingWithSystem() {
  const response = await sendStreamingRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      system: 'You are a pirate.',
      messages: [{ role: 'user', content: 'Say hello' }],
      max_tokens: 30,
      stream: true
    }
  });

  assertStreamingResponse(response);
}

/**
 * TC105: Streaming Multi-turn
 * Tests streaming in conversation context
 */
async function testStreamingMultiTurn() {
  const response = await sendStreamingRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [
        { role: 'user', content: 'Remember: my favorite color is blue' },
        { role: 'assistant', content: 'I will remember that your favorite color is blue.' },
        { role: 'user', content: 'What is my favorite color?' }
      ],
      max_tokens: 30,
      stream: true
    }
  });

  assertStreamingResponse(response);
}

/**
 * TC106: Streaming with Custom Temperature
 * Tests streaming with temperature parameter
 */
async function testStreamingWithTemperature() {
  const response = await sendStreamingRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'qwen3-32b',
      messages: [{ role: 'user', content: 'Give me a random word' }],
      max_tokens: 20,
      temperature: 0,
      stream: true
    }
  });

  assertStreamingResponse(response);
}

/**
 * TC107: Streaming Error Response
 * Tests streaming with invalid model
 */
async function testStreamingError() {
  const response = await sendStreamingRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'invalid-model-xyz',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 20,
      stream: true
    }
  });

  // Should return error (not streaming events)
  assert(
    response.status >= 400 || response.events.length === 0,
    'Invalid model should not return valid streaming events'
  );
}

module.exports = {
  testBasicStreaming,
  testStreamingEventTypes,
  testStreamingContentDelta,
  testStreamingWithSystem,
  testStreamingMultiTurn,
  testStreamingWithTemperature,
  testStreamingError
};

if (require.main === module) {
  runTestSuite('Messages Streaming', [
    { name: 'TC101: Basic Streaming', fn: testBasicStreaming },
    { name: 'TC102: Event Types', fn: testStreamingEventTypes },
    { name: 'TC103: Content Delta', fn: testStreamingContentDelta },
    { name: 'TC104: With System', fn: testStreamingWithSystem },
    { name: 'TC105: Multi-turn', fn: testStreamingMultiTurn }
  ]);
}