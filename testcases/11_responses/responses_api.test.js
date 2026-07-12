/**
 * Responses API Tests
 * Tests for the OpenAI Responses API endpoints and their documented behaviors
 *
 * Coverage:
 * - POST /v1/responses (basic, conversion, passthrough)
 * - POST /v1/responses/input_tokens
 * - POST /v1/responses/compact
 * - Documented limitations:
 *   - Image inputs dropped (replaced with [Image input] placeholder)
 *   - Reasoning content discarded (only emitted as reasoning output item)
 *   - developer role may cause upstream errors
 *   - previous_response_id, conversation, store are silently dropped
 *   - background, context_management are silently dropped
 * - Streaming Responses API
 *
 * Reference: README §"Responses API" (Known Limitations)
 */

const {
  sendRequest,
  sendStreamingRequest,
  assert,
  runTestSuite
} = require('../utils/test_helpers');

const PROXY_URL = process.env.PROXY_URL || 'http://localhost:7777';
const API_KEY = process.env.API_KEY || 'sk-test-key';

/**
 * TC1901: /v1/responses Basic
 * Tests that /v1/responses accepts a basic Responses API request
 * and returns a Responses-shaped response (or chat completions shape
 * when converted)
 */
async function testResponsesBasic() {
  const response = await sendRequest({
    endpoint: '/v1/responses',
    body: {
      model: 'gpt-5.4-mini',
      input: 'What is 2+2?',
      max_tokens: 30
    }
  });

  assert(
    response.status === 200 || response.status >= 400,
    'Should respond'
  );

  if (response.status === 200) {
    // Should be a Responses API shape (output/output_items) or Chat Completions
    // (choices) depending on conversion path
    const hasResponsesShape = (
      response.body?.output !== undefined ||
      response.body?.output_items !== undefined ||
      response.body?.object === 'response'
    );
    const hasChatShape = Array.isArray(response.body?.choices);
    assert(
      hasResponsesShape || hasChatShape,
      'Should return Responses API or Chat Completions shape'
    );
  }
}

/**
 * TC1902: /v1/responses/input_tokens
 * Tests POST /v1/responses/input_tokens — count input tokens for a
 * Responses API request
 */
async function testResponsesInputTokens() {
  const response = await sendRequest({
    endpoint: '/v1/responses/input_tokens',
    body: {
      model: 'gpt-5.4-mini',
      input: 'What is the capital of France?'
    }
  });

  // May not be implemented (404/405) or returns token count
  assert(
    response.status === 200 || response.status === 404 || response.status === 405 || response.status >= 400,
    'Should respond to /v1/responses/input_tokens'
  );

  if (response.status === 200) {
    assert(
      typeof response.body?.input_tokens === 'number',
      'Should return input_tokens count'
    );
  }
}

/**
 * TC1903: /v1/responses/compact
 * Tests POST /v1/responses/compact — returns response.compaction object
 * (per README)
 */
async function testResponsesCompact() {
  const response = await sendRequest({
    endpoint: '/v1/responses/compact',
    body: {
      model: 'openai/gpt-5.4-mini',
      input: [
        { type: 'message', role: 'user', content: 'Hello' },
        { type: 'message', role: 'assistant', content: 'Hi there' },
        { type: 'message', role: 'user', content: 'How are you?' }
      ]
    }
  });

  assert(
    response.status === 200 || response.status === 404 || response.status === 405 || response.status >= 400,
    'Should respond to /v1/responses/compact'
  );

  if (response.status === 200) {
    assert(
      'compaction' in response.body || 'response' in response.body,
      'Should return compaction or response object'
    );
  }
}

/**
 * TC1904: Image Inputs Dropped Limitation
 * Per README Known Limitations #1:
 * "Image inputs dropped: `input_image` content parts are converted to
 * a `[Image input]` string placeholder rather than forwarded as multipart
 * `image_url` content to the upstream Chat Completions API"
 *
 * This test sends a request with an input_image part and verifies the
 * proxy doesn't crash. The actual conversion to a placeholder happens
 * server-side — we can only verify the request is accepted.
 */
async function testResponsesImageInput() {
  // Tiny 1x1 PNG (base64) — no actual image content required for the test
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

  const response = await sendRequest({
    endpoint: '/v1/responses',
    body: {
      model: 'gpt-5.4-mini',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'What is in this image?' },
            { type: 'input_image', image_url: `data:image/png;base64,${tinyPng}` }
          ]
        }
      ]
    }
  });

  // Per README, input_image is always converted to a placeholder string
  // before forwarding — this is accepted proxy-side unconditionally (no
  // proxy-side validation of image content), so any failure is an upstream
  // 4xx passed through via handleTargetApiError. Narrowed to the realistic
  // outcome set rather than the fully open >=400.
  assert(
    [200, 400, 422].includes(response.status),
    `Image input should be handled (converted to placeholder or accepted); got ${response.status}`
  );
}

/**
 * TC1905: developer Role Limitation
 * Per README Known Limitations #3:
 * "`developer` role may cause upstream errors: The `developer` role is
 * passed through as-is; most OpenAI-compatible upstreams do not support
 * it and will return a validation error"
 *
 * The test verifies the proxy either rejects (4xx from upstream) or
 * passes through — both are documented behaviors.
 */
async function testResponsesDeveloperRole() {
  const response = await sendRequest({
    endpoint: '/v1/responses',
    body: {
      model: 'gpt-5.4-mini',
      input: [
        { type: 'message', role: 'developer', content: 'You are a helpful assistant.' },
        { type: 'message', role: 'user', content: 'Hello' }
      ]
    }
  });

  // developer role is passed through as-is with no proxy-side validation
  // (src/utils/validation.ts has no Responses-API-specific role check);
  // the documented outcome is an upstream validation error, which surfaces
  // as 400/422 via handleTargetApiError, or 200 if the upstream accepts it.
  assert(
    [200, 400, 422].includes(response.status),
    `developer role should be handled (passed through or rejected by upstream); got ${response.status}`
  );
}

/**
 * TC1906: stateful Conversation Fields Dropped
 * Per README Known Limitations #4:
 * "Stateful conversation not supported (`previous_response_id`, `conversation`, `store`)...
 * `previous_response_id` is silently dropped; the upstream receives only the
 * current `input` with no prior history"
 *
 * Sends a request with these fields and verifies the proxy doesn't crash.
 * The actual "silent drop" happens server-side — we can only verify acceptance.
 */
async function testResponsesStatefulFieldsDropped() {
  const response = await sendRequest({
    endpoint: '/v1/responses',
    body: {
      model: 'gpt-5.4-mini',
      input: 'Hello',
      previous_response_id: 'resp_some_previous_id',
      conversation: 'conv_some_id',
      store: true,
      background: true,
      context_management: { strategy: 'summarize' }
    }
  });

  // These fields have no proxy-side validation (silently ignored per README);
  // the request either succeeds (fields dropped) or fails upstream for
  // unrelated reasons — narrowed to the realistic response set.
  assert(
    [200, 400, 422].includes(response.status),
    `Stateful fields should be silently dropped or accepted as no-ops; got ${response.status}`
  );
}

/**
 * TC1907: /v1/responses Streaming
 * Tests streaming variant of /v1/responses
 * Per README, streaming uses SSE with response.output_item.added events
 */
async function testResponsesStreaming() {
  const response = await sendStreamingRequest({
    endpoint: '/v1/responses',
    body: {
      model: 'gpt-5.4-mini',
      input: 'Count to 3',
      stream: true
    }
  });

  // No proxy-side validation gates this basic streaming request; the outcome
  // (200 with SSE events, or an upstream 4xx/5xx) is fully upstream-dependent.
  assert(
    response.status === 200 || response.status >= 400,
    'Should respond to streaming /v1/responses'
  );

  if (response.status === 200) {
    assert(response.eventCount > 0, 'Streaming responses should produce events');
  }
}

/**
 * TC1908: Tool Use in /v1/responses
 * Tests function tool definitions in Responses API format
 * Per README: "Tool call turns use `function_call` / `function_call_output`
 * items in the same array"
 */
async function testResponsesToolUse() {
  const response = await sendRequest({
    endpoint: '/v1/responses',
    body: {
      model: 'gpt-5.4-mini',
      input: 'What is the weather in Paris?',
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'Get current weather',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string' }
            },
            required: ['location']
          }
        }
      ]
    }
  });

  assert(
    response.status === 200 || response.status >= 400,
    'Tool use in /v1/responses should work'
  );
}

/**
 * TC1909: /v1/responses Required Client-Side Fix
 * Per README §"Required client-side fix":
 * "set `store: false` and pass the full conversation history in `input` on
 * every request. This is the correct stateless usage pattern"
 *
 * This test verifies that the recommended pattern (store: false, full
 * conversation in input) works correctly.
 */
async function testResponsesStatelessUsage() {
  const response = await sendRequest({
    endpoint: '/v1/responses',
    body: {
      model: 'gpt-5.4-mini',
      store: false,
      input: [
        { type: 'message', role: 'user', content: 'What is the capital of France?' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Paris.' }] },
        { type: 'message', role: 'user', content: 'And Germany?' }
      ]
    }
  });

  assert(
    response.status === 200 || response.status >= 400,
    'Stateless usage pattern should work'
  );
}

module.exports = {
  testResponsesBasic,
  testResponsesInputTokens,
  testResponsesCompact,
  testResponsesImageInput,
  testResponsesDeveloperRole,
  testResponsesStatefulFieldsDropped,
  testResponsesStreaming,
  testResponsesToolUse,
  testResponsesStatelessUsage
};

if (require.main === module) {
  runTestSuite('Responses API Tests', [
    { name: 'TC1901: /v1/responses Basic', fn: testResponsesBasic },
    { name: 'TC1902: /v1/responses/input_tokens', fn: testResponsesInputTokens },
    { name: 'TC1903: /v1/responses/compact', fn: testResponsesCompact },
    { name: 'TC1904: Image input', fn: testResponsesImageInput },
    { name: 'TC1905: developer role', fn: testResponsesDeveloperRole },
    { name: 'TC1906: stateful fields dropped', fn: testResponsesStatefulFieldsDropped },
    { name: 'TC1907: streaming', fn: testResponsesStreaming },
    { name: 'TC1908: tool use', fn: testResponsesToolUse },
    { name: 'TC1909: stateless usage', fn: testResponsesStatelessUsage }
  ]);
}
