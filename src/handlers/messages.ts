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
import { isSdkUrl, handleSdkOpenAIRequest, handleSdkAnthropicRequest } from '../utils/sdk-handler.js';
import { addForwardedHeaders } from '../utils/routing.js';
import { getLocalTokenCountingConfig } from '../utils/token-counting.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';

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
  // const requestBody = await request.json() as Record<string, unknown>;
  
  // Detect Gemini CLI and force non-streaming to avoid JSON parsing issues
  const userAgent = request.headers.get('user-agent') || '';
  activeLogger.info(requestId, `UA: ${userAgent}, stream = ${requestBody.stream}`);
  
  // Check if request is already in OpenAI format
  // OpenAI format: { model, messages, stream, temperature, ... }
  // Claude format: { model, messages, max_tokens, thinking, system, ... }
  const isOpenAIFormat = !requestBody.system && !requestBody.thinking && !requestBody.stop_sequences;

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
    const model = (openaiRequestBody.model as string) || modelId || 'unknown';
    const isStreaming = openaiRequestBody.stream === true;

    // Log thinking configuration if present (OpenAI format)
    const openaiThinking = openaiRequestBody.thinking as { enabled?: boolean; budget_tokens?: number } | undefined;
    if (openaiThinking) {
      const thinkingType = openaiThinking.enabled ? 'enabled' : 'disabled';
      const budget = openaiThinking.budget_tokens ? ` budget_tokens: ${openaiThinking.budget_tokens}` : 'budget: unknown';
      activeLogger.info(requestId, `Thinking type: ${thinkingType} , ${budget} extracted from OpenAI-Format`);
    } else {
      activeLogger.info(requestId, `Thinking type: not specified by req body format=${isOpenAIFormat}`);
    }

    // Log request info
    activeLogger.info(requestId, `Upstream target url (stream=${isStreaming}): ${targetUrl}`);

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
            openaiRequestBody
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

    // Handle target API errors
    if (!response.ok) {
      const bodyPreview = typeof requestBody === 'string'
        ? requestBody
        : JSON.stringify(requestBody);
      activeLogger.error(requestId, `Messages API error from upstream (openai-passthrough): ${response.status}, target URL: ${targetUrl}, request Body: ${bodyPreview.substring(0, 250)} ... ${bodyPreview.substring(bodyPreview.length - 250)}`);
      handleTargetApiError(response, 'Messages API', { url: targetUrl, body: bodyPreview });
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
  activeLogger.info(requestId, `Upstream target url (stream =${isStreaming}) : ${targetUrl}`);
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
          requestBody
      );
  }

  // Convert to OpenAI format
  const openaiRequest: OpenAIRequest = convertClaudeToOpenAIRequest(claudeRequest, targetModelId, conversionOptions);
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

  // Handle target API errors
  if (!response.ok) {
    const bodyPreview = typeof openaiRequest === 'string'
      ? openaiRequest
      : JSON.stringify(openaiRequest);
    activeLogger.error(requestId, `Messages API error from upstream (claude->openai): ${response.status}, target URL: ${targetUrl}, request Body: ${bodyPreview.substring(0, 250)} ... ${bodyPreview.substring(bodyPreview.length - 250)}`);
    handleTargetApiError(response, 'Messages API', { url: targetUrl, body: bodyPreview });
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
