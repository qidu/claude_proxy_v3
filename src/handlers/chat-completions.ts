/**
 * Passthrough handler for /v1/chat/completions.
 * Forwards the request as-is to the upstream OpenAI-compatible endpoint.
 * No format conversion is performed.
 */

import type { Env, Logger } from '../types/shared.js';
import { addForwardedHeaders } from '../utils/routing.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';
import { recordResponseStatusCodeFromUpstream } from '../utils/dashboard-stats.js';
import { validateOpenAICompletionsRequest } from '../utils/validation.js';
import { ValidationError } from '../utils/errors.js';

export async function handleChatCompletionsPassthrough(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  logger: Logger,
  env: Env,
  modelId?: string,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  logger.info(requestId, `${path} passthrough → ${targetUrl} model=${modelId || 'unknown'}`);

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

  const upstreamResponse = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...addForwardedHeaders(authHeaders, request),
    },
    body: bodyText,
    signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env as Record<string, unknown>)),
  });

  recordResponseStatusCodeFromUpstream(upstreamResponse.status);
  logger.info(requestId, `${path} resp: status=${upstreamResponse.status} stream=${isStreaming}`);

  // Forward the response body as-is -- preserve streaming or JSON
  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.set('x-request-id', requestId);

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
