/**
 * /v1/chat/completions passthrough (always on, formerly DEV_PASS_THROUGH)
 * + openai-responses upstream unit tests.
 *
 * Covers the two changes made to support per-model routing on
 * /v1/chat/completions:
 *
 * 1. handleChatCompletionsPassthrough converts the completions body to
 *    Responses API format (input, max_output_tokens) when upstreamMode is
 *    'openai-responses', and forwards to the model-specific targetUrl.
 *
 * 2. completionsToResponsesBody (now exported from handlers/openai.js)
 *    correctly converts messages, system instructions, tools, and max_tokens.
 *
 * These tests stub globalThis.fetch so no real upstream is needed.
 *
 * TC numbers: TC3101–TC3104
 */

const path = require('path');
const { assert, runTestSuite } = require('../utils/test_helpers');

let handleChatCompletionsPassthrough;
let completionsToResponsesBody;
let convertResponsesToChatCompletions;

async function loadModule() {
  const chatCompletions = await import(path.join(process.cwd(), 'dist/handlers/chat-completions.js'));
  const openai = await import(path.join(process.cwd(), 'dist/handlers/openai.js'));
  const responsesToCompletions = await import(path.join(process.cwd(), 'dist/converters/responses-to-completions.js'));
  handleChatCompletionsPassthrough = chatCompletions.handleChatCompletionsPassthrough;
  completionsToResponsesBody = openai.completionsToResponsesBody;
  convertResponsesToChatCompletions = responsesToCompletions.convertResponsesToChatCompletions;
}

function makeRequest(body) {
  return new Request('http://localhost:7777/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test',
    },
    body: JSON.stringify(body),
  });
}

function responsesJson(text = 'ok') {
  return {
    id: 'resp_test',
    object: 'response',
    created_at: 123,
    model: 'gpt-5.5',
    output: [{
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text }],
    }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  };
}

async function withFetchStub(responseFactory, fn) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const bodyText = typeof init.body === 'string' ? init.body : undefined;
    calls.push({
      url: String(url),
      headers: init.headers || {},
      body: bodyText ? JSON.parse(bodyText) : undefined,
    });
    return responseFactory(calls[calls.length - 1]);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---------------------------------------------------------------------------
// TC3101: passthrough with openai-responses converts body to Responses format
// ---------------------------------------------------------------------------

async function testPassthroughConvertsToResponsesBody() {
  await withFetchStub(
    () => new Response(JSON.stringify(responsesJson('hello')), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
    async (calls) => {
      const response = await handleChatCompletionsPassthrough(
        makeRequest({
          model: 'gpt-5.5',
          prompt_cache_key: 'tenant:acme:support-assistant-v1',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 20,
        }),
        'https://jiukunsctix.cognitiveservices.azure.com/openai/responses?api-version=2025-04-01-preview',
        { 'api-key': 'AqkD9s-test' },
        'req_tc3101',
        { warn: () => {}, debug: () => {}, info: () => {}, error: () => {} },
        {},
        'gpt-5.5',
        'openai-responses',
      );

      assert(calls.length === 1, `expected one upstream call, got ${calls.length}`);
      assert(
        calls[0].url.includes('cognitiveservices.azure.com'),
        `expected Azure URL, got ${calls[0].url}`,
      );
      assert(Array.isArray(calls[0].body.input), `body.input should be an array, got ${JSON.stringify(calls[0].body.input)}`);
      assert(!('messages' in calls[0].body), 'Responses body must not contain Chat Completions messages field');
      assert(calls[0].body.max_output_tokens === 20, `expected max_output_tokens=20, got ${calls[0].body.max_output_tokens}`);
      assert(!('max_tokens' in calls[0].body), 'Responses body must not forward max_tokens');
      assert(calls[0].body.prompt_cache_key === 'tenant:acme:support-assistant-v1', `expected prompt_cache_key to be preserved, got ${calls[0].body.prompt_cache_key}`);
      const userInput = calls[0].body.input.find(i => i.role === 'user');
      assert(userInput, `expected user input item, got ${JSON.stringify(calls[0].body.input)}`);
      assert(response.status === 200, `expected status 200, got ${response.status}`);
    },
  );
}

// ---------------------------------------------------------------------------
// TC3102: passthrough with openai-completions forwards body as-is (no conversion)
// ---------------------------------------------------------------------------

async function testPassthroughCompletionsBodyForwardedAsIs() {
  const originalBody = {
    model: 'gpt-5.4-mini',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 15,
  };

  await withFetchStub(
    () => new Response(JSON.stringify({
      id: 'chatcmpl_test',
      object: 'chat.completion',
      created: 123,
      model: 'gpt-5.4-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
    async (calls) => {
      await handleChatCompletionsPassthrough(
        makeRequest(originalBody),
        'http://localhost:3000/v1/chat/completions',
        { Authorization: 'Bearer WELCOME_TO_USE' },
        'req_tc3102',
        { warn: () => {}, debug: () => {}, info: () => {}, error: () => {} },
        {},
        'gpt-5.4-mini',
        'openai-completions',
      );

      assert(calls.length === 1, `expected one upstream call, got ${calls.length}`);
      assert(Array.isArray(calls[0].body.messages), 'openai-completions body must preserve messages array');
      assert(!('input' in calls[0].body), 'openai-completions body must not contain Responses input field');
      assert(calls[0].body.max_tokens === 15, `expected max_tokens=15, got ${calls[0].body.max_tokens}`);
    },
  );
}

// ---------------------------------------------------------------------------
// TC3103: completionsToResponsesBody converts system message to instructions
// ---------------------------------------------------------------------------

async function testCompletionsToResponsesBodySystemToInstructions() {
  const result = completionsToResponsesBody({
    model: 'gpt-5.5',
    prompt_cache_key: 'tenant:acme:support-assistant-v1',
    messages: [
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'Hello' },
    ],
    max_tokens: 30,
  }, 'gpt-5.5');

  assert(result.instructions === 'Be concise.', `expected instructions='Be concise.', got ${result.instructions}`);
  assert(result.prompt_cache_key === 'tenant:acme:support-assistant-v1', `expected prompt_cache_key to be preserved, got ${result.prompt_cache_key}`);
  assert(Array.isArray(result.input), 'result.input should be an array');
  const userItem = result.input.find(i => i.role === 'user');
  assert(userItem, `expected user input item, got ${JSON.stringify(result.input)}`);
  assert(result.max_output_tokens === 30, `expected max_output_tokens=30, got ${result.max_output_tokens}`);
  assert(!('max_tokens' in result), 'result must not contain max_tokens');
  assert(!('messages' in result), 'result must not contain messages');
  // system message must not appear in input array
  const systemItem = result.input.find(i => i.role === 'system');
  assert(!systemItem, 'system message must not appear in input array');
}

// ---------------------------------------------------------------------------
// TC3104: completionsToResponsesBody converts tools to flat Responses format
// ---------------------------------------------------------------------------

async function testCompletionsToResponsesBodyToolsFlattened() {
  const result = completionsToResponsesBody({
    model: 'gpt-5.5',
    messages: [{ role: 'user', content: 'weather?' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    }],
  }, 'gpt-5.5');

  assert(Array.isArray(result.tools), 'result.tools should be an array');
  const tool = result.tools[0];
  assert(tool.type === 'function', `expected tool.type=function, got ${tool.type}`);
  assert(tool.name === 'get_weather', `expected tool.name=get_weather, got ${tool.name}`);
  assert(!('function' in tool), 'Responses tool must not contain nested function object');
  assert(tool.parameters?.type === 'object', 'tool.parameters should be preserved');
}

// ---------------------------------------------------------------------------
// TC3105: convertResponsesToChatCompletions preserves prompt_cache_key
// ---------------------------------------------------------------------------

async function testResponsesToCompletionsPreservesPromptCacheKey() {
  const result = convertResponsesToChatCompletions({
    model: 'gpt-5.6',
    prompt_cache_key: 'tenant:acme:knowledge-base-v1',
    input: 'Hello',
  }, 'gpt-5.6');

  assert(result.prompt_cache_key === 'tenant:acme:knowledge-base-v1', `expected prompt_cache_key to be preserved, got ${result.prompt_cache_key}`);
}

module.exports = {
  testPassthroughConvertsToResponsesBody,
  testPassthroughCompletionsBodyForwardedAsIs,
  testCompletionsToResponsesBodySystemToInstructions,
  testCompletionsToResponsesBodyToolsFlattened,
  testResponsesToCompletionsPreservesPromptCacheKey,
};

if (require.main === module) {
  loadModule().then(() =>
    runTestSuite('/v1/chat/completions passthrough + openai-responses', [
      { name: 'TC3101: passthrough openai-responses converts body to Responses format', fn: testPassthroughConvertsToResponsesBody },
      { name: 'TC3102: passthrough openai-completions forwards body as-is', fn: testPassthroughCompletionsBodyForwardedAsIs },
      { name: 'TC3103: completionsToResponsesBody converts system to instructions', fn: testCompletionsToResponsesBodySystemToInstructions },
      { name: 'TC3104: completionsToResponsesBody flattens tools', fn: testCompletionsToResponsesBodyToolsFlattened },
      { name: 'TC3105: convertResponsesToChatCompletions preserves prompt_cache_key', fn: testResponsesToCompletionsPreservesPromptCacheKey },
    ]),
  );
}
