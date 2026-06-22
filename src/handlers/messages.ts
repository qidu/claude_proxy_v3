/**
 * Messages API handler for Claude Proxy v3
 *
 * Handles POST /v1/messages endpoint with extended thinking support
 */

import { Env } from '../types/shared.js';
import { Logger, createLogger } from '../utils/logger.js';
import { ClaudeMessagesRequest, ClaudeMessagesResponse } from '../types/claude.js';
import { OpenAIRequest, OpenAIResponse } from '../types/openai.js';
import { convertClaudeToOpenAIRequest, ThinkingConversionOptions } from '../converters/claude-to-openai.js';
import { convertOpenAIToClaudeResponse, TokenCountingConfig } from '../converters/openai-to-claude.js';
import { createStreamTransformer } from '../converters/streaming.js';
import { validateClaudeMessagesRequest } from '../utils/validation.js';
import { handleTargetApiError } from '../utils/errors.js';
import { normalizeOpenAIToClaudeThinking } from '../utils/thinking.js';
import { isSdkUrl, handleSdkOpenAIRequest, handleSdkAnthropicRequest } from '../utils/sdk-handler.js';
import { addForwardedHeaders } from '../utils/routing.js';
import { getLocalTokenCountingConfig } from '../utils/token-counting.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';
import { recordResponseStatusCodeFromUpstream, recordUpstreamResponseToolCount } from '../utils/dashboard-stats.js';

/**
 * Get token counting configuration from environment
 */
function getTokenCountingConfig(env?: Env): TokenCountingConfig {
  const config = getLocalTokenCountingConfig(env as unknown as Record<string, string>);
  return {
    enabled: config.enabled,
    modelName: config.modelName,
  };
}

function normalizeOpenAICompletionsBody(requestBody: Record<string, unknown>): Record<string, unknown> {
  const normalizedBody: Record<string, unknown> = { ...requestBody };
  const outputConfig = normalizedBody.output_config as Record<string, unknown> | undefined;
  if (outputConfig && normalizedBody.reasoning_effort === undefined && outputConfig.effort !== undefined) {
    normalizedBody.reasoning_effort = outputConfig.effort;
  }
  return normalizedBody;
}

/**
 * Handle messages API request
 */
export async function handleMessagesRequest(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  modelId?: string,
  env?: Env,
  logger?: Logger,
  conversionOptions?: ThinkingConversionOptions,
  upstreamMode?: string
): Promise<Response> {
  const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);

  // Clone request before parsing body to preserve body for SDK handler
  // Parse request body from cloned request
  const requestBody = isSdkUrl(targetUrl) ? await request.clone().json() as Record<string, unknown> : await request.json() as Record<string, unknown>;

  // Normalize OpenAI-style thinking ({ enabled, budget_tokens }) to Claude
  // format ({ type, budget_tokens }) up-front so downstream code (format
  // detection, validation, conversion) can assume the canonical shape.
  if (requestBody.thinking && typeof requestBody.thinking === 'object') {
    const normalized = normalizeOpenAIToClaudeThinking(requestBody.thinking);
    if (normalized) {
      requestBody.thinking = normalized;
    }
  }
  // const requestBody = await request.json() as Record<string, unknown>;
  
  // Detect Gemini CLI and force non-streaming to avoid JSON parsing issues
  const userAgent = request.headers.get('user-agent') || '';
  activeLogger.info(requestId, `UA: ${userAgent}, stream = ${requestBody.stream}`);
  
  // Check if request is already in OpenAI format
  // OpenAI format: { model, messages, stream, temperature, ... }
  // Claude format: { model, messages, max_tokens, thinking, system, ... }
  const hasClaudeContentBlocks = Array.isArray(requestBody.messages) && requestBody.messages.some((message) => {
    if (!message || typeof message !== 'object') {
      return false;
    }
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      return false;
    }

    return content.some((part) => {
      if (!part || typeof part !== 'object') {
        return false;
      }
      const partType = (part as Record<string, unknown>).type;
      return partType === 'text' || partType === 'tool_use' || partType === 'tool_result' || partType === 'thinking';
    });
  });

  const isOpenAIFormat = !requestBody.system && !requestBody.thinking && !requestBody.stop_sequences && !hasClaudeContentBlocks;

  // Additional check: if request has tools, check if they're in Claude format
  // Claude tools format: { name: string, description?: string, input_schema: any }
  // OpenAI tools format: { type: "function", function: { name: string, description?: string, parameters: any } }
  let hasClaudeFormatTools = false;
  if (requestBody.tools && Array.isArray(requestBody.tools)) {
    // Check if first tool has Claude format (has 'name' and 'input_schema' fields)
    const firstTool = requestBody.tools[0];
    if (firstTool && firstTool.name && firstTool.input_schema && !firstTool.type) {
      hasClaudeFormatTools = true;
    }
  }

  if (isOpenAIFormat && !hasClaudeFormatTools) {
    // Request is already in OpenAI format, pass through directly
    const openaiRequestBody = normalizeOpenAICompletionsBody(requestBody);
    const isStreaming = openaiRequestBody.stream === true;

    // Log thinking configuration before stripping (for openai-completions)
    const originalThinking = openaiRequestBody.thinking as { enabled?: boolean; budget_tokens?: number } | undefined;
    if (originalThinking) {
      const thinkingType = originalThinking.enabled ? 'enabled' : 'disabled';
      const budget = originalThinking.budget_tokens ? ` budget_tokens: ${originalThinking.budget_tokens}` : 'budget: unknown';
      activeLogger.info(requestId, `Thinking type: ${thinkingType} , ${budget} extracted from OpenAI-Format`);
    } else {
      activeLogger.info(requestId, `Thinking type: not specified by req body format=${isOpenAIFormat}`);
    }

    // openai-completions doesn't support thinking field; derive reasoning_effort from budget_tokens
    if (upstreamMode === 'openai-completions' && openaiRequestBody.thinking !== undefined) {
      const thinking = openaiRequestBody.thinking as { enabled?: boolean; budget_tokens?: number } | undefined;
      if (thinking?.enabled && thinking?.budget_tokens && !openaiRequestBody.reasoning_effort) {
        const budget = thinking.budget_tokens;
        openaiRequestBody.reasoning_effort = budget >= 4096 ? 'high' : budget >= 2048 ? 'medium' : 'low';
      }
      delete openaiRequestBody.thinking;
    }

    const model = (openaiRequestBody.model as string) || modelId || 'unknown';

    // Log request info
    activeLogger.info(requestId, `Upstream (stream=${isStreaming}): /v1/chat/completions → ${model}`);

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

        activeLogger.debug(requestId, `handle by sdk: url=${request.url}, method=${request.method}`);
        // Use SDK handler for OpenAI requests
        return handleSdkOpenAIRequest(
            request,
            targetUrl,
            requestId,
            apiKey,
            model,
            activeLogger,
            env,
            openaiRequestBody,
            'claude'
        );
    }

      const response = await fetch(targetUrl, {

      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...addForwardedHeaders(authHeaders, request),
      },
      body: JSON.stringify(openaiRequestBody),
      signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
    });

    // Debug log upstream response for test model requests (openai-passthrough, LOG_LEVEL=debug)
    if (env?.LOG_LEVEL === 'debug') {
      try {
        const bodyText = typeof requestBody === 'string' ? requestBody : JSON.stringify(requestBody);
        if (bodyText.includes('test_tool')) {
          const respClone = response.clone();
          const respBody = await respClone.text();
          const { appendFileSync } = await import('fs');
          appendFileSync('/tmp/test_model.log',
            `[${new Date().toISOString()}] upstream response (openai-passthrough)\n` +
            `upstream url: ${targetUrl}\n` +
            `upstream status: ${response.status}\n` +
            `upstream response body:\n${respBody.slice(0, 2000)}\n` +
            `---\n`,
          );
        }
      } catch (_e) { /* ignore */ }
    }

    recordResponseStatusCodeFromUpstream(response.status);
    recordUpstreamResponseToolCount('openai-completions', 0);

    // Handle target API errors
    if (!response.ok) {
      const bodyPreview = typeof requestBody === 'string'
        ? requestBody
        : JSON.stringify(requestBody);
      const upstreamResponseBody = await response.text();
      const upstreamBodyPreview = upstreamResponseBody.length > 500
        ? `${upstreamResponseBody.substring(0, 500)}...`
        : upstreamResponseBody;
      activeLogger.error(requestId, `Messages API error from upstream (openai-passthrough): ${response.status}, target URL: ${targetUrl}, request Body: ${bodyPreview.substring(0, 250)} ... ${bodyPreview.substring(bodyPreview.length - 250)}, upstream response body: ${upstreamBodyPreview}`);
      handleTargetApiError(response, 'Messages API', { url: targetUrl, body: bodyPreview, upstreamBody: upstreamResponseBody });
    }

    // Get local token counting config
    const tokenCountingConfig = getTokenCountingConfig(env);

    // For OpenAI format pass-through, convert response to Claude format
    if (isStreaming) {
      return handleStreamingResponse(response, model, requestId, activeLogger, openaiRequestBody, tokenCountingConfig);
    }
    return handleNonStreamingResponse(response, model, requestId, activeLogger, openaiRequestBody, tokenCountingConfig);
  }

  // Claude format - convert to OpenAI
  const claudeRequest = requestBody as unknown as ClaudeMessagesRequest;

  // Validate Claude request
  validateClaudeMessagesRequest(claudeRequest);

  // Log thinking type configuration
  const thinking = claudeRequest.thinking;
  if (thinking) {
    activeLogger.debug(requestId, `Thinking: ${JSON.stringify(thinking)}`);
    const thinkingType = thinking.type === true || thinking.type === 'enabled' || thinking.type === 'adaptive' ? 'enabled' : 'disabled';
    const budget = 'budget_tokens' in thinking && thinking.budget_tokens ? `budget_tokens: ${thinking.budget_tokens}` : 'budget: unknown';
    activeLogger.info(requestId, `Thinking type: ${thinkingType}, ${budget} extracted from Claude-Format`);
  } else {
    activeLogger.info(requestId, `Thinking type: not specified by req body format=message`);
  }

  // Get target model ID
  const targetModelId = modelId || claudeRequest.model;

  // Check if streaming is requested
  const isStreaming = claudeRequest.stream === true;

  // Log request info
  activeLogger.info(requestId, `Upstream (stream=${isStreaming}): /v1/chat/completions → ${targetModelId}`);
  activeLogger.debug(requestId, `Has auth headers: ${!!authHeaders['Authorization'] || !!authHeaders['x-api-key']}`);
  activeLogger.debug(requestId, `Is for SDK Model: ${isSdkUrl(targetUrl)} with upstreamMode: ${upstreamMode}`);

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

      // Use appropriate SDK handler based on upstream mode
      if (upstreamMode === 'anthropic-messages') {
          return handleSdkAnthropicRequest(
              request,
              targetUrl,
              requestId,
              apiKey,
              targetModelId,
              activeLogger,
              env,
              requestBody
          );
      }
      return handleSdkOpenAIRequest(
          request,
          targetUrl,
          requestId,
          apiKey,
          targetModelId,
          activeLogger,
          env,
          requestBody,
          'claude'
      );
  }

  // Convert to OpenAI format
  const openaiRequest: OpenAIRequest = convertClaudeToOpenAIRequest(claudeRequest, targetModelId, conversionOptions);

  // Strip thinking field for openai-completions (derive reasoning_effort from budget_tokens)
  if (upstreamMode === 'openai-completions' && openaiRequest.thinking !== undefined) {
    if (openaiRequest.thinking.enabled && openaiRequest.thinking.budget_tokens !== undefined && !openaiRequest.reasoning_effort) {
      const budget = openaiRequest.thinking.budget_tokens;
      openaiRequest.reasoning_effort = budget >= 4096 ? 'high' : budget >= 2048 ? 'medium' : 'low';
    }
    delete openaiRequest.thinking;
  }

  const upstreamRequest = JSON.stringify(openaiRequest);
  activeLogger.debug(requestId, `Converted request (claude->openai): ${upstreamRequest.substring(0, 250)} ... ${upstreamRequest.substring(upstreamRequest.length - 250)}`);

    const response = await fetch(targetUrl, {

    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...addForwardedHeaders(authHeaders, request),
    },
    body: JSON.stringify(openaiRequest),
    signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
  });

  // Debug log upstream response for test model requests (claude->openai, LOG_LEVEL=debug)
  if (env?.LOG_LEVEL === 'debug') {
    try {
      if (upstreamRequest.includes('test_tool')) {
        const respClone = response.clone();
        const respBody = await respClone.text();
        const { appendFileSync } = await import('fs');
        appendFileSync('/tmp/test_model.log',
          `[${new Date().toISOString()}] upstream response (claude->openai)\n` +
          `upstream url: ${targetUrl}\n` +
          `upstream status: ${response.status}\n` +
          `upstream response body:\n${respBody.slice(0, 2000)}\n` +
          `---\n`,
        );
      }
    } catch (_e) { /* ignore */ }
  }

  recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount('openai-completions', 0);

  // Handle target API errors
  if (!response.ok) {
    const bodyPreview = typeof openaiRequest === 'string'
      ? openaiRequest
      : JSON.stringify(openaiRequest);
    const upstreamResponseBody = await response.text();
    const upstreamBodyPreview = upstreamResponseBody.length > 500
      ? `${upstreamResponseBody.substring(0, 500)}...`
      : upstreamResponseBody;
    activeLogger.error(requestId, `Messages API error from upstream (claude->openai): ${response.status}, target URL: ${targetUrl}, request Body: ${bodyPreview.substring(0, 250)} ... ${bodyPreview.substring(bodyPreview.length - 250)}, upstream response body: ${upstreamBodyPreview}`);
    handleTargetApiError(response, 'Messages API', { url: targetUrl, body: bodyPreview, upstreamBody: upstreamResponseBody });
  }

  // Get local token counting config
  const tokenCountingConfig = getTokenCountingConfig(env);

  // Handle streaming response
  if (isStreaming) {
    return handleStreamingResponse(response, targetModelId, requestId, activeLogger, requestBody, tokenCountingConfig);
  }

  // Handle non-streaming response
  return handleNonStreamingResponse(response, targetModelId, requestId, activeLogger, requestBody, tokenCountingConfig);
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  response: Response,
  model: string,
  requestId: string,
  logger: Logger,
  requestBody?: Record<string, unknown>,
  tokenCountingConfig?: TokenCountingConfig
): Promise<Response> {
  try {
    // Parse target API response
    const responseText = await response.text();

    const openaiResponse: OpenAIResponse = JSON.parse(responseText);

    // Convert to Claude format
    const claudeResponse: ClaudeMessagesResponse = await convertOpenAIToClaudeResponse(
      openaiResponse,
      model,
      requestId,
      requestBody,
      tokenCountingConfig
    );

    // Return response with Claude headers
    return new Response(JSON.stringify(claudeResponse), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': requestId,
      },
    });
  } catch (error) {
    logger.error(requestId, `Error converting response: ${(error as Error).message}`);
    throw new Error(`Failed to convert response: ${(error as Error).message}`);
  }
}

/**
 * Handle streaming response
 */
async function handleStreamingResponse(
  response: Response,
  model: string,
  requestId: string,
  logger: Logger,
  requestBody?: Record<string, unknown>,
  tokenCountingConfig?: TokenCountingConfig
): Promise<Response> {
  // Check if response body exists and is readable
  if (!response.body) {
    throw new Error('Response body is not readable');
  }

  const decoder = new TextDecoder();

  try {

    // Create streaming transformer
    const transformer = createStreamTransformer(model, requestId, requestBody, tokenCountingConfig);

    // Create a tee to read the raw response while also transforming it
    const [stream1, stream2] = response.body.tee();

    // Read and log raw chunks from stream2
    const reader = stream2.getReader();
    const logRawChunks = async () => {
      try {
        let rawData = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          rawData += decoder.decode(value, { stream: true });
          // Log when we have complete lines
          const lines = rawData.split('\n');
          if (lines.length > 1) {
            for (const line of lines.slice(0, -1)) {
              if (line.startsWith('data: ')) {
                const data = line.substring(6);
                if (data.trim() !== '[DONE]') {
                  logger.debug(requestId, `Upstream SSE chunk: ${data}`);
                }
              }
            }
            rawData = lines[lines.length - 1] || '';
          }
        }
      } catch (e) {
        logger.error(requestId, `Error logging raw chunks: ${(e as Error).message}`);
      }
    };

    // Start logging in background
    logRawChunks();

    // Create transformed stream from stream1
    const transformedStream = stream1
      .pipeThrough(new TransformStream(transformer));

    // Return streaming response with proper headers
    return new Response(transformedStream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'x-request-id': requestId,
      },
    });
  } catch (error) {
    logger.error(requestId, `Error creating streaming response: ${(error as Error).message}`);
    throw new Error(`Failed to create streaming response: ${(error as Error).message}`);
  }
}
