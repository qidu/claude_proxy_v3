/**
 * Messages API handler for Claude Proxy v3
 *
 * Handles POST /v1/messages endpoint with extended thinking support
 */

import { Env } from '../types/shared.js';
import { Logger, createLogger } from '../utils/logger.js';
import { ClaudeMessagesRequest, ClaudeMessagesResponse } from '../types/claude.js';
import { OpenAIRequest, OpenAIResponse } from '../types/openai.js';
import { convertClaudeToOpenAIRequest } from '../converters/claude-to-openai.js';
import { convertOpenAIToClaudeResponse } from '../converters/openai-to-claude.js';
import { createStreamTransformer } from '../converters/streaming.js';
import { validateClaudeMessagesRequest, validateAuthHeaders } from '../utils/validation.js';
import { handleTargetApiError } from '../utils/errors.js';

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
  logger?: Logger
): Promise<Response> {
  const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);
  // Parse request body
  const requestBody = await request.json() as Record<string, unknown>;
  
  // Detect Gemini CLI and force non-streaming to avoid JSON parsing issues
  const userAgent = request.headers.get('user-agent') || '';
  if (userAgent.includes('gemini-cli') && requestBody.stream !== false) {
    activeLogger.debug(requestId, 'Gemini CLI detected, forcing stream=false');
    requestBody.stream = false;
  }
  
  // Check if request is already in OpenAI format
  // OpenAI format: { model, messages, stream, temperature, ... }
  // Claude format: { model, messages, max_tokens, thinking, system, ... }
  const isOpenAIFormat = !requestBody.system && !requestBody.thinking && !requestBody.stop_sequences;

  if (isOpenAIFormat) {
    // Request is already in OpenAI format, pass through directly
    const model = (requestBody.model as string) || modelId || 'unknown';
    const isStreaming = requestBody.stream === true;

    // Log request info
    activeLogger.debug(requestId, `Upstream request url: ${targetUrl}`);
    activeLogger.debug(requestId, `Is streaming: ${isStreaming}`);

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify(requestBody),
    });

    // Handle target API errors
    if (!response.ok) {
      handleTargetApiError(response, 'Messages API');
    }

    // For OpenAI format pass-through, convert response to Claude format
    if (isStreaming) {
      return handleStreamingResponse(response, model, requestId, activeLogger);
    }
    return handleNonStreamingResponse(response, model, requestId, activeLogger);
  }

  // Claude format - convert to OpenAI
  const claudeRequest = requestBody as unknown as ClaudeMessagesRequest;

  // Validate Claude request
  validateClaudeMessagesRequest(claudeRequest);

  // Get target model ID
  const targetModelId = modelId || claudeRequest.model;

  // Convert to OpenAI format
  const openaiRequest: OpenAIRequest = convertClaudeToOpenAIRequest(claudeRequest, targetModelId);

  // Check if streaming is requested
  const isStreaming = claudeRequest.stream === true;

  // Log request info
  activeLogger.info(requestId, `Calling upstream: ${targetUrl}`);
  activeLogger.debug(requestId, `Upstream request url: ${targetUrl}`);
  activeLogger.debug(requestId, `Has auth headers: ${!!authHeaders['Authorization'] || !!authHeaders['x-api-key']}`);
  activeLogger.debug(requestId, `Is streaming: ${isStreaming}`);
  
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify(openaiRequest),
  });

  // Handle target API errors
  if (!response.ok) {
    handleTargetApiError(response, 'Messages API');
  }

  // Handle streaming response
  if (isStreaming) {
    return handleStreamingResponse(response, targetModelId, requestId, activeLogger);
  }

  // Handle non-streaming response
  return handleNonStreamingResponse(response, targetModelId, requestId, activeLogger);
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  response: Response,
  model: string,
  requestId: string,
  logger: Logger
): Promise<Response> {
  try {
    // Parse target API response
    const responseText = await response.text();
    logger.debug(requestId, 'Upstream response body.');

    const openaiResponse: OpenAIResponse = JSON.parse(responseText);

    // Convert to Claude format
    const claudeResponse: ClaudeMessagesResponse = convertOpenAIToClaudeResponse(
      openaiResponse,
      model,
      requestId
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
  logger: Logger
): Promise<Response> {
  // Check if response body exists and is readable
  if (!response.body) {
    throw new Error('Response body is not readable');
  }

  const decoder = new TextDecoder();

  try {
    // Log streaming response
    logger.debug(requestId, 'Upstream streaming response started');

    // Create streaming transformer
    const transformer = createStreamTransformer(model, requestId);

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
