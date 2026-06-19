/**
 * Responses API handler for Claude Proxy v3
 *
 * Handles POST /responses endpoint (OpenAI Responses API format)
 * Supports both OpenAI Responses API pass-through and conversion to Chat Completions
 */

import { Env } from '../types/shared.js';
import { Logger, createLogger } from '../utils/logger.js';
import { OpenAIRequest, OpenAIResponse } from '../types/openai.js';
import { handleTargetApiError } from '../utils/errors.js';
import { addForwardedHeaders } from '../utils/routing.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';
import { convertResponsesToChatCompletions } from '../converters/responses-to-completions.js';
import { convertCompletionsToResponses, convertCompletionsToCompactedResponse } from '../converters/completions-to-responses.js';
import { getConversation, saveConversation, normalizeInputToItems } from '../utils/conversation-store.js';
import { recordResponseStatusCodeFromUpstream, recordUpstreamResponseToolCount } from '../utils/dashboard-stats.js';

/**
 * Handle responses API request
 */
export async function handleResponsesRequest(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  modelId?: string,
  env?: Env,
  logger?: Logger,
  upstreamMode?: string
): Promise<Response> {
  const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);

  const requestBody = await request.json() as Record<string, unknown>;
  const isStreaming = requestBody.stream === true;
  // Alias (modelId) takes precedence over the body's model field, matching the pattern
  // used by the messages handler: `const targetModelId = modelId || claudeRequest.model`
  const model = modelId || (requestBody.model as string) || 'unknown';

  activeLogger.info(requestId, `Responses API request (stream=${isStreaming}, mode=${upstreamMode}, model=${model}): ${targetUrl}`);

  // Handle based on upstream mode
  if (upstreamMode === 'openai-completions') {
    // Convert Responses API format to Chat Completions format
    return handleAsCompletions(request, targetUrl, authHeaders, requestId, model, activeLogger, requestBody, isStreaming, env);
  }

  // Default: Pass through to OpenAI Responses API upstream
  return handleAsPassthrough(request, targetUrl, authHeaders, requestId, activeLogger, requestBody, isStreaming, env);
}

/**
 * Handle request by converting Responses API format to Chat Completions
 */
async function handleAsCompletions(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  model: string,
  logger: Logger,
  requestBody: Record<string, unknown>,
  isStreaming: boolean,
  env?: Env
): Promise<Response> {
  const conversationEnabled = env?.CONVERSATION === 'true' || env?.CONVERSATION === '1';
  const previousResponseId = requestBody.previous_response_id as string | undefined;

  // Normalize current input to an item array so we can prepend prior history
  let mergedInput: unknown[] = normalizeInputToItems(requestBody.input);

  // If conversation caching is on and client references a prior response,
  // prepend [prior_input_items, prior_output_items] before the new input.
  if (conversationEnabled && previousResponseId) {
    const prior = getConversation(previousResponseId);
    if (prior) {
      mergedInput = [...prior.inputItems, ...prior.outputItems, ...mergedInput];
      logger.debug(requestId, `[conversation] loaded prior=${previousResponseId} (${prior.inputItems.length + prior.outputItems.length} items prepended)`);
    } else {
      logger.debug(requestId, `[conversation] previous_response_id=${previousResponseId} not found in store (expired or unknown)`);
    }
  }

  // Build effective request body: use merged input, drop previous_response_id
  // (Chat Completions upstream does not understand it)
  const effectiveBody: Record<string, unknown> = { ...requestBody, input: mergedInput };
  delete effectiveBody.previous_response_id;

  // Convert Responses API request to Chat Completions format
  const completionsRequest = convertResponsesToChatCompletions(effectiveBody, model);

  logger.debug(requestId, `Converted to completions format: ${JSON.stringify(completionsRequest)}`);

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...addForwardedHeaders(authHeaders, request),
    },
    body: JSON.stringify(completionsRequest),
    signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
  });

  recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount('openai-completions', 0);

  if (!response.ok) {
    const bodyPreview = JSON.stringify(completionsRequest);
    const upstreamErrorBody = await response.text();
    logger.error(requestId, `Responses->Completions API error: ${response.status}, URL: ${targetUrl}`);
    handleTargetApiError(response, 'Responses API (via Completions)', { url: targetUrl, body: bodyPreview, upstreamBody: upstreamErrorBody });
  }

  if (isStreaming) {
    // onComplete saves the conversation entry after the stream finishes
    const onComplete = conversationEnabled
      ? (responseId: string, outputItems: unknown[]) => {
          saveConversation(responseId, mergedInput, outputItems);
          logger.debug(requestId, `[conversation] saved responseId=${responseId} (${mergedInput.length} input + ${outputItems.length} output items)`);
        }
      : undefined;
    return streamCompletionsAsResponses(response, model, requestId, logger, onComplete);
  }

  // Convert Chat Completions response back to Responses API format
  const responseText = await response.text();
  logger.debug(requestId, `Upstream completions response: ${responseText.substring(0, 1000)}`);
  const completionsResponse = JSON.parse(responseText) as OpenAIResponse;
  const responsesResponse = convertCompletionsToResponses(completionsResponse, model);

  // Save conversation entry for next turn
  if (conversationEnabled) {
    saveConversation(responsesResponse.id, mergedInput, responsesResponse.output);
    logger.debug(requestId, `[conversation] saved responseId=${responsesResponse.id} (${mergedInput.length} input + ${responsesResponse.output.length} output items)`);
  }

  return new Response(JSON.stringify(responsesResponse), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': requestId,
    },
  });
}

/**
 * Transform a Chat Completions SSE stream into a Responses API SSE stream.
 *
 * Chat Completions events look like:
 *   data: {"id":"...","choices":[{"delta":{"content":"hi"},"index":0}],"model":"..."}
 *
 * Responses API events emitted here:
 *   response.created           – once at start
 *   response.output_item.added – once (message item)
 *   response.content_part.added – once (output_text part)
 *   response.output_text.delta  – one per token chunk
 *   response.output_text.done   – once at end of text
 *   response.output_item.done   – once (message item)
 *   response.completed          – once at end with usage
 */
function streamCompletionsAsResponses(
  upstreamResponse: Response,
  model: string,
  requestId: string,
  logger?: Logger,
  onComplete?: (responseId: string, outputItems: unknown[]) => void
): Response {
  const responseId = `resp_${crypto.randomUUID().replace(/-/g, '')}`;
  const itemId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const created_at = Math.floor(Date.now() / 1000);

  let sequenceNumber = 0;
  const nextSeq = () => sequenceNumber++;

  function sseEvent(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // Accumulated state for tool calls streamed as indexed fragments.
  // Map from tool-call index -> { id, name, arguments }
  type ToolCallAccum = { id: string; name: string; arguments: string };

  async function pump() {
    try {
      // Emit response.created
      await writer.write(encoder.encode(sseEvent('response.created', {
        type: 'response.created',
        sequence_number: nextSeq(),
        response: { id: responseId, object: 'response', created_at, status: 'in_progress', model, output: [] },
      })));

      let accumulatedText = '';
      let textPartOpened = false;
      let textOutputIndex = -1; // set when text item is opened
      let usageData: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
      let upstreamModel = model;
      let buffer = '';
      let rawUpstreamBody = ''; // accumulate for debug logging
      // tool_calls are streamed by index; accumulate across chunks
      const toolCalls: Map<number, ToolCallAccum> = new Map();
      // Track which tool call output_index slots have been opened
      const toolCallOutputIndex: Map<number, number> = new Map();
      let nextOutputIndex = 0; // claimed by the text message item if/when text appears, else tool calls start at 0

      const reader = upstreamResponse.body?.getReader();
      if (!reader) {
        await writer.close();
        return;
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        rawUpstreamBody += chunk;
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') continue;

          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(raw);
          } catch {
            continue;
          }

          if (chunk.model) upstreamModel = chunk.model as string;
          if (chunk.usage) usageData = chunk.usage as typeof usageData;

          const choices = chunk.choices as Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index: number;
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string;
          }> | undefined;
          if (!choices?.length) continue;

          const delta = choices[0].delta;
          if (!delta) continue;

          // Thinking tokens in delta.thinking / delta.reasoning_content are silently skipped;
          // the fallback output item below ensures output is never empty if no text or tool calls follow.

          // --- text content ---
          if (delta.content) {
            if (!textPartOpened) {
              // Text message item claims the next available index (always 0 if no tool calls came first)
              textOutputIndex = nextOutputIndex++;
              // Open the message output item and text part on first text delta
              await writer.write(encoder.encode(sseEvent('response.output_item.added', {
                type: 'response.output_item.added',
                sequence_number: nextSeq(),
                output_index: textOutputIndex,
                item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
              })));
              await writer.write(encoder.encode(sseEvent('response.content_part.added', {
                type: 'response.content_part.added',
                sequence_number: nextSeq(),
                item_id: itemId,
                output_index: textOutputIndex,
                content_index: 0,
                part: { type: 'output_text', text: '' },
              })));
              textPartOpened = true;
            }
            accumulatedText += delta.content;
            await writer.write(encoder.encode(sseEvent('response.output_text.delta', {
              type: 'response.output_text.delta',
              sequence_number: nextSeq(),
              item_id: itemId,
              output_index: textOutputIndex,
              content_index: 0,
              delta: delta.content,
            })));
          }

          // --- tool call chunks ---
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCalls.has(idx)) {
                // First chunk for this tool call index
                const tcId = tc.id ?? `call_${Date.now()}_${idx}`;
                const initialArgs = tc.function?.arguments ?? '';
                toolCalls.set(idx, { id: tcId, name: tc.function?.name ?? '', arguments: initialArgs });
                const outputIndex = nextOutputIndex++;
                toolCallOutputIndex.set(idx, outputIndex);
                // Emit output_item.added for this function_call
                await writer.write(encoder.encode(sseEvent('response.output_item.added', {
                  type: 'response.output_item.added',
                  sequence_number: nextSeq(),
                  output_index: outputIndex,
                  item: {
                    id: tcId,
                    type: 'function_call',
                    status: 'in_progress',
                    name: tc.function?.name ?? '',
                    arguments: '',
                    call_id: tcId,
                  },
                })));
                // If the first chunk already carries argument data, emit it as a delta now
                if (initialArgs) {
                  await writer.write(encoder.encode(sseEvent('response.function_call_arguments.delta', {
                    type: 'response.function_call_arguments.delta',
                    sequence_number: nextSeq(),
                    item_id: tcId,
                    output_index: outputIndex,
                    delta: initialArgs,
                  })));
                }
              } else {
                const accum = toolCalls.get(idx)!;
                if (tc.function?.name) accum.name += tc.function.name;
                if (tc.function?.arguments) {
                  accum.arguments += tc.function.arguments;
                  const outputIndex = toolCallOutputIndex.get(idx)!;
                  // Emit arguments delta
                  await writer.write(encoder.encode(sseEvent('response.function_call_arguments.delta', {
                    type: 'response.function_call_arguments.delta',
                    sequence_number: nextSeq(),
                    item_id: accum.id,
                    output_index: outputIndex,
                    delta: tc.function.arguments,
                  })));
                }
              }
            }
          }
        }
      }

      logger?.debug(requestId, `[stream] upstream raw body (${rawUpstreamBody.length} bytes):\n${rawUpstreamBody}`);

      // --- close text part if it was opened ---
      if (textPartOpened) {
        await writer.write(encoder.encode(sseEvent('response.output_text.done', {
          type: 'response.output_text.done',
          sequence_number: nextSeq(),
          item_id: itemId,
          output_index: textOutputIndex,
          content_index: 0,
          text: accumulatedText,
        })));
        await writer.write(encoder.encode(sseEvent('response.output_item.done', {
          type: 'response.output_item.done',
          sequence_number: nextSeq(),
          output_index: textOutputIndex,
          item: {
            id: itemId,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: accumulatedText }],
          },
        })));
      }

      // --- close each tool call item ---
      const completedToolCalls: Array<{ id: string; type: string; status: string; name: string; arguments: string; call_id: string }> = [];
      for (const [idx, accum] of toolCalls) {
        const outputIndex = toolCallOutputIndex.get(idx)!;
        await writer.write(encoder.encode(sseEvent('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          sequence_number: nextSeq(),
          item_id: accum.id,
          output_index: outputIndex,
          arguments: accum.arguments,
        })));
        await writer.write(encoder.encode(sseEvent('response.output_item.done', {
          type: 'response.output_item.done',
          sequence_number: nextSeq(),
          output_index: outputIndex,
          item: {
            id: accum.id,
            type: 'function_call',
            status: 'completed',
            name: accum.name,
            arguments: accum.arguments,
            call_id: accum.id,
          },
        })));
        completedToolCalls.push({ id: accum.id, type: 'function_call', status: 'completed', name: accum.name, arguments: accum.arguments, call_id: accum.id });
      }

      // Build output array for response.completed
      const outputItems: unknown[] = [];
      if (textPartOpened) {
        outputItems.push({
          id: itemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: accumulatedText }],
        });
      }
      outputItems.push(...completedToolCalls);

      // output: [] is invalid per spec. If the stream had only thinking/reasoning content
      // (no text, no tool calls), emit a fallback empty-text message item so the client
      // receives a non-empty output array. This handles models that emit thinking tokens
      // in delta.thinking / delta.reasoning_content without a separate text delta.
      if (outputItems.length === 0) {
        outputItems.push({
          id: itemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: '' }],
        });
      }

      // Build usage for response.completed
      const usage = usageData ? {
        input_tokens: usageData.prompt_tokens ?? 0,
        output_tokens: usageData.completion_tokens ?? 0,
        total_tokens: usageData.total_tokens ?? 0,
        input_tokens_details: { cached_tokens: 0 },
      } : undefined;

      // Save conversation entry before emitting the completed event
      onComplete?.(responseId, outputItems);

      // Emit response.completed
      await writer.write(encoder.encode(sseEvent('response.completed', {
        type: 'response.completed',
        sequence_number: nextSeq(),
        response: {
          id: responseId,
          object: 'response',
          created_at,
          status: 'completed',
          model: upstreamModel,
          output: outputItems,
          usage,
        },
      })));

      await writer.write(encoder.encode('data: [DONE]\n\n'));
    } catch {
      // Stream ended or errored; close writer to flush what we have
    } finally {
      await writer.close();
    }
  }

  pump();

  return new Response(readable, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'x-request-id': requestId,
    },
  });
}

/**
 * Handle POST /v1/responses/input_tokens request
 *
 * Returns input token count for the given request.
 * Spec: POST /responses/input_tokens → { object: "response.input_tokens", input_tokens: number }
 */
export async function handleResponsesInputTokensRequest(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  modelId?: string,
  env?: Env,
  logger?: Logger,
  upstreamMode?: string
): Promise<Response> {
  const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);

  const requestBody = await request.json() as Record<string, unknown>;
  const model = modelId || (requestBody.model as string) || 'unknown';

  activeLogger.info(requestId, `Responses input_tokens request (mode=${upstreamMode}, model=${model}): ${targetUrl}`);

  if (upstreamMode === 'openai-completions') {
    // Convert to completions format, call with max_tokens=1, extract prompt_tokens from usage
    const completionsRequest = convertResponsesToChatCompletions(requestBody, model);
    const countRequest = { ...completionsRequest, max_tokens: 1, stream: false };

    activeLogger.debug(requestId, `input_tokens -> completions count: ${JSON.stringify(countRequest).substring(0, 500)}`);

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...addForwardedHeaders(authHeaders, request),
      },
      body: JSON.stringify(countRequest),
      signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
    });

    recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount('openai-completions', 0);

  if (!response.ok) {
      const upstreamErrorBody = await response.text();
      activeLogger.error(requestId, `Responses input_tokens error: ${response.status}, URL: ${targetUrl}`);
      handleTargetApiError(response, 'Responses input_tokens (via Completions)', { url: targetUrl, upstreamBody: upstreamErrorBody });
    }

    const responseText = await response.text();
    const completionsResponse = JSON.parse(responseText) as OpenAIResponse;
    const inputTokens = completionsResponse.usage?.prompt_tokens ?? 0;

    return new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: inputTokens }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': requestId,
      },
    });
  }

  // Passthrough to OpenAI Responses API upstream /responses/input_tokens
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...addForwardedHeaders(authHeaders, request),
    },
    body: JSON.stringify(requestBody),
    signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
  });

  recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount('openai-completions', 0);

  if (!response.ok) {
    const upstreamErrorBody = await response.text();
    activeLogger.error(requestId, `Responses input_tokens passthrough error: ${response.status}, URL: ${targetUrl}`);
    handleTargetApiError(response, 'Responses input_tokens', { url: targetUrl, upstreamBody: upstreamErrorBody });
  }

  return new Response(response.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': requestId,
    },
  });
}

/**
 * Handle POST /v1/responses/compact request
 *
 * Compact a conversation. Returns a CompactedResponse with object: "response.compaction".
 * Spec: POST /responses/compact
 */
export async function handleResponsesCompactRequest(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  modelId?: string,
  env?: Env,
  logger?: Logger,
  upstreamMode?: string
): Promise<Response> {
  const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);

  const requestBody = await request.json() as Record<string, unknown>;
  const model = modelId || (requestBody.model as string) || 'unknown';

  activeLogger.info(requestId, `Responses compact request (mode=${upstreamMode}, model=${model}): ${targetUrl}`);

  if (upstreamMode === 'openai-completions') {
    // Convert to chat completions, call upstream, wrap as CompactedResponse
    const completionsRequest = convertResponsesToChatCompletions(requestBody, model);

    activeLogger.debug(requestId, `Compact -> completions: ${JSON.stringify(completionsRequest).substring(0, 500)}`);

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...addForwardedHeaders(authHeaders, request),
      },
      body: JSON.stringify(completionsRequest),
      signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
    });

    recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount('openai-completions', 0);

  if (!response.ok) {
      const upstreamErrorBody = await response.text();
      activeLogger.error(requestId, `Responses compact error: ${response.status}, URL: ${targetUrl}`);
      handleTargetApiError(response, 'Responses compact (via Completions)', { url: targetUrl, upstreamBody: upstreamErrorBody });
    }

    const responseText = await response.text();
    const completionsResponse = JSON.parse(responseText) as OpenAIResponse;
    const compactedResponse = convertCompletionsToCompactedResponse(completionsResponse, model);

    return new Response(JSON.stringify(compactedResponse), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': requestId,
      },
    });
  }

  // Passthrough to OpenAI Responses API upstream /responses/compact
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...addForwardedHeaders(authHeaders, request),
    },
    body: JSON.stringify(requestBody),
    signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
  });

  recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount('openai-completions', 0);

  if (!response.ok) {
    const upstreamErrorBody = await response.text();
    activeLogger.error(requestId, `Responses compact passthrough error: ${response.status}, URL: ${targetUrl}`);
    handleTargetApiError(response, 'Responses compact', { url: targetUrl, upstreamBody: upstreamErrorBody });
  }

  return new Response(response.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': requestId,
    },
  });
}

/**
 * Handle request by passing through to OpenAI Responses API upstream
 */
async function handleAsPassthrough(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  logger: Logger,
  requestBody: Record<string, unknown>,
  isStreaming: boolean,
  env?: Env
): Promise<Response> {
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...addForwardedHeaders(authHeaders, request),
    },
    body: JSON.stringify(requestBody),
    signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
  });

  recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount('openai-completions', 0);

  if (!response.ok) {
    const bodyPreview = JSON.stringify(requestBody);
    const upstreamErrorBody = await response.text();
    logger.error(requestId, `Responses API error: ${response.status}, URL: ${targetUrl}`);
    handleTargetApiError(response, 'Responses API', { url: targetUrl, body: bodyPreview, upstreamBody: upstreamErrorBody });
  }

  if (isStreaming) {
    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'x-request-id': requestId,
      },
    });
  }

  return new Response(response.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': requestId,
    },
  });
}
