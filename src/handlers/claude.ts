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

    // Ensure max_tokens has a default value (required by Anthropic API and some compatible endpoints)
    if (requestBody.max_tokens === undefined || requestBody.max_tokens === null) {
        const defaultMaxTokens = parseInt(env?.DEFAULT_MAX_TOKENS || '8192', 10);
        requestBody.max_tokens = isNaN(defaultMaxTokens) ? 8192 : defaultMaxTokens;
        activeLogger.debug(requestId, `max_tokens missing, defaulting to ${requestBody.max_tokens}`);
    }

    // Some upstreams (e.g., DeepSeek Anthropic-compatible API) default to thinking mode
    // and require prior thinking blocks in conversation. Explicitly disable thinking
    // when the client hasn't set it to avoid 400 errors on first requests.
    // Also handle the case where thinking is enabled but no prior thinking blocks exist
    // in the conversation history (e.g., first request in a conversation).
    if (requestBody.thinking === undefined || requestBody.thinking === null) {
        requestBody.thinking = { type: 'disabled' };
        activeLogger.debug(requestId, 'thinking not set, defaulting to disabled');
    } else if (typeof requestBody.thinking === 'object') {
        const thinkingObj = requestBody.thinking as Record<string, unknown>;
        const thinkingType = thinkingObj.type;
        const isEnabled = thinkingType === 'enabled' || thinkingType === true || thinkingType === 'adaptive';
        if (isEnabled) {
            // Check if there are any prior assistant thinking blocks in the conversation
            const messages = requestBody.messages as any[] | undefined;
            const hasPriorThinking = Array.isArray(messages) && messages.some(msg =>
                msg.role === 'assistant' && Array.isArray(msg.content) &&
                msg.content.some((c: any) => c.type === 'thinking')
            );
            if (!hasPriorThinking) {
                activeLogger.debug(requestId, 'thinking enabled but no prior thinking blocks found, disabling');
                delete requestBody.thinking;
            }
        }
    }

    activeLogger.debug(requestId, `Claude native upstream: ${targetUrl}`);
    activeLogger.debug(requestId, `Model: ${modelId || requestBody.model}`);
    activeLogger.debug(requestId, `Streaming: ${isStreaming}`);
    activeLogger.debug(requestId, `Has thinking config: ${JSON.stringify(requestBody.thinking)}`);
    if (Array.isArray(requestBody.messages)) {
        const lastAssistantMsg = [...requestBody.messages as any[]].reverse().find(m => m.role === 'assistant');
        if (lastAssistantMsg && Array.isArray(lastAssistantMsg.content)) {
            const thinkingBlocks = lastAssistantMsg.content.filter((c: any) => c.type === 'thinking');
            activeLogger.debug(requestId, `Last assistant message has ${thinkingBlocks.length} thinking content blocks`);
        }
    }

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
    const requestBodyStr = JSON.stringify(requestBody);
    activeLogger.debug(requestId, `Sending to upstream: ${requestBodyStr}`);
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
        // Read upstream response body for diagnostics
        let upstreamErrorBody = '';
        try {
            upstreamErrorBody = await response.text();
            activeLogger.error(requestId, `Upstream error response (${response.status}): ${upstreamErrorBody.substring(0, 2000)}`);
        } catch {
            upstreamErrorBody = '(failed to read response body)';
        }
        const bodyPreview = JSON.stringify(requestBody).substring(0, 1000);
        handleTargetApiError(response, 'Claude API', { url: targetUrl, body: bodyPreview });
    }

    // Return response as-is (pass-through)
    return new Response(response.body, {
        status: response.status,
        headers: response.headers,
    });
}
