/**
 * Embeddings API handler for Claude Proxy v3
 *
 * Proxies /v1/embeddings requests to the upstream OpenAI-compatible API.
 */

import type { Env, Logger } from '../types/shared.js';
import { createErrorResponse } from '../utils/errors.js';
import { addForwardedHeaders } from '../utils/routing.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';

/**
 * Handle embeddings API request
 */
export async function handleEmbeddingsRequest(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  logger: Logger,
  _env: Env,
): Promise<Response> {
  logger.info(requestId, `Embeddings request -> ${targetUrl}`);

  // Parse request body
  const bodyText = await request.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return createErrorResponse(new Error('Invalid JSON body'), requestId, 400);
  }

  // Validate required fields
  if (!body.model || typeof body.model !== 'string') {
    return createErrorResponse(new Error('Missing required field: model'), requestId, 400);
  }
  if (body.input === undefined || body.input === null) {
    return createErrorResponse(new Error('Missing required field: input'), requestId, 400);
  }

  // Make upstream request
  const upstreamResponse = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...addForwardedHeaders(authHeaders, request),
    },
    body: JSON.stringify(body),
    signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(_env as Record<string, unknown>)),
  });

  if (!upstreamResponse.ok) {
    logger.error(requestId, `Upstream embedding error: ${upstreamResponse.status}`);
    // Forward upstream error as-is
    const errorText = await upstreamResponse.text();
    return new Response(errorText, {
      status: upstreamResponse.status,
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': requestId,
      },
    });
  }

  const responseText = await upstreamResponse.text();
  let responseData: Record<string, unknown>;
  try {
    responseData = JSON.parse(responseText);
  } catch {
    return createErrorResponse(new Error('Invalid upstream response'), requestId, 502);
  }

  // Strip provider field if present (as noted in the API spec)
  if (responseData.provider !== undefined) {
    delete responseData.provider;
  }

  return new Response(JSON.stringify(responseData), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': requestId,
    },
  });
}