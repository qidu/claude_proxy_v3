/**
 * OpenAI Responses routing/conversion unit tests.
 *
 * These tests exercise handler wiring directly against dist/ modules with
 * global fetch stubbed, so they verify exact upstream request bodies without
 * depending on a real OpenAI-compatible upstream.
 *
 * Coverage:
 * - TC3001: /v1/messages Claude-format request routes to openai-responses body
 * - TC3002: /v1/messages OpenAI tools/tool_choice flatten for Responses API
 * - TC3003: /v1/messages Chat tool-call history maps to Responses input items
 * - TC3004: upstream Responses SSE maps back to Claude SSE
 * - TC3005: /v1/responses -> openai-completions maps max_tokens for non-qnaigc
 * - TC3006: /v1/responses -> openai-completions keeps max_tokens for qnaigc
 * - TC3007: TUI test request token field follows upstream mode
 * - TC3008: /v1/responses -> anthropic-messages converts to Claude Messages format
 * - TC3009: /v1/responses -> gemini-generatecontent converts via Claude format
 */

const path = require('path');
const {
  assert,
  runTestSuite,
} = require('../utils/test_helpers');

let handleMessagesRequest;
let handleResponsesRequest;
let buildTestTextRequest;
let buildTestToolRequest;

async function loadModule() {
  const messages = await import(path.join(process.cwd(), 'dist/handlers/messages.js'));
  const responses = await import(path.join(process.cwd(), 'dist/handlers/responses.js'));
  const tui = await import(path.join(process.cwd(), 'dist/tui.js'));
  handleMessagesRequest = messages.handleMessagesRequest;
  handleResponsesRequest = responses.handleResponsesRequest;
  buildTestTextRequest = tui.buildTestTextRequest;
  buildTestToolRequest = tui.buildTestToolRequest;
}

function makeRequest(endpoint, body) {
  return new Request(`http://localhost:7777${endpoint}`, {
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
    model: 'gpt-test',
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

function completionsJson(text = 'ok') {
  return {
    id: 'chatcmpl_test',
    object: 'chat.completion',
    created: 123,
    model: 'gpt-test',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  };
}

async function withFetchStub(responseFactory, fn) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const bodyText = typeof init.body === 'string' ? init.body : undefined;
    calls.push({
      url: String(url),
      init,
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

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Expected JSON response, got: ${text}`);
  }
}

async function readSseEvents(response) {
  const text = await response.text();
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((eventText) => {
      const eventLine = eventText.split('\n').find(line => line.startsWith('event: '));
      const dataLine = eventText.split('\n').find(line => line.startsWith('data: '));
      const parsed = dataLine ? JSON.parse(dataLine.slice(6)) : undefined;
      return { event: eventLine ? eventLine.slice(7) : undefined, data: parsed };
    });
}

function upstreamSseResponse() {
  const encoder = new TextEncoder();
  const events = [
    { type: 'response.output_text.delta', delta: 'hel' },
    { type: 'response.output_text.delta', delta: 'lo' },
    { type: 'response.output_text.done' },
    {
      type: 'response.completed',
      response: {
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      },
    },
  ];
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function testClaudeMessagesToResponsesBody() {
  await withFetchStub(
    () => new Response(JSON.stringify(responsesJson('converted')), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    async (calls) => {
      const response = await handleMessagesRequest(
        makeRequest('/v1/messages', {
          model: 'claude-test',
          system: 'Be concise.',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
          max_tokens: 42,
        }),
        'https://api.openai.com/v1/responses',
        { Authorization: 'Bearer sk-test' },
        'req_tc3001',
        'gpt-test',
        {},
        undefined,
        undefined,
        'openai-responses'
      );

      assert(calls.length === 1, `expected one upstream call, got ${calls.length}`);
      assert(calls[0].url === 'https://api.openai.com/v1/responses', `unexpected target URL ${calls[0].url}`);
      assert(Array.isArray(calls[0].body.input), 'Responses body should contain input array');
      assert(!('messages' in calls[0].body), 'Responses body must not contain Chat Completions messages');
      assert(calls[0].body.max_output_tokens === 42, `expected max_output_tokens=42, got ${calls[0].body.max_output_tokens}`);
      assert(!('max_tokens' in calls[0].body), 'Responses body must not forward max_tokens');
      assert(calls[0].body.input[0].content[0].type === 'input_text', 'Claude text should become Responses input_text');

      const body = await readJson(response);
      assert(response.status === 200, `expected status 200, got ${response.status}`);
      assert(body.type === 'message', `expected Claude message shape, got ${JSON.stringify(body).slice(0, 120)}`);
      assert(Array.isArray(body.content), 'Claude response should contain content array');
    }
  );
}

async function testOpenAIToolsFlattenForResponses() {
  await withFetchStub(
    () => new Response(JSON.stringify(responsesJson()), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    async (calls) => {
      await handleMessagesRequest(
        makeRequest('/v1/messages', {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'Call the weather tool' }],
          max_tokens: 16,
          tools: [{
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
            },
          }],
          tool_choice: { type: 'function', function: { name: 'get_weather' } },
        }),
        'https://api.openai.com/v1/responses',
        { Authorization: 'Bearer sk-test' },
        'req_tc3002',
        undefined,
        {},
        undefined,
        undefined,
        'openai-responses'
      );

      const body = calls[0].body;
      assert(body.tools[0].type === 'function', 'tool type should stay function');
      assert(body.tools[0].name === 'get_weather', 'tool name should be flattened');
      assert(body.tools[0].parameters?.type === 'object', 'tool parameters should be preserved');
      assert(!('function' in body.tools[0]), 'Responses tool must not contain nested function object');
      assert(body.tool_choice.type === 'function', 'tool_choice type should stay function');
      assert(body.tool_choice.name === 'get_weather', 'tool_choice name should be flattened');
      assert(!('function' in body.tool_choice), 'Responses tool_choice must not contain nested function object');
    }
  );
}

async function testToolCallHistoryMapsToResponsesInputItems() {
  await withFetchStub(
    () => new Response(JSON.stringify(responsesJson()), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    async (calls) => {
      await handleMessagesRequest(
        makeRequest('/v1/messages', {
          model: 'gpt-test',
          messages: [
            { role: 'user', content: 'weather' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_weather',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
              }],
            },
            { role: 'tool', tool_call_id: 'call_weather', content: '{"temp":20}' },
          ],
        }),
        'https://api.openai.com/v1/responses',
        { Authorization: 'Bearer sk-test' },
        'req_tc3003',
        undefined,
        {},
        undefined,
        undefined,
        'openai-responses'
      );

      const input = calls[0].body.input;
      const functionCall = input.find(item => item.type === 'function_call');
      const functionOutput = input.find(item => item.type === 'function_call_output');
      assert(functionCall, `expected function_call item in ${JSON.stringify(input)}`);
      assert(functionCall.call_id === 'call_weather', `expected call_id call_weather, got ${functionCall.call_id}`);
      assert(functionCall.name === 'get_weather', `expected function name get_weather, got ${functionCall.name}`);
      assert(functionCall.arguments === '{"city":"Paris"}', `unexpected function arguments ${functionCall.arguments}`);
      assert(functionOutput, `expected function_call_output item in ${JSON.stringify(input)}`);
      assert(functionOutput.call_id === 'call_weather', `expected output call_id call_weather, got ${functionOutput.call_id}`);
      assert(functionOutput.output === '{"temp":20}', `unexpected tool output ${functionOutput.output}`);
    }
  );
}

async function testResponsesStreamMapsToClaudeSse() {
  await withFetchStub(
    () => upstreamSseResponse(),
    async (calls) => {
      const response = await handleMessagesRequest(
        makeRequest('/v1/messages', {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'stream' }],
          max_tokens: 8,
          stream: true,
        }),
        'https://api.openai.com/v1/responses',
        { Authorization: 'Bearer sk-test' },
        'req_tc3004',
        undefined,
        {},
        undefined,
        undefined,
        'openai-responses'
      );

      assert(calls[0].body.stream === true, 'upstream Responses request should preserve stream=true');
      const events = await readSseEvents(response);
      const eventNames = events.map(event => event.event).filter(Boolean);
      for (const expected of ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']) {
        assert(eventNames.includes(expected), `expected Claude SSE event ${expected}, got ${eventNames.join(',')}`);
      }
      const textDelta = events.find(event => event.event === 'content_block_delta')?.data?.delta;
      assert(textDelta?.type === 'text_delta', `expected text_delta, got ${JSON.stringify(textDelta)}`);
    }
  );
}

async function testResponsesToCompletionsMapsMaxTokensForOpenAI() {
  await withFetchStub(
    () => new Response(JSON.stringify(completionsJson()), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    async (calls) => {
      await handleResponsesRequest(
        makeRequest('/v1/responses', {
          model: 'gpt-test',
          input: 'Hello',
          max_output_tokens: 9,
        }),
        'https://api.openai.com/v1/chat/completions',
        { Authorization: 'Bearer sk-test' },
        'req_tc3005',
        undefined,
        {},
        undefined,
        'openai-completions'
      );

      assert(calls[0].body.max_completion_tokens === 9, `expected max_completion_tokens=9, got ${calls[0].body.max_completion_tokens}`);
      assert(!('max_tokens' in calls[0].body), 'non-qnaigc completions request should not forward max_tokens');
    }
  );
}

async function testResponsesToCompletionsKeepsMaxTokensForQnaigc() {
  await withFetchStub(
    () => new Response(JSON.stringify(completionsJson()), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    async (calls) => {
      await handleResponsesRequest(
        makeRequest('/v1/responses', {
          model: 'deepseek-test',
          input: 'Hello',
          max_output_tokens: 11,
        }),
        'https://api.qnaigc.com/v1/chat/completions',
        { Authorization: 'Bearer sk-test' },
        'req_tc3006',
        undefined,
        {},
        undefined,
        'openai-completions'
      );

      assert(calls[0].body.max_tokens === 11, `expected max_tokens=11, got ${calls[0].body.max_tokens}`);
      assert(!('max_completion_tokens' in calls[0].body), 'qnaigc completions request should not use max_completion_tokens');
    }
  );
}

async function testTuiMaxTokenFieldFollowsUpstreamMode() {
  const responsesText = buildTestTextRequest('openai-responses');
  assert(responsesText.max_completion_tokens === 32, 'openai-responses text test should use max_completion_tokens');
  assert(!('max_tokens' in responsesText), 'openai-responses text test should not use max_tokens');

  const completionsText = buildTestTextRequest('openai-completions');
  assert(completionsText.max_tokens === 32, 'openai-completions text test should use max_tokens');
  assert(!('max_completion_tokens' in completionsText), 'openai-completions text test should not use max_completion_tokens');

  const responsesTool = buildTestToolRequest('openai-responses');
  assert(responsesTool.max_completion_tokens === 128, 'openai-responses tool test should use max_completion_tokens');
  assert(!('max_tokens' in responsesTool), 'openai-responses tool test should not use max_tokens');
}

/**
 * TC3008: /v1/responses -> anthropic-messages routes to v1/messages with Claude format
 *
 * Verifies that when upstreamMode='anthropic-messages':
 * - The request body is converted from Responses format to Claude Messages format
 * - The upstream call targets v1/messages
 * - `input` is converted to `messages`
 * - `instructions` is extracted as `system`
 * - The Claude response is converted back to Responses API format
 */
async function testResponsesToAnthropicMessages() {
  const claudeUpstreamResponse = {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    content: [{ type: 'text', text: 'Hello from Claude' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 4 },
  };

  await withFetchStub(
    () => new Response(JSON.stringify(claudeUpstreamResponse), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    async (calls) => {
      const response = await handleResponsesRequest(
        makeRequest('/v1/responses', {
          model: 'claude-test',
          instructions: 'Be concise.',
          input: 'Hello',
          max_output_tokens: 50,
        }),
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': 'sk-test' },
        'req_tc3008',
        'claude-test',
        {},
        undefined,
        'anthropic-messages'
      );

      assert(calls.length === 1, `expected one upstream call, got ${calls.length}`);
      assert(calls[0].url === 'https://api.anthropic.com/v1/messages', `unexpected URL ${calls[0].url}`);
      assert(Array.isArray(calls[0].body.messages), 'Claude body should contain messages array');
      assert(!('input' in calls[0].body), 'Claude body must not contain Responses API input field');
      assert(calls[0].body.system === 'Be concise.', `expected system='Be concise.', got ${calls[0].body.system}`);
      const userMsg = calls[0].body.messages.find(m => m.role === 'user');
      assert(userMsg, 'should have a user message');
      assert(userMsg.content === 'Hello', `expected user content 'Hello', got ${userMsg.content}`);

      assert(response.status === 200, `expected 200, got ${response.status}`);
      const body = await readJson(response);
      assert(body.object === 'response', `expected object=response, got ${body.object}`);
      assert(Array.isArray(body.output), 'response should have output array');
      const msgItem = body.output.find(o => o.type === 'message');
      assert(msgItem, 'response output should contain a message item');
      const textPart = msgItem.content.find(c => c.type === 'output_text');
      assert(textPart?.text === 'Hello from Claude', `unexpected text: ${textPart?.text}`);
    }
  );
}

/**
 * TC3009: /v1/responses -> gemini-generatecontent converts to Claude format for Gemini handler
 *
 * Verifies that when upstreamMode='gemini-generatecontent':
 * - The Responses body is converted to Claude Messages format
 * - The synthetic Claude request is passed to the Gemini handler
 * - The final response is Responses API format
 *
 * We stub global fetch to intercept the Gemini upstream call and return a
 * synthetic Claude-format response (as handleGeminiRequestForMessages would produce).
 */
async function testResponsesToGeminiGenerateContent() {
  // handleGeminiRequestForMessages converts Claude→Gemini for the upstream call,
  // gets back Gemini response, and converts to Claude format. We stub fetch at the
  // Gemini upstream level so we return a Gemini-format response.
  const geminiUpstreamResponse = {
    candidates: [{
      content: { role: 'model', parts: [{ text: 'Hello from Gemini' }] },
      finishReason: 'STOP',
    }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
  };

  await withFetchStub(
    () => new Response(JSON.stringify(geminiUpstreamResponse), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    async (calls) => {
      const response = await handleResponsesRequest(
        makeRequest('/v1/responses', {
          model: 'gemini-test',
          input: 'Hello',
          max_output_tokens: 20,
        }),
        'https://generativelanguage.googleapis.com/v1beta',
        { 'x-goog-api-key': 'gm-test' },
        'req_tc3009',
        'gemini-test',
        {},
        undefined,
        'gemini-generatecontent'
      );

      assert(calls.length === 1, `expected one upstream call, got ${calls.length}`);
      // The Gemini handler constructs the URL with model and endpoint
      assert(calls[0].url.includes('generateContent'), `upstream URL should contain generateContent, got ${calls[0].url}`);

      assert(response.status === 200, `expected 200, got ${response.status}`);
      const body = await readJson(response);
      assert(body.object === 'response', `expected object=response, got ${body.object}`);
      assert(Array.isArray(body.output), 'response should have output array');
      const msgItem = body.output.find(o => o.type === 'message');
      assert(msgItem, 'response output should contain a message item');
      const textPart = msgItem.content.find(c => c.type === 'output_text');
      assert(textPart?.text === 'Hello from Gemini', `unexpected text: ${textPart?.text}`);
    }
  );
}

if (require.main === module) {
  loadModule().then(() => runTestSuite('OpenAI Responses Routing/Conversion Unit Tests', [
    { name: 'TC3001: /v1/messages Claude -> openai-responses body', fn: testClaudeMessagesToResponsesBody },
    { name: 'TC3002: /v1/messages OpenAI tools flatten for Responses', fn: testOpenAIToolsFlattenForResponses },
    { name: 'TC3003: /v1/messages tool-call history maps to Responses input', fn: testToolCallHistoryMapsToResponsesInputItems },
    { name: 'TC3004: Responses upstream SSE maps to Claude SSE', fn: testResponsesStreamMapsToClaudeSse },
    { name: 'TC3005: /v1/responses -> completions maps max tokens for OpenAI', fn: testResponsesToCompletionsMapsMaxTokensForOpenAI },
    { name: 'TC3006: /v1/responses -> completions keeps max tokens for qnaigc', fn: testResponsesToCompletionsKeepsMaxTokensForQnaigc },
    { name: 'TC3007: TUI test request token field follows upstream mode', fn: testTuiMaxTokenFieldFollowsUpstreamMode },
    { name: 'TC3008: /v1/responses -> anthropic-messages converts to Claude format', fn: testResponsesToAnthropicMessages },
    { name: 'TC3009: /v1/responses -> gemini-generatecontent converts to Claude format', fn: testResponsesToGeminiGenerateContent },
  ]));
}
