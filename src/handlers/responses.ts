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
import { convertCompletionsToResponses } from '../converters/completions-to-responses.js';

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
  const model = (requestBody.model as string) || modelId || 'unknown';

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
  // Convert Responses API request to Chat Completions format
  const completionsRequest = convertResponsesToChatCompletions(requestBody, model);

  logger.debug(requestId, `Converted to completions format: ${JSON.stringify(completionsRequest).substring(0, 500)}`);

  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...addForwardedHeaders(authHeaders, request),
    },
    body: JSON.stringify(completionsRequest),
    signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
  });

  if (!response.ok) {
    const bodyPreview = JSON.stringify(completionsRequest);
    logger.error(requestId, `Responses->Completions API error: ${response.status}, URL: ${targetUrl}`);
    handleTargetApiError(response, 'Responses API (via Completions)', { url: targetUrl, body: bodyPreview });
  }

  if (isStreaming) {
    // For streaming, we need to pass through but the response format is different
    // Chat Completions streaming uses a different format than Responses API
    // Currently pass through as-is (responses API doesn't support streaming in same format)
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

  // Convert Chat Completions response back to Responses API format
  const responseText = await response.text();
  const completionsResponse = JSON.parse(responseText) as OpenAIResponse;
  const responsesResponse = convertCompletionsToResponses(completionsResponse, model);

  return new Response(JSON.stringify(responsesResponse), {
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

  if (!response.ok) {
    const bodyPreview = JSON.stringify(requestBody);
    logger.error(requestId, `Responses API error: ${response.status}, URL: ${targetUrl}`);
    handleTargetApiError(response, 'Responses API', { url: targetUrl, body: bodyPreview });
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