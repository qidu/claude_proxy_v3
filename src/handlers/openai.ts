import { ClaudeMessagesRequest, ClaudeMessagesResponse } from '../types/claude.js';
import { convertClaudeToOpenAIRequest, ThinkingConversionOptions } from '../converters/claude-to-openai.js';
import { convertOpenAIToClaudeResponse } from '../converters/openai-to-claude.js';
import { convertOpenAIToGeminiGenerateContent, convertOpenAIToGeminiInteractions } from '../converters/openai-to-gemini.js';
import { createLogger } from '../utils/logger.js';
import { isSdkUrl, handleSdkOpenAIRequest } from '../utils/sdk-handler.js';
import type { Env, Logger } from '../types/shared.js';
import { addForwardedHeaders, mapMaxTokensForUpstream, normalizeOpenAIAuthHeaders } from '../utils/routing.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';
import { recordResponseStatusCodeFromUpstream, recordUpstreamResponseToolCount } from '../utils/dashboard-stats.js';
import { handleTargetApiError } from '../utils/errors.js';
import { OpenAIContent, OpenAIMessage } from '../types/openai.js';

/**
 * Check if request is in Gemini Interactions format
 */
function isGeminiInteractionsRequest(body: Record<string, unknown>): boolean {
  return 'input' in body || 'contents' in body;
}

/**
 * Convert Gemini Interactions request to OpenAI format
 */
function convertGeminiInteractionsToOpenAI(geminiRequest: Record<string, unknown>): Record<string, unknown> {
  const model = (geminiRequest.model as string) || 'gemini-no-id-at-proxy';
  
  // Handle input.messages format (Interactions API)
  if (geminiRequest.input && typeof geminiRequest.input === 'object') {
    const input = geminiRequest.input as Record<string, unknown>;
    if (Array.isArray(input.messages)) {
      return {
        model,
        messages: input.messages,
        stream: geminiRequest.stream || false,
      };
    }
  }
  
  // Handle input as array-of-turns (TC203: [{role, content}, ...])
  if (Array.isArray(geminiRequest.input)) {
    return {
      model,
      messages: (geminiRequest.input as any[]).map((turn: any) => ({
        role: turn.role === 'model' ? 'assistant' : turn.role,
        content: typeof turn.content === 'string' ? turn.content : String(turn.content),
      })),
      stream: geminiRequest.stream || false,
    };
  }

  // Handle simple input format
  if (typeof geminiRequest.input === 'string') {
    return {
      model,
      messages: [{ role: 'user', content: geminiRequest.input }],
      stream: geminiRequest.stream || false,
    };
  }
  
  // Handle contents format
  if (Array.isArray(geminiRequest.contents)) {
    const messages = geminiRequest.contents.map((content: any) => ({
      role: content.role === 'model' ? 'assistant' : content.role,
      content: content.parts?.map((p: any) => p.text).join('') || '',
    }));
    
    return {
      model,
      messages,
      stream: geminiRequest.stream || false,
    };
  }
  
  throw new Error('Invalid Gemini Interactions request format');
}

/**
 * Recursively normalize Gemini schema type names (uppercase) to JSON Schema
 * (lowercase) so OpenAI-compatible upstreams accept the function parameters.
 * e.g. "STRING" → "string", "OBJECT" → "object"
 */
function normalizeGeminiSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(normalizeGeminiSchema);
  const out: Record<string, any> = {};
  for (const key of Object.keys(schema)) {
    if (key === 'type' && typeof schema[key] === 'string') {
      out[key] = (schema[key] as string).toLowerCase();
    } else {
      out[key] = normalizeGeminiSchema(schema[key]);
    }
  }
  return out;
}

/**
 * Convert Gemini generateContent request to OpenAI format
 */
function convertGeminiGenerateContentToOpenAI(geminiRequest: Record<string, unknown>): Record<string, unknown> {
  const model = (geminiRequest.model as string) || 'gemini-no-id-at-proxy';

  // Handle contents format
  if (Array.isArray(geminiRequest.contents)) {
    const messages: Record<string, unknown>[] = [];

    for (const content of geminiRequest.contents as any[]) {
      const role = content.role === 'model' ? 'assistant' : content.role;
      const parts: any[] = content.parts ?? [];

      const funcCallParts = parts.filter((p: any) => p.functionCall);
      const funcRespParts = parts.filter((p: any) => p.functionResponse);
      const textContent = parts.filter((p: any) => p.text).map((p: any) => p.text).join('');

      if (funcCallParts.length > 0) {
        // Model turn: convert functionCall parts to OpenAI tool_calls
        messages.push({
          role: 'assistant',
          content: textContent || null,
          tool_calls: funcCallParts.map((p: any, i: number) => ({
            id: `call_${p.functionCall.name}_${i}`,
            type: 'function',
            function: {
              name: p.functionCall.name,
              arguments: JSON.stringify(p.functionCall.args ?? {}),
            },
          })),
        });
      } else if (funcRespParts.length > 0) {
        // User turn: convert functionResponse parts to OpenAI tool messages
        for (let i = 0; i < funcRespParts.length; i++) {
          const p = funcRespParts[i];
          messages.push({
            role: 'tool',
            tool_call_id: `call_${p.functionResponse.name}_${i}`,
            content: JSON.stringify(p.functionResponse.response ?? {}),
          });
        }
      } else {
        messages.push({ role, content: textContent });
      }
    }

    // Convert Gemini tools[].functionDeclarations to OpenAI tools[]
    const tools: unknown[] = [];
    if (Array.isArray(geminiRequest.tools)) {
      for (const tool of geminiRequest.tools as any[]) {
        if (Array.isArray(tool.functionDeclarations)) {
          for (const fd of tool.functionDeclarations) {
            tools.push({
              type: 'function',
              function: {
                name: fd.name,
                description: fd.description,
                parameters: normalizeGeminiSchema(fd.parameters ?? { type: 'object', properties: {} }),
              },
            });
          }
        }
      }
    }

    // Check for stream parameter in both top-level and generationConfig
    const config = geminiRequest.generationConfig as Record<string, unknown> | undefined;
    const stream = geminiRequest.stream === true || config?.stream === true;

    const result: Record<string, unknown> = { model, messages, stream };
    if (tools.length > 0) result.tools = tools;
    return result;
  }

  throw new Error('Invalid Gemini generateContent request format');
}

function defaultMissingOpenAIMessageRoles(openaiRequest: Record<string, unknown>): void {
  if (!Array.isArray(openaiRequest.messages)) return;

  openaiRequest.messages = openaiRequest.messages.map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
    const msg = message as Record<string, unknown>;
    return msg.role == null ? { ...msg, role: 'user' } : msg;
  });
}

function openAIContentToText(content: OpenAIContent | null | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part.type === 'text')
    .map(part => 'text' in part ? part.text : '')
    .join('');
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string' || value === '') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function openAIChunk(text: string, model: string): Record<string, unknown> {
  return {
    id: `chatcmpl_${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

function processAnthropicSSEBuffer(buffer: string, model: string, requestId: string, isInteractionsRequest: boolean, isGenerateContentRequest: boolean): { processed: string; remaining: string } {
  let result = '';
  const events = buffer.split('\n\n');
  const remaining = events.pop() || '';

  for (const event of events) {
    if (!event.trim()) continue;
    const dataLine = event.split('\n').find(line => line.startsWith('data: '));
    if (!dataLine) continue;
    try {
      const parsed = JSON.parse(dataLine.slice(6));
      if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
        const chunk = openAIChunk(parsed.delta.text || '', model);
        const { processed } = processSSEBuffer(`data: ${JSON.stringify(chunk)}\n\n`, model, requestId, isInteractionsRequest, isGenerateContentRequest);
        result += processed;
      }
    } catch {
      // Skip invalid SSE data.
    }
  }

  return { processed: result, remaining };
}

function processResponsesSSEBuffer(buffer: string, model: string, requestId: string, isInteractionsRequest: boolean, isGenerateContentRequest: boolean): { processed: string; remaining: string } {
  let result = '';
  const events = buffer.split('\n\n');
  const remaining = events.pop() || '';

  for (const event of events) {
    if (!event.trim()) continue;
    const dataLine = event.split('\n').find(line => line.startsWith('data: '));
    if (!dataLine) continue;
    const data = dataLine.slice(6).trim();
    if (data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === 'response.output_text.delta') {
        const chunk = openAIChunk(parsed.delta || '', model);
        const { processed } = processSSEBuffer(`data: ${JSON.stringify(chunk)}\n\n`, model, requestId, isInteractionsRequest, isGenerateContentRequest);
        result += processed;
      }
    } catch {
      // Skip invalid SSE data.
    }
  }

  return { processed: result, remaining };
}

async function handleCrossModeStreamingResponse(
  response: Response,
  model: string,
  requestId: string,
  logger: Logger,
  isInteractionsRequest: boolean,
  isGenerateContentRequest: boolean,
  source: 'anthropic-messages' | 'openai-responses',
): Promise<Response> {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        const converted = source === 'anthropic-messages'
          ? processAnthropicSSEBuffer(buffer, model, requestId, isInteractionsRequest, isGenerateContentRequest)
          : processResponsesSSEBuffer(buffer, model, requestId, isInteractionsRequest, isGenerateContentRequest);
        buffer = converted.remaining;
        if (converted.processed) await writer.write(encoder.encode(converted.processed));
      }
      if (buffer.trim()) {
        const converted = source === 'anthropic-messages'
          ? processAnthropicSSEBuffer(buffer + '\n\n', model, requestId, isInteractionsRequest, isGenerateContentRequest)
          : processResponsesSSEBuffer(buffer + '\n\n', model, requestId, isInteractionsRequest, isGenerateContentRequest);
        if (converted.processed) await writer.write(encoder.encode(converted.processed));
      }
      await writer.close();
    } catch (error) {
      logger.error(requestId, `Cross-mode streaming error: ${(error as Error).message}`);
      await writer.abort();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'x-request-id': requestId,
    },
  });
}

/**
 * Convert an OpenAI Chat Completions body (model, messages, max_tokens, ...) to a
 * Claude Messages body. Used to route Gemini endpoints (interactions/generateContent)
 * through an anthropic-messages upstream.
 */
function completionsToClaudeBody(completions: Record<string, unknown>, model: string): Record<string, unknown> {
  const messages = (completions.messages as OpenAIMessage[]) || [];
  const systemMsg = messages.find(m => m.role === 'system');
  const otherMessages = messages.filter(m => m.role !== 'system');

  const claudeBody: Record<string, unknown> = {
    model,
    messages: otherMessages.map(m => {
      if (m.tool_calls) {
        return {
          role: 'assistant',
          content: m.tool_calls.map(tc => ({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: parseJsonObject(tc.function.arguments),
          })),
        };
      }
      if (m.role === 'tool') {
        return {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: m.content ?? '',
          }],
        };
      }
      return { role: m.role, content: m.content ?? '' };
    }),
    max_tokens: (completions.max_tokens as number | undefined) ?? 4096,
    stream: completions.stream === true,
  };

  if (systemMsg) claudeBody.system = systemMsg.content;
  if (completions.temperature !== undefined) claudeBody.temperature = completions.temperature;
  if (completions.top_p !== undefined) claudeBody.top_p = completions.top_p;
  if (completions.stop !== undefined) claudeBody.stop_sequences = Array.isArray(completions.stop) ? completions.stop : [completions.stop as string];

  if (completions.tools && Array.isArray(completions.tools) && (completions.tools as unknown[]).length > 0) {
    claudeBody.tools = (completions.tools as Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>).map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
  }

  return claudeBody;
}

/**
 * Convert an OpenAI Chat Completions body to an OpenAI Responses body (`input`).
 * Used to route Gemini endpoints (interactions/generateContent) through an
 * openai-responses upstream.
 */
export function completionsToResponsesBody(completions: Record<string, unknown>, model: string): Record<string, unknown> {
  const messages = (completions.messages as OpenAIMessage[]) || [];
  const input: unknown[] = [];
  const instructions = messages
    .filter(msg => msg.role === 'system' || msg.role === 'developer')
    .map(msg => openAIContentToText(msg.content))
    .filter(text => text !== '')
    .join('\n');

  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      continue;
    }

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
      const text = openAIContentToText(msg.content);
      if (text !== '') {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        });
      }
      continue;
    }

    if (msg.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output: openAIContentToText(msg.content),
      });
      continue;
    }

    // Prior assistant turns replayed as input must use `output_text` (mirrors what
    // the upstream originally emitted); user turns use `input_text`.
    const textType = msg.role === 'assistant' ? 'output_text' : 'input_text';
    input.push({
      type: 'message',
      role: msg.role,
      content: [{ type: textType, text: openAIContentToText(msg.content) }],
    });
  }

  const responsesBody: Record<string, unknown> = {
    model,
    input,
    stream: completions.stream === true,
  };
  if (instructions) responsesBody.instructions = instructions;

  if (completions.temperature !== undefined) responsesBody.temperature = completions.temperature;
  if (completions.top_p !== undefined) responsesBody.top_p = completions.top_p;
  if (completions.max_tokens !== undefined) responsesBody.max_output_tokens = completions.max_tokens;
  if (completions.prompt_cache_key !== undefined) responsesBody.prompt_cache_key = completions.prompt_cache_key;
  if (completions.tools && Array.isArray(completions.tools) && (completions.tools as unknown[]).length > 0) {
    responsesBody.tools = (completions.tools as Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>).map(t => ({
      type: 'function',
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
  }

  return responsesBody;
}

/**
 * Forward an OpenAI Chat Completions body as a Claude Messages request to an
 * anthropic-messages upstream. Used when the inbound endpoint is
 * /v1/interactions or :generateContent and the route is anthropic-messages.
 *
 * The body has already been converted from Gemini/Claude to OpenAI Completions
 * by handleOpenAIRequest; we run a second conversion to Claude Messages format
 * and call the upstream directly. The response is converted from Claude
 * format back to the Gemini endpoint shape (Interactions or generateContent).
 */
async function forwardCompletionsAsAnthropicMessages(
  openaiRequest: Record<string, unknown>,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  model: string,
  logger: Logger,
  originalRequest: Request,
  env?: Env,
): Promise<Response> {
  const claudeBody = completionsToClaudeBody(openaiRequest, model);
  logger.debug(requestId, `Interactions/generateContent -> anthropic-messages body: ${JSON.stringify(claudeBody).substring(0, 500)}`);

  // anthropic-messages expects x-api-key (or Authorization). Normalize headers.
  const anthropicHeaders: Record<string, string> = { ...authHeaders };
  if (anthropicHeaders['x-api-key']) {
    delete anthropicHeaders['Authorization'];
  }

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...addForwardedHeaders(anthropicHeaders, originalRequest),
    },
    body: JSON.stringify(claudeBody),
    signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
  });

  recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount('anthropic-messages', 0);

  if (!response.ok) {
    const upstreamBody = await response.text();
    logger.error(requestId, `Interactions/generateContent->anthropic-messages error: ${response.status}, URL: ${targetUrl}`);
    handleTargetApiError(response, 'Interactions/generateContent (via anthropic-messages)', { url: targetUrl, upstreamBody });
  }

  const url = new URL(originalRequest.url);
  const isInteractionsRequest = url.pathname === '/v1/interactions' || url.pathname.startsWith('/v1/interactions?');
  const isGenerateContentRequest = url.pathname.includes(':generateContent') || url.pathname.includes(':streamGenerateContent');

  const isStreaming = claudeBody.stream === true;
  if (isStreaming) {
    return handleCrossModeStreamingResponse(response, model, requestId, logger, isInteractionsRequest, isGenerateContentRequest, 'anthropic-messages');
  }

  const claudeJson = await response.json() as Record<string, unknown>;
  const contentBlocks = (claudeJson.content as Array<Record<string, unknown>>) ?? [];
  const toolUseBlocks = contentBlocks.filter(c => c.type === 'tool_use');
  // Convert Claude Messages response → OpenAI Completions response shape, then
  // let the existing Gemini response converters produce the right endpoint shape.
  const syntheticCompletions: Record<string, unknown> = {
    id: claudeJson.id ?? `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: (claudeJson.model as string) ?? model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: contentBlocks
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join(''),
        ...(toolUseBlocks.length > 0 ? {
          tool_calls: toolUseBlocks.map(tc => ({
            id: (tc.id as string) ?? `call_${Date.now()}`,
            type: 'function',
            function: { name: tc.name ?? '', arguments: JSON.stringify(tc.input ?? {}) },
          })),
        } : {}),
      },
      finish_reason: toolUseBlocks.length > 0 ? 'tool_calls' : (claudeJson.stop_reason === 'max_tokens' ? 'length' : 'stop'),
    }],
    usage: (() => {
      const u = claudeJson.usage as Record<string, unknown> | undefined;
      if (!u) return undefined;
      return {
        prompt_tokens: u.input_tokens ?? 0,
        completion_tokens: u.output_tokens ?? 0,
        total_tokens: ((u.input_tokens as number) ?? 0) + ((u.output_tokens as number) ?? 0),
      };
    })(),
  };

  if (isGenerateContentRequest) {
    const geminiResponse = convertOpenAIToGeminiGenerateContent(syntheticCompletions, model, requestId);
    return new Response(JSON.stringify(geminiResponse), {
      headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
    });
  }
  if (isInteractionsRequest) {
    const interactionResponse = convertOpenAIToGeminiInteractions(syntheticCompletions, model, requestId);
    return new Response(JSON.stringify(interactionResponse), {
      headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
    });
  }

  // Fallback: return Claude Messages response as-is
  return new Response(JSON.stringify(claudeJson), {
    headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
  });
}

/**
 * Forward an OpenAI Chat Completions body as an OpenAI Responses body to an
 * openai-responses upstream. Used when the inbound endpoint is
 * /v1/interactions or :generateContent and the route is openai-responses.
 *
 * The body has already been converted from Gemini/Claude to OpenAI Completions
 * by handleOpenAIRequest; we run a second conversion to Responses `input`
 * format and call the upstream. The response is converted from Responses
 * format back to the Gemini endpoint shape.
 */
async function forwardCompletionsAsOpenAIResponses(
  openaiRequest: Record<string, unknown>,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  model: string,
  logger: Logger,
  originalRequest: Request,
  env?: Env,
  isInteractionsRequest?: boolean,
  isGenerateContentRequest?: boolean,
  isStreaming?: boolean,
): Promise<Response> {
  const responsesBody = completionsToResponsesBody(openaiRequest, model);
  logger.debug(requestId, `Interactions/generateContent -> openai-responses body: ${JSON.stringify(responsesBody).substring(0, 500)}`);

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...addForwardedHeaders(normalizeOpenAIAuthHeaders(authHeaders, targetUrl), originalRequest),
    },
    body: JSON.stringify(mapMaxTokensForUpstream(responsesBody, targetUrl)),
    signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
  });

  recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount('openai-responses', 0);

  if (!response.ok) {
    const upstreamBody = await response.text();
    logger.error(requestId, `Interactions/generateContent->openai-responses error: ${response.status}, URL: ${targetUrl}`);
    handleTargetApiError(response, 'Interactions/generateContent (via openai-responses)', { url: targetUrl, upstreamBody });
  }

  if (isStreaming) {
    return handleCrossModeStreamingResponse(response, model, requestId, logger, isInteractionsRequest === true, isGenerateContentRequest === true, 'openai-responses');
  }

  const responsesJson = await response.json() as Record<string, unknown>;
  // Build a synthetic Completions response from the Responses output items so
  // we can reuse the existing Gemini response converters.
  const outputItems = (responsesJson.output as Array<Record<string, unknown>>) ?? [];
  const textMsg = outputItems.find(o => o.type === 'message');
  const textPart = (textMsg?.content as Array<Record<string, unknown>> | undefined)?.find(c => c.type === 'output_text');
  const toolCallItems = outputItems.filter(o => o.type === 'function_call');
  const usageObj = responsesJson.usage as Record<string, unknown> | undefined;

  const syntheticCompletions: Record<string, unknown> = {
    id: responsesJson.id ?? `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: (responsesJson.created_at as number) ?? Math.floor(Date.now() / 1000),
    model: (responsesJson.model as string) ?? model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: (textPart?.text as string) ?? '',
        ...(toolCallItems.length > 0 ? {
          tool_calls: toolCallItems.map(tc => ({
            id: (tc.call_id as string) ?? (tc.id as string) ?? `call_${Date.now()}`,
            type: 'function',
            function: { name: tc.name ?? '', arguments: tc.arguments ?? '' },
          })),
        } : {}),
      },
      finish_reason: toolCallItems.length > 0 ? 'tool_calls' : 'stop',
    }],
    usage: usageObj ? {
      prompt_tokens: usageObj.input_tokens ?? 0,
      completion_tokens: usageObj.output_tokens ?? 0,
      total_tokens: usageObj.total_tokens ?? 0,
    } : undefined,
  };

  if (isGenerateContentRequest) {
    const geminiResponse = convertOpenAIToGeminiGenerateContent(syntheticCompletions, model, requestId);
    return new Response(JSON.stringify(geminiResponse), {
      headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
    });
  }
  if (isInteractionsRequest) {
    const interactionResponse = convertOpenAIToGeminiInteractions(syntheticCompletions, model, requestId);
    return new Response(JSON.stringify(interactionResponse), {
      headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
    });
  }

  // Fallback: return Responses API response as-is
  return new Response(JSON.stringify(responsesJson), {
    headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
  });
}

/**
 * Handle OpenAI-compatible API request
 */
export async function handleOpenAIRequest(
    request: Request,
    targetUrl: string,
    authHeaders: Record<string, string>,
    requestId: string,
    modelId?: string,
    env?: Env,
    logger?: Logger,
    forceStreaming?: boolean,
    conversionOptions?: ThinkingConversionOptions,
    upstreamMode?: string
): Promise<Response> {
    const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);

    // Check original request path for response format
    const url = new URL(request.url);
    const isStreamRequest = url.searchParams.get('alt') === 'sse' || url.pathname.includes(':streamGenerateContent');
    const isInteractionsRequest = url.pathname === '/v1/interactions' || url.pathname.startsWith('/v1/interactions?');
    const isGenerateContentRequest = url.pathname.includes(':generateContent') || url.pathname.includes(':streamGenerateContent');
    const isGeminiEndpoint = isInteractionsRequest || isGenerateContentRequest;
    
    activeLogger.debug(requestId, `OpenAI handler - path: ${url.pathname}, isGeminiEndpoint: ${isGeminiEndpoint}`);
    const authTokenIn = request.headers.get('Authorization') || '';
    const apiKey = request.headers.get('x-api-key') || '';
    const googApiKey = request.headers.get('x-goog-api-key') || '';
    activeLogger.debug(requestId, `Authorization: ${authTokenIn.substring(0, 16)}... at endpoint`);
    activeLogger.debug(requestId, `x-api-key: ${apiKey.substring(0, 16)}...`);
    activeLogger.debug(requestId, `x-goog-api-key: ${googApiKey.substring(0, 16)}...`);

    // This handler always targets an OpenAI-compatible upstream (openai-completions),
    // which expects `Authorization: Bearer <key>` regardless of the incoming endpoint
    // (/v1/messages, /v1/interactions, or :generateContent mapped here). Resolve the
    // key from whichever header the client supplied and forward it as Bearer — but
    // only when the proxy has not already populated an Authorization header from its
    // own configuration (e.g. [models.free] `api_key`). Overwriting a configured key
    // with a stray client header breaks the /v1beta/models (Gemini) path, which
    // dispatches here, while /v1/responses (handleResponsesRequest) does not.
    if (!authHeaders['Authorization']) {
        const incomingKey =
            (authTokenIn ? authTokenIn.replace(/^Bearer\s+/i, '') : '') ||
            apiKey ||
            (googApiKey ? googApiKey.replace(/^Bearer\s+/i, '') : '');
        if (incomingKey) {
            authHeaders['Authorization'] = `Bearer ${incomingKey}`;
        }
    }

    // Parse request body
    const requestBody = await request.json() as Record<string, unknown>;
    
    // Detect Gemini CLI and force non-streaming to avoid JSON parsing issues
    const userAgent = request.headers.get('user-agent') || '';
    if (userAgent.includes('gemini-cli')) {
        activeLogger.debug(requestId, 'Gemini CLI detected');
    }
    
    activeLogger.debug(requestId, `Request body keys: ${Object.keys(requestBody).join(', ')}`);

    let openaiRequest: Record<string, unknown>;
    let isStreaming: boolean;

    // Detect input format and convert to OpenAI
    if (isGeminiInteractionsRequest(requestBody)) {
      activeLogger.debug(requestId, 'Converting Gemini request to OpenAI format');
      
      // Check if it's generateContent format (has contents array)
      if (Array.isArray(requestBody.contents)) {
        activeLogger.debug(requestId, 'Detected generateContent format with contents array');
        openaiRequest = convertGeminiGenerateContentToOpenAI(requestBody);
      } else {
        activeLogger.debug(requestId, 'Detected Interactions format with input field');
        openaiRequest = convertGeminiInteractionsToOpenAI(requestBody);
      }
      
      isStreaming = (openaiRequest.stream as boolean) === true;
    } else {
      // Assume Claude format
      activeLogger.debug(requestId, 'Converting Claude request to OpenAI format');
      const claudeRequest = requestBody as unknown as ClaudeMessagesRequest;
      const converted = convertClaudeToOpenAIRequest(claudeRequest, modelId || claudeRequest.model);
      openaiRequest = converted as unknown as Record<string, unknown>;
      isStreaming = claudeRequest.stream === true;
    }

    // Override model if provided
    if (modelId) {
      openaiRequest.model = modelId;
    }

    // Force streaming for ?alt=sse query parameter
    if (forceStreaming || isStreamRequest) {
      openaiRequest.stream = true;
      isStreaming = true;
    }

    if (isGeminiEndpoint && (!upstreamMode || upstreamMode === 'openai-completions')) {
      defaultMissingOpenAIMessageRoles(openaiRequest);
    }

    // Cross-mode routes: re-target the converted Completions body to a different
    // upstream family. Done after the Gemini/Claude → Completions conversion so
    // we reuse that conversion ("through openai-completions transforming").
    if (upstreamMode === 'anthropic-messages') {
      return forwardCompletionsAsAnthropicMessages(
        openaiRequest, targetUrl, authHeaders, requestId,
        openaiRequest.model as string, activeLogger, request, env,
      );
    }
    if (upstreamMode === 'openai-responses') {
      return forwardCompletionsAsOpenAIResponses(
        openaiRequest, targetUrl, authHeaders, requestId,
        openaiRequest.model as string, activeLogger, request, env,
        isInteractionsRequest, isGenerateContentRequest, isStreaming,
      );
    }

    // Log request info
    activeLogger.debug(requestId, `OpenAI upstream url: ${targetUrl}`);
    activeLogger.debug(requestId, `Model: ${openaiRequest.model}, stream=${isStreaming}`);
    const authBaerer = authHeaders['Authorization'] || '';
    activeLogger.debug(requestId, `Authorization: ${authBaerer.substring(0, 16)}... upstream`);

    // Prepare headers
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...authHeaders,
    };

    try {
        // Check if this is an SDK URL
        if (isSdkUrl(targetUrl)) {
            // Extract API key from auth headers
            let apiKey: string | undefined;
            if (authHeaders['Authorization']) {
                apiKey = authHeaders['Authorization'].replace('Bearer ', '');
            } else if (authHeaders['x-api-key']) {
                apiKey = authHeaders['x-api-key'];
            } else if (authHeaders['x-goog-api-key']) {
                apiKey = authHeaders['x-goog-api-key'];
            }

            // Use SDK handler for OpenAI requests
            return handleSdkOpenAIRequest(
                request,
                targetUrl,
                requestId,
                apiKey,
                modelId,
                activeLogger,
                env,
                undefined,
                'openai',
                conversionOptions
            );
        }

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: addForwardedHeaders(headers, request),
            body: JSON.stringify(mapMaxTokensForUpstream(openaiRequest, targetUrl)),
            signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
        });

        recordResponseStatusCodeFromUpstream(response.status);
        recordUpstreamResponseToolCount('openai-completions', 0);

        // Handle target API errors
        if (!response.ok) {
            const errorText = await response.text();
            activeLogger.debug(requestId, `OpenAI API error: ${response.status} ${errorText}`);
            handleTargetApiError(response, 'OpenAI API', { url: targetUrl, upstreamBody: errorText });
        }

        // Handle streaming response
        if (isStreaming) {
            return handleOpenAIStreamingResponse(response, openaiRequest.model as string, requestId, activeLogger, isInteractionsRequest, isGenerateContentRequest);
        }

        // Handle non-streaming response
        return handleOpenAINonStreamingResponse(response, openaiRequest.model as string, requestId, activeLogger, isInteractionsRequest, isGenerateContentRequest);

    } catch (error) {
        activeLogger.debug(requestId, `OpenAI API error: ${(error as Error).message}`);
        throw error;
    }
}

/**
 * Handle OpenAI streaming response
 */
async function handleOpenAIStreamingResponse(
    response: Response,
    modelId: string,
    requestId: string,
    logger: Logger,
    isInteractionsRequest: boolean = false,
    isGenerateContentRequest: boolean = false
): Promise<Response> {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    logger.debug(requestId, `OpenAI streaming response started, status: ${response.status}, ok: ${response.ok}`);

    // Process stream
    (async () => {
        try {
            const reader = response.body?.getReader();
            if (!reader) {
                logger.error(requestId, 'No response body in streaming response');
                throw new Error('No response body');
            }

            let buffer = '';
            let chunkCount = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    logger.debug(requestId, `Stream ended, processed ${chunkCount} chunks`);
                    break;
                }

                // Append to buffer
                buffer += new TextDecoder().decode(value);
                chunkCount++;
                
                // Process complete SSE events
                const { processed, remaining } = processSSEBuffer(buffer, modelId, requestId, isInteractionsRequest, isGenerateContentRequest);
                buffer = remaining;
                
                if (processed) {
                    logger.debug(requestId, `OpenAI SSE chunk ${chunkCount}: ${processed.substring(0, 200)}...`);
                    await writer.write(encoder.encode(processed));
                }
            }

            // Process any remaining buffer
            if (buffer.trim()) {
                const { processed } = processSSEBuffer(buffer + '\n\n', modelId, requestId, isInteractionsRequest, isGenerateContentRequest);
                if (processed) {
                    logger.debug(requestId, `Final buffer processed: ${processed.substring(0, 200)}...`);
                    await writer.write(encoder.encode(processed));
                }
            }

            await writer.close();
        } catch (error) {
            logger.error(requestId, `OpenAI streaming error: ${(error as Error).message}`);
            await writer.abort();
        }
    })();

    return new Response(readable, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    });
}

/**
 * Handle OpenAI non-streaming response
 */
async function handleOpenAINonStreamingResponse(
    response: Response,
    modelId: string,
    requestId: string,
    logger: Logger,
    isInteractionsRequest: boolean = false,
    isGenerateContentRequest: boolean = false
): Promise<Response> {
    const openaiResponse = await response.json() as Record<string, unknown>;
    
    if (isGenerateContentRequest) {
        // Convert to Gemini generateContent format
        const geminiResponse = convertOpenAIToGeminiGenerateContent(
            openaiResponse as any,
            modelId,
            requestId
        );
        
        return new Response(JSON.stringify(geminiResponse), {
            headers: {
                'Content-Type': 'application/json',
                'x-request-id': requestId,
            },
        });
    } else if (isInteractionsRequest) {
        // Convert to Interactions format
        const interactionResponse = convertOpenAIToGeminiInteractions(
            openaiResponse as any,
            modelId,
            requestId
        );
        
        return new Response(JSON.stringify(interactionResponse), {
            headers: {
                'Content-Type': 'application/json',
                'x-request-id': requestId,
            },
        });
    }
    
    // Convert to Claude format
    const claudeResponse = convertOpenAIToClaudeResponse(openaiResponse as any, modelId, requestId);

    return new Response(JSON.stringify(claudeResponse), {
        headers: {
            'Content-Type': 'application/json',
        },
    });
}

/**
 * Convert OpenAI streaming chunk to Claude format
 */
/**
 * Process SSE buffer and extract complete events
 */
function processSSEBuffer(buffer: string, modelId: string, requestId: string, isInteractionsRequest: boolean = false, isGenerateContentRequest: boolean = false): { processed: string; remaining: string } {
    let result = '';
    let remaining = buffer;
    
    // Split by double newline (SSE event separator)
    const events = buffer.split('\n\n');
    
    // Last element might be incomplete, keep it in buffer
    remaining = events.pop() || '';
    
    for (const event of events) {
        if (!event.trim()) continue;
        
        const lines = event.split('\n');
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    if (isGenerateContentRequest) {
                        // Gemini generateContent doesn't need explicit end marker
                        continue;
                    } else {
                        result += 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
                    }
                } else {
                    try {
                        const parsed = JSON.parse(data);
                        
                        let convertedChunk: Record<string, any> | null = null;
                        
                        if (isGenerateContentRequest) {
                            // Convert to Gemini generateContent format
                            convertedChunk = convertOpenAIToGeminiGenerateContent(parsed, modelId, requestId);
                        } else if (isInteractionsRequest) {
                            // Convert to Gemini Interactions format
                            convertedChunk = convertOpenAIToGeminiInteractions(parsed, modelId, requestId);
                        } else {
                            // Convert to Claude format
                            convertedChunk = convertOpenAIToClaudeResponse(parsed, modelId, requestId);
                        }
                        
                        // Skip chunks with no endpoint-specific payload.
                        if (!convertedChunk || (!convertedChunk.candidates && !convertedChunk.content && !convertedChunk.outputs)) {
                            continue;
                        }
                        
                        result += `data: ${JSON.stringify(convertedChunk)}\n\n`;
                    } catch {
                        // Skip invalid JSON
                    }
                }
            }
        }
    }
    
    return { processed: result, remaining };
}

function convertOpenAIStreamToClaude(chunk: string, modelId: string, requestId: string): string | null {
    // Parse and convert OpenAI SSE format to Claude format
    const lines = chunk.split('\n');
    let result = '';
    
    for (const line of lines) {
        if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data.trim() === '[DONE]') {
                result += 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
            } else {
                try {
                    const parsed = JSON.parse(data);
                    // Convert OpenAI chunk to Claude chunk format
                    const claudeChunk = convertOpenAIToClaudeResponse(parsed, modelId, requestId);
                    result += `data: ${JSON.stringify(claudeChunk)}\n\n`;
                } catch {
                    // Pass through if parsing fails
                    result += line + '\n';
                }
            }
        }
    }
    
    return result || null;
}
