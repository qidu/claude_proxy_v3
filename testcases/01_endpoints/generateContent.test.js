/**
 * GenerateContent API Tests
 * Tests POST /v1beta/models/{model}:generateContent endpoint
 *
 * Coverage:
 * - Text content
 * - Multimodal content
 * - Generation config
 * - Streaming variants
 */

const {
  sendRequest,
  sendStreamingRequest,
  assert,
  runTest,
  runTestSuite
} = require('../utils/test_helpers');

/**
 * TC301: Basic Text Generation
 * Tests simple text generation
 */
async function testBasicGenerateContent() {
  const response = await sendRequest({
    endpoint: '/v1beta/models/gemini-2.5-flash:generateContent',
    body: {
      contents: [{
        role: 'user',
        parts: [{ text: 'Hello, how are you?' }]
      }]
    }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
  assert(response.body?.candidates, 'Should have candidates');
}

/**
 * TC302: Generation Config
 * Tests generation parameters
 */
async function testGenerateContentWithConfig() {
  const response = await sendRequest({
    endpoint: '/v1beta/models/gemini-2.5-flash:generateContent',
    body: {
      contents: [{
        role: 'user',
        parts: [{ text: 'What is 2+2?' }]
      }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 50,
        topP: 0.8
      }
    }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
}

/**
 * TC303: Safety Settings
 * Tests safety settings configuration
 */
async function testGenerateContentWithSafety() {
  const response = await sendRequest({
    endpoint: '/v1beta/models/gemini-2.5-flash:generateContent',
    body: {
      contents: [{
        role: 'user',
        parts: [{ text: 'Hello' }]
      }],
      safetySettings: [
        {
          category: 'HARM_CATEGORY_HARASSMENT',
          threshold: 'BLOCK_MEDIUM_AND_ABOVE'
        }
      ]
    }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
}

/**
 * TC304: System Instruction
 * Tests system instruction
 */
async function testGenerateContentWithSystemInstruction() {
  const response = await sendRequest({
    endpoint: '/v1beta/models/gemini-2.5-flash:generateContent',
    body: {
      contents: [{
        role: 'user',
        parts: [{ text: 'Who are you?' }]
      }],
      systemInstruction: {
        parts: [{ text: 'You are a helpful assistant.' }]
      }
    }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
}

/**
 * TC305: Tools in GenerateContent
 * Tests function declarations
 */
async function testGenerateContentWithTools() {
  const response = await sendRequest({
    endpoint: '/v1beta/models/gemini-2.5-flash:generateContent',
    body: {
      contents: [{
        role: 'user',
        parts: [{ text: 'What is the weather in Paris?' }]
      }],
      tools: [{
        functionDeclarations: [{
          name: 'get_weather',
          description: 'Get weather for a city',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string' }
            }
          }
        }]
      }]
    }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
}

/**
 * TC306: Streaming GenerateContent
 * Tests streaming response
 */
async function testStreamingGenerateContent() {
  const response = await sendRequest({
    endpoint: '/v1beta/models/gemini-2.5-flash:streamGenerateContent',
    body: {
      contents: [{
        role: 'user',
        parts: [{ text: 'Write a short poem' }]
      }]
    }
  });

  assert(response.status === 200, 'Stream should return 200');
}

/**
 * TC307: Multi-turn in GenerateContent
 * Tests conversation history
 */
async function testMultiTurnGenerateContent() {
  const response = await sendRequest({
    endpoint: '/v1beta/models/gemini-2.5-flash:generateContent',
    body: {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'My favorite color is red' }]
        },
        {
          role: 'model',
          parts: [{ text: 'I will remember that.' }]
        },
        {
          role: 'user',
          parts: [{ text: 'What is my favorite color?' }]
        }
      ]
    }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
  const text = response.body?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  assert(text.toLowerCase().includes('red'), 'Should remember color');
}

/**
 * TC308: v1 Endpoint (not v1beta)
 * Tests alternative endpoint path
 */
async function testV1Endpoint() {
  const response = await sendRequest({
    endpoint: '/v1/models/gemini-2.5-flash:generateContent',
    body: {
      contents: [{
        role: 'user',
        parts: [{ text: 'Hi' }]
      }]
    }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
}

/**
 * TC309: v1beta streamGenerateContent with SSE validation
 * Tests that /v1beta/models/{model}:streamGenerateContent actually streams SSE events
 * (regression for TC306 which only used sendRequest, never validated the stream)
 */
async function testV1BetaStreamGenerateContentStreaming() {
  const response = await sendStreamingRequest({
    endpoint: '/v1beta/models/gemini-2.5-flash:streamGenerateContent',
    body: {
      contents: [{
        role: 'user',
        parts: [{ text: 'Write a short poem' }]
      }]
    }
  });

  // Proxy must not crash (500). 200 = full success; 4xx = upstream auth/config issue.
  assert(
    response.status < 500,
    `v1beta streamGenerateContent should not cause a proxy internal error (got ${response.status})`
  );
  if (response.status === 200) {
    assert(response.eventCount > 0, 'Should produce SSE events');
    // At least one event should be a Gemini-style candidates chunk
    const hasCandidates = response.events.some(e => e.candidates);
    const hasTyped = response.events.some(e => e.type);
    assert(
      hasCandidates || hasTyped,
      'SSE stream should include at least one Gemini candidates chunk or typed event'
    );
  }
}

/**
 * TC310: v1 streamGenerateContent with SSE validation
 * Tests the alternative /v1/models/{model}:streamGenerateContent endpoint
 */
async function testV1StreamGenerateContentStreaming() {
  const response = await sendStreamingRequest({
    endpoint: '/v1/models/gemini-2.5-flash:streamGenerateContent',
    body: {
      contents: [{
        role: 'user',
        parts: [{ text: 'Say hello' }]
      }]
    }
  });

  assert(
    response.status < 500,
    `v1 streamGenerateContent should not cause a proxy internal error (got ${response.status})`
  );
  if (response.status === 200) {
    assert(response.eventCount > 0, 'Should produce SSE events');
  }
}

/**
 * TC311: Token counting endpoint
 *
 * The proxy exposes count tokens via /v1/messages/count_tokens (Claude format).
 * It internally rewrites to /v1/chat/completions for OpenAI-compatible
 * upstreams that don't have a native count_tokens endpoint (e.g. qnaigc).
 * Tests that an upstream with no native count_tokens still returns a count.
 */
async function testV1BetaCountTokens() {
  const response = await sendRequest({
    endpoint: '/v1/messages/count_tokens',
    body: {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Hello world, how are you?' }]
    }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
  assert(
    typeof response.body?.input_tokens === 'number',
    `Should return input_tokens, got: ${JSON.stringify(response.body)}`
  );
}

/**
 * TC312: Token counting endpoint (v1 alias)
 */
async function testV1CountTokens() {
  const response = await sendRequest({
    endpoint: '/v1/messages/count_tokens',
    body: {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'Hello' }]
    }
  });

  assert(response.status === 200, `Expected 200, got ${response.status}`);
}

module.exports = {
  testBasicGenerateContent,
  testGenerateContentWithConfig,
  testGenerateContentWithSafety,
  testGenerateContentWithSystemInstruction,
  testGenerateContentWithTools,
  testStreamingGenerateContent,
  testMultiTurnGenerateContent,
  testV1Endpoint,
  testV1BetaStreamGenerateContentStreaming,
  testV1StreamGenerateContentStreaming,
  testV1BetaCountTokens,
  testV1CountTokens
};

if (require.main === module) {
  runTestSuite('GenerateContent API', [
    { name: 'TC301: Basic Generation', fn: testBasicGenerateContent },
    { name: 'TC302: Generation Config', fn: testGenerateContentWithConfig },
    { name: 'TC303: Safety Settings', fn: testGenerateContentWithSafety },
    { name: 'TC304: System Instruction', fn: testGenerateContentWithSystemInstruction },
    { name: 'TC305: With Tools', fn: testGenerateContentWithTools },
    { name: 'TC307: Multi-turn', fn: testMultiTurnGenerateContent },
    { name: 'TC308: v1 Endpoint', fn: testV1Endpoint },
    { name: 'TC309: v1beta streamGenerateContent (SSE)', fn: testV1BetaStreamGenerateContentStreaming },
    { name: 'TC310: v1 streamGenerateContent (SSE)', fn: testV1StreamGenerateContentStreaming },
    { name: 'TC311: :countTokens', fn: testV1BetaCountTokens }
  ]);
}