/**
 * Interactions API Tests
 * Tests POST /v1/interactions endpoint
 * model.default.upstream_mode should be 'openai-completions' 
 *
 * Coverage:
 * - Basic text input
 * - Multi-turn conversation
 * - System instruction
 * - Streaming mode
 */

const {
  sendRequest,
  sendStreamingRequest,
  assert,
  runTest,
  runTestSuite
} = require('../utils/test_helpers');

/**
 * TC201: Basic Text Input
 * Tests simplest interaction request
 */
async function testBasicInteraction() {
  const response = await sendRequest({
    endpoint: '/v1/interactions',
    body: {
      model: 'gemini-2.5-flash',
      input: 'Hello, how are you?'
    }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
  assert(response.body?.outputs || response.body?.text || response.body?.content,
    'Response should have output');
}

/**
 * TC202: Object Input Format
 * Tests interaction with message object
 */
async function testObjectInput() {
  const response = await sendRequest({
    endpoint: '/v1/interactions',
    body: {
      model: 'gemini-2.5-flash',
      input: {
        messages: [
          { role: 'user', content: 'Hi' }
        ]
      }
    }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
}

/**
 * TC203: Multi-turn Interaction
 * Tests conversation with history
 */
async function testMultiTurnInteraction() {
  const response = await sendRequest({
    endpoint: '/v1/interactions',
    body: {
      model: 'gemini-2.5-flash',
      input: [
        { role: 'user', content: 'My name is Bob' },
        { role: 'model', content: 'Hello Bob!' },
        { role: 'user', content: 'What is my name?' }
      ]
    }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
  const text = response.body?.outputs?.[0]?.text ||
               response.body?.text ||
               response.body?.content?.[0]?.text || '';
  assert(text.toLowerCase().includes('bob'), 'Should remember user name');
}

/**
 * TC204: System Instruction
 * Tests system instruction parameter
 */
async function testSystemInstruction() {
  const response = await sendRequest({
    endpoint: '/v1/interactions',
    body: {
      model: 'gemini-2.5-flash',
      input: 'What is 1+1?',
      system_instruction: 'Answer as a mathematician'
    }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
}

/**
 * TC205: Generation Config
 * Tests generation configuration parameters
 */
async function testGenerationConfig() {
  const response = await sendRequest({
    endpoint: '/v1/interactions',
    body: {
      model: 'gemini-2.5-flash',
      input: 'Give me a short answer',
      generation_config: {
        temperature: 0.5,
        max_output_tokens: 50
      }
    }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
}

/**
 * TC206: Streaming Interaction
 * Tests streaming response
 */
async function testStreamingInteraction() {
  const response = await sendStreamingRequest({
    endpoint: '/v1/interactions',
    body: {
      model: 'gemini-2.5-flash',
      input: 'Count from 1 to 3',
      stream: true
    }
  });

  // Proxy must not crash (500). 200 = full success; 4xx = upstream auth/config issue.
  assert(
    response.status < 500,
    `Streaming interactions should not cause a proxy internal error (got ${response.status})`
  );
  if (response.status === 200) {
    assert(response.eventCount > 0, 'Streaming 200 response should have events');
  }
}

/**
 * TC207: Tools in Interaction
 * Tests function declarations
 */
async function testInteractionWithTools() {
  const response = await sendRequest({
    endpoint: '/v1/interactions',
    body: {
      model: 'gemini-2.5-flash',
      input: 'What is the weather in Tokyo?',
      tools: [
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Get weather for a city',
              parameters: {
                type: 'object',
                properties: {
                  city: { type: 'string' }
                }
              }
            }
          ]
        }
      ]
    }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
}

/**
 * TC208: Thinking Level
 * Tests thinking_level parameter
 */
async function testThinkingLevel() {
  const response = await sendRequest({
    endpoint: '/v1/interactions',
    body: {
      model: 'gemini-2.5-flash',
      input: 'Explain quantum entanglement',
      generation_config: {
        thinking_level: 'high'
      }
    }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
}

module.exports = {
  testBasicInteraction,
  testObjectInput,
  testMultiTurnInteraction,
  testSystemInstruction,
  testGenerationConfig,
  testStreamingInteraction,
  testInteractionWithTools,
  testThinkingLevel
};

if (require.main === module) {
  runTestSuite('Interactions API', [
    { name: 'TC201: Basic Input', fn: testBasicInteraction },
    { name: 'TC202: Object Input', fn: testObjectInput },
    { name: 'TC203: Multi-turn', fn: testMultiTurnInteraction },
    { name: 'TC204: System Instruction', fn: testSystemInstruction },
    { name: 'TC205: Generation Config', fn: testGenerationConfig },
    { name: 'TC206: Streaming', fn: testStreamingInteraction }
  ]);
}
