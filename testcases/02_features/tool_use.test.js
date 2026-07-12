/**
 * Tool Use / Function Calling Tests
 * Tests tool/function calling functionality
 *
 * Coverage:
 * - Basic tool use
 * - Tool with input schema
 * - tool_choice: auto
 * - tool_choice: any
 * - tool_choice: tool name
 * - tool_choice: none
 * - Streaming with tools
 */

const {
  sendRequest,
  sendStreamingRequest,
  assert,
  assertResponse,
  runTestSuite
} = require('../utils/test_helpers');

const { TOOL_CAPABLE_MODELS } = require('../utils/model_config');

/**
 * Standard weather tool definition
 */
const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Get current weather for a location',
  input_schema: {
    type: 'object',
    properties: {
      location: {
        type: 'string',
        description: 'City name'
      }
    },
    required: ['location']
  }
};

/**
 * Calculator tool definition
 */
const CALCULATOR_TOOL = {
  name: 'calculate',
  description: 'Perform a calculation',
  input_schema: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'Math expression (e.g., "2+2")'
      }
    },
    required: ['expression']
  }
};

/**
 * TC501: Basic Tool Use
 * Tests simple tool invocation
 */
async function testBasicToolUse() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{
        role: 'user',
        content: 'What is the weather in San Francisco?'
      }],
      max_tokens: 200,
      tools: [WEATHER_TOOL]
    }
  });

  assertResponse(response);
  // Should either return text or tool_use
  assert(
    response.body.content.some(b => b.type === 'text' || b.type === 'tool_use'),
    'Should have text or tool_use block'
  );
}

/**
 * TC502: tool_choice: auto
 * Tests model decides whether to use tool
 */
async function testToolChoiceAuto() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'qwen3-32b',
      messages: [{
        role: 'user',
        content: 'Hello'
      }],
      max_tokens: 50,
      tools: [WEATHER_TOOL],
      tool_choice: { type: 'auto' }
    }
  });

  assertResponse(response);
}

/**
 * TC503: tool_choice: any
 * Tests forcing tool use
 */
async function testToolChoiceAny() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'qwen3-32b',
      messages: [{
        role: 'user',
        content: 'What is 2+2?'
      }],
      max_tokens: 100,
      tools: [CALCULATOR_TOOL],
      tool_choice: { type: 'any' }
    }
  });

  assertResponse(response);
}

/**
 * TC504: tool_choice: specific tool
 * Tests specifying exact tool to use
 */
async function testToolChoiceSpecific() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'qwen3-32b',
      messages: [{
        role: 'user',
        content: 'What is the weather like?'
      }],
      max_tokens: 100,
      tools: [WEATHER_TOOL, CALCULATOR_TOOL],
      tool_choice: { type: 'tool', name: 'get_weather' }
    }
  });

  assertResponse(response);
}

/**
 * TC505: tool_choice: none
 * Tests disabling tool use
 */
async function testToolChoiceNone() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'qwen3-32b',
      messages: [{
        role: 'user',
        content: 'Hello, how are you?'
      }],
      max_tokens: 50,
      tools: [WEATHER_TOOL],
      tool_choice: { type: 'none' }
    }
  });

  assertResponse(response);
  // Should only return text, no tool_use
  const hasToolUse = response.body.content.some(b => b.type === 'tool_use');
  assert(!hasToolUse, 'Should not use tool when tool_choice is none');
}

/**
 * TC506: Multiple Tools
 * Tests request with multiple tool definitions
 */
async function testMultipleTools() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{
        role: 'user',
        content: 'Calculate 5*10 and get weather in Tokyo'
      }],
      max_tokens: 200,
      tools: [WEATHER_TOOL, CALCULATOR_TOOL]
    }
  });

  assertResponse(response);
}

/**
 * TC507: Streaming with Tools
 * Tests SSE streaming with tool use
 */
async function testStreamingWithTools() {
  const response = await sendStreamingRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'qwen3-32b',
      messages: [{
        role: 'user',
        content: 'What is 10+10?'
      }],
      max_tokens: 100,
      tools: [CALCULATOR_TOOL],
      stream: true
    }
  });

  assert(response.status === 200, 'Streaming should return 200');
  assert(response.eventCount > 0, 'Should have streaming events');
}

/**
 * TC508: Tool Result Round-trip
 * Tests conversation with tool result
 */
async function testToolResultRoundTrip() {
  // First request - get tool call
  const response1 = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'deepseek/deepseek-v3.2',
      messages: [{
        role: 'user',
        content: 'What is the weather in Tokyo?'
      }],
      max_tokens: 200,
      tools: [WEATHER_TOOL]
    }
  });

  assertResponse(response1);

  // If tool_use returned, continue with result
  const toolUse = response1.body.content.find(b => b.type === 'tool_use');
  if (toolUse) {
    const response2 = await sendRequest({
      endpoint: '/v1/messages',
      body: {
        model: 'deepseek/deepseek-v3.2',
        messages: [
          {
            role: 'user',
            content: 'What is the weather in Tokyo?'
          },
          {
            role: 'assistant',
            content: [toolUse]
          },
          {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: 'Sunny, 72°F'
            }]
          }
        ],
        max_tokens: 200
      }
    });

    assertResponse(response2);
  }
}

/**
 * TC509: OpenAI Format Tools
 * Tests OpenAI-style function tool format
 */
async function testOpenAIFormatTools() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'qwen3-32b',
      messages: [{
        role: 'user',
        content: 'What is the weather in London?'
      }],
      max_tokens: 100,
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather for a city',
          parameters: {
            type: 'object',
            properties: {
              city: { type: 'string' }
            }
          }
        }
      }]
    }
  });

  assertResponse(response);
}

module.exports = {
  testBasicToolUse,
  testToolChoiceAuto,
  testToolChoiceAny,
  testToolChoiceSpecific,
  testToolChoiceNone,
  testMultipleTools,
  testStreamingWithTools,
  testToolResultRoundTrip,
  testOpenAIFormatTools,
  WEATHER_TOOL,
  CALCULATOR_TOOL
};

if (require.main === module) {
  runTestSuite('Tool Use Tests', [
    { name: 'TC501: Basic Tool Use', fn: testBasicToolUse },
    { name: 'TC502: tool_choice auto', fn: testToolChoiceAuto },
    { name: 'TC503: tool_choice any', fn: testToolChoiceAny },
    { name: 'TC504: tool_choice specific', fn: testToolChoiceSpecific },
    { name: 'TC505: tool_choice none', fn: testToolChoiceNone },
    { name: 'TC506: Multiple Tools', fn: testMultipleTools },
    { name: 'TC507: Streaming', fn: testStreamingWithTools }
  ]);
}