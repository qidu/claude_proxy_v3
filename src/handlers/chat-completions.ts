/**
 * Passthrough handler for /v1/chat/completions.
 * Forwards the request as-is to the upstream OpenAI-compatible endpoint.
 * No format conversion is performed.
 */

import type { Env, Logger } from '../types/shared.js';
import { addForwardedHeaders, mapMaxTokensForUpstream, normalizeOpenAIAuthHeaders } from '../utils/routing.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';
import { recordResponseStatusCodeFromUpstream } from '../utils/dashboard-stats.js';
import { validateOpenAICompletionsRequest } from '../utils/validation.js';
import { ValidationError } from '../utils/errors.js';
import { completionsToResponsesBody, completionsToClaudeBody, claudeJsonToSyntheticCompletions } from './openai.js';

/**
 * Recursively lowercase JSON Schema `type` values.
 * Some SDKs (e.g. google-antigravity) emit uppercase types like "STRING" or "INTEGER"
 * which are rejected by strict upstreams. Mutates the schema object in place.
 */
function normalizeJsonSchemaTypes(schema: Record<string, unknown>): void {
  if (typeof schema.type === 'string') {
    schema.type = schema.type.toLowerCase();
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const prop of Object.values(schema.properties as Record<string, unknown>)) {
      if (prop && typeof prop === 'object') normalizeJsonSchemaTypes(prop as Record<string, unknown>);
    }
  }
  if (Array.isArray(schema.items)) {
    for (const item of schema.items) {
      if (item && typeof item === 'object') normalizeJsonSchemaTypes(item as Record<string, unknown>);
    }
  } else if (schema.items && typeof schema.items === 'object') {
    normalizeJsonSchemaTypes(schema.items as Record<string, unknown>);
  }
}

export async function handleChatCompletionsPassthrough(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  logger: Logger,
  env: Env,
  modelId?: string,
  upstreamMode?: string,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  logger.info(requestId, `${path} passthrough → ${targetUrl} model=${modelId || 'unknown'} upstream=${upstreamMode || 'openai-completions'}`);

  const bodyText = await request.text();

  // Validate against openai-completions schema
  let parsedBody: Record<string, unknown>;
  try {
    parsedBody = JSON.parse(bodyText);
    validateOpenAICompletionsRequest(parsedBody);
  } catch (err) {
    if (err instanceof ValidationError) {
      logger.warn(requestId, `${path} validation failed: ${err.message}`);
      return new Response(JSON.stringify({ error: { message: err.message, type: 'invalid_request_error' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
      });
    }
    logger.warn(requestId, `${path} invalid JSON body: ${(err as Error).message}`);
    return new Response(JSON.stringify({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
    });
  }

  const isStreaming = parsedBody.stream === true;
  logger.debug(requestId, `${path} req: model=${parsedBody.model} messages=${Array.isArray(parsedBody.messages) ? (parsedBody.messages as unknown[]).length : 0} stream=${isStreaming}`);

  // Some SDK clients (e.g. google-antigravity) emit uppercase JSON Schema type strings
  // ("STRING", "INTEGER", "BOOLEAN", "OBJECT", "ARRAY", "NUMBER") that are invalid per
  // the OpenAI spec and rejected by upstreams like DeepSeek. Lowercase them in place.
  if (Array.isArray(parsedBody.tools)) {
    for (const tool of parsedBody.tools as Record<string, unknown>[]) {
      const fn = tool.function as Record<string, unknown> | undefined;
      if (fn?.parameters && typeof fn.parameters === 'object') {
        normalizeJsonSchemaTypes(fn.parameters as Record<string, unknown>);
      }
    }
  }

  // Some SDK clients (e.g. Antigravity LocalOpenAIAgentConfig) omit the `name`
  // field on tool messages. DeepSeek and some other upstreams require it.
  // Recover the name from the preceding assistant turn's tool_calls by tool_call_id.
  // Also fix assistant messages that have tool_calls but content="" — DeepSeek and
  // MiniMax require content to be null (not empty string) in that case.
  if (Array.isArray(parsedBody.messages)) {
    const toolCallIndex = new Map<string, string>();
    let bodyPatched = false;
    for (const msg of parsedBody.messages as Record<string, unknown>[]) {
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls as Record<string, unknown>[]) {
          const id = tc.id as string | undefined;
          const name = (tc.function as Record<string, unknown> | undefined)?.name as string | undefined;
          if (id && name) toolCallIndex.set(id, name);
        }
        if (msg.content === '') { msg.content = null; bodyPatched = true; }
      } else if (msg.role === 'tool' && !msg.name) {
        const name = toolCallIndex.get(msg.tool_call_id as string);
        if (name) { msg.name = name; bodyPatched = true; }
      }
    }
    if (bodyPatched) logger.debug(requestId, `${path} patched missing tool message name(s)`);
  }

  // When the upstream is anthropic-messages, convert completions body → Claude Messages,
  // forward to upstream, then convert the Claude response back to OpenAI completions format.
  if (upstreamMode === 'anthropic-messages') {
    // Use the model name from the (already alias-rewritten) request body, falling back to modelId.
    // modelId carries the original alias name; parsedBody.model carries the rewritten target name.
    const model = (parsedBody.model as string || modelId || 'unknown');
    const claudeBody = completionsToClaudeBody(parsedBody, model);
    logger.debug(requestId, `${path} converted to anthropic-messages body`);

    const anthropicHeaders: Record<string, string> = { ...authHeaders };
    if (anthropicHeaders['Authorization'] && !anthropicHeaders['x-api-key']) {
      anthropicHeaders['x-api-key'] = anthropicHeaders['Authorization'].replace(/^Bearer\s+/i, '');
      delete anthropicHeaders['Authorization'];
    }

    const upstreamResponse = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...addForwardedHeaders(anthropicHeaders, request),
      },
      body: JSON.stringify(claudeBody),
      signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env as Record<string, unknown>)),
    });

    recordResponseStatusCodeFromUpstream(upstreamResponse.status);
    logger.debug(requestId, `${path} resp: status=${upstreamResponse.status} stream=${isStreaming}`);

    if (!upstreamResponse.ok) {
      const errText = await upstreamResponse.text();
      return new Response(errText, {
        status: upstreamResponse.status,
        headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
      });
    }

    if (isStreaming) {
      // Convert Claude SSE → OpenAI SSE on the fly
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      (async () => {
        try {
          const reader = upstreamResponse.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split('\n\n');
            buffer = events.pop() || '';
            for (const event of events) {
              if (!event.trim()) continue;
              const dataLine = event.split('\n').find(l => l.startsWith('data: '));
              if (!dataLine) continue;
              const data = dataLine.slice(6).trim();
              if (!data) continue;
              try {
                const parsed = JSON.parse(data) as Record<string, unknown>;
                // Claude SSE types we care about
                if (parsed.type === 'content_block_delta') {
                  const delta = parsed.delta as Record<string, unknown> | undefined;
                  if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
                    const chunk = { id: `chatcmpl_${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant', content: delta.text }, finish_reason: null }] };
                    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  } else if (delta?.type === 'input_json_delta') {
                    // tool call argument streaming — emit as function arguments delta
                    const chunk = { id: `chatcmpl_${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: delta.partial_json ?? '' } }] }, finish_reason: null }] };
                    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  }
                } else if (parsed.type === 'content_block_start') {
                  const block = parsed.content_block as Record<string, unknown> | undefined;
                  if (block?.type === 'tool_use') {
                    const chunk = { id: `chatcmpl_${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: parsed.index ?? 0, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }] }, finish_reason: null }] };
                    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  }
                } else if (parsed.type === 'message_delta') {
                  const delta = parsed.delta as Record<string, unknown> | undefined;
                  const finishReason = delta?.stop_reason === 'tool_use' ? 'tool_calls' : delta?.stop_reason === 'max_tokens' ? 'length' : 'stop';
                  const chunk = { id: `chatcmpl_${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
                  await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                } else if (parsed.type === 'message_stop') {
                  await writer.write(encoder.encode('data: [DONE]\n\n'));
                }
              } catch { /* skip unparseable events */ }
            }
          }
          await writer.close();
        } catch (e) {
          logger.error(requestId, `${path} anthropic-messages streaming error: ${(e as Error).message}`);
          await writer.abort();
        }
      })();
      return new Response(readable, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'x-request-id': requestId },
      });
    }

    // Non-streaming: convert Claude JSON → OpenAI completions JSON
    const claudeJson = await upstreamResponse.json() as Record<string, unknown>;
    const completions = claudeJsonToSyntheticCompletions(claudeJson, model);
    return new Response(JSON.stringify(completions), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
    });
  }

  // When the upstream is openai-responses, convert the completions body to Responses API format
  if (upstreamMode === 'openai-responses') {
    const model = (modelId || parsedBody.model as string || 'unknown');
    const responsesBody = completionsToResponsesBody(parsedBody, model);
    logger.debug(requestId, `${path} converted to openai-responses body`);

    const upstreamResponse = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...addForwardedHeaders(normalizeOpenAIAuthHeaders(authHeaders, targetUrl), request),
      },
      body: JSON.stringify(mapMaxTokensForUpstream(responsesBody, targetUrl)),
      signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env as Record<string, unknown>)),
    });

    recordResponseStatusCodeFromUpstream(upstreamResponse.status);
    logger.debug(requestId, `${path} resp: status=${upstreamResponse.status} stream=${isStreaming}`);

    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.set('x-request-id', requestId);

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  }

  const upstreamResponse = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...addForwardedHeaders(authHeaders, request),
    },
    body: JSON.stringify(parsedBody),
    signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env as Record<string, unknown>)),
  });

  recordResponseStatusCodeFromUpstream(upstreamResponse.status);
  logger.debug(requestId, `${path} resp: status=${upstreamResponse.status} stream=${isStreaming}`);

  // Forward the response body as-is -- preserve streaming or JSON
  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.set('x-request-id', requestId);

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
