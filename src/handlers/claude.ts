/**
 * Claude API handler for native Claude endpoints
 * Handles pass-through to AWS Bedrock, Vertex AI, or Anthropic API
 */

import { Env, Logger } from '../types/shared.js';
import { createLogger } from '../utils/logger.js';
import { handleTargetApiError } from '../utils/errors.js';

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

    // Parse request body
    const requestBody = await request.json() as Record<string, unknown>;
    const isStreaming = requestBody.stream === true;

    // Use modelId (which may be an alias) if provided
    if (modelId) {
        requestBody.model = modelId;
    }

    activeLogger.debug(requestId, `Claude native upstream: ${targetUrl}`);
    activeLogger.debug(requestId, `Model: ${modelId || requestBody.model}`);
    activeLogger.debug(requestId, `Streaming: ${isStreaming}`);

    // Pass through to native Claude API
    const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
        },
        body: JSON.stringify(requestBody),
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
