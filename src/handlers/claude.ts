/**
 * Claude API handler for native Claude endpoints
 * Handles pass-through to AWS Bedrock, Vertex AI, or Anthropic API
 */

import { Env, Logger } from '../types/shared.js';
import { createLogger } from '../utils/logger.js';
import { handleTargetApiError } from '../utils/errors.js';
import { isSdkUrl, handleSdkAnthropicRequest } from '../utils/sdk-handler.js';
import { addForwardedHeaders } from '../utils/routing.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';

/**
 * Handle native Claude API request (pass-through)
 */
export async function handleClaudeRequest(
    request: Request,
    targetUrl: string,
    authHeaders: Record<string, string>,
    requestId: string,
    modelId?: string,
    env?: Env,
    logger?: Logger
): Promise<Response> {
    const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);

    // Clone request before parsing body to preserve body for SDK handler
    // Parse request body from cloned request
    const requestBody = isSdkUrl(targetUrl) ? await request.clone().json() as Record<string, unknown> : await request.json() as Record<string, unknown>;
    // Parse request body
    //const requestBody = await request.json() as Record<string, unknown>;
    
    const isStreaming = requestBody.stream === true;

    // Use modelId (which may be an alias) if provided
    if (modelId) {
        requestBody.model = modelId;
    }

    activeLogger.debug(requestId, `Claude native upstream: ${targetUrl}`);
    activeLogger.debug(requestId, `Model: ${modelId || requestBody.model}`);
    activeLogger.debug(requestId, `Streaming: ${isStreaming}`);

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

        // Use SDK handler for Anthropic requests
        return handleSdkAnthropicRequest(
            request,
            targetUrl,
            requestId,
            apiKey,
            modelId,
            activeLogger,
            env,
            requestBody
        );
    }

    // Pass through to native Claude API
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
        const bodyPreview = JSON.stringify(requestBody).substring(0, 1000);
        handleTargetApiError(response, 'Claude API', { url: targetUrl, body: bodyPreview });
    }

    // Return response as-is (pass-through)
    return new Response(response.body, {
        status: response.status,
        headers: response.headers,
    });
}
