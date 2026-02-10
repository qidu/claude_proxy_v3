/**
 * Gemini API handler for Claude Proxy v3
 *
 * Handles interactions with Gemini Generative Language API
 * Supports both standard Claude API format and Gemini Interactions API
 */

import { Env } from '../types/shared';
import { Logger, createLogger } from '../utils/logger';
import { ClaudeMessagesRequest, ClaudeMessagesResponse } from '../types/claude';
import { GeminiInteractionRequest, GeminiInteractionResponse } from '../types/gemini';
import { convertClaudeToGeminiRequest } from '../converters/claude-to-gemini';
import { convertGeminiToClaudeResponse } from '../converters/gemini-to-claude';
import { createGeminiStreamTransformer } from '../converters/gemini-streaming';
import { convertClaudeToOpenAIRequest } from '../converters/claude-to-openai';
import { convertOpenAIToClaudeResponse } from '../converters/openai-to-claude';
import { createStreamTransformer } from '../converters/streaming';
import { handleTargetApiError } from '../utils/errors';

/**
 * Gemini API configuration
 */
interface GeminiConfig {
    baseUrl: string;
    apiVersion: string;
    endpointType: 'interactions' | 'openai-compatible';
}

/**
 * Default Gemini API configuration
 */
const DEFAULT_GEMINI_CONFIG: GeminiConfig = {
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiVersion: 'v1beta',
    endpointType: 'openai-compatible',
};

/**
 * Get Gemini API configuration from environment
 */
function getGeminiConfig(env: Env): GeminiConfig {
    return {
        baseUrl: env.GEMINI_BASE_URL || DEFAULT_GEMINI_CONFIG.baseUrl,
        apiVersion: env.GEMINI_API_VERSION || DEFAULT_GEMINI_CONFIG.apiVersion,
        endpointType: env.GEMINI_ENDPOINT_TYPE || DEFAULT_GEMINI_CONFIG.endpointType,
    };
}

/**
 * Check if request is in native Gemini format
 */
function isNativeGeminiRequest(body: Record<string, unknown>): boolean {
    // Native Gemini requests have 'input' field, Claude requests have 'messages'
    return 'input' in body && !('messages' in body);
}

/**
 * Handle Gemini API request (factory function)
 */
export async function handleGeminiRequest(
    request: Request,
    targetUrl: string,
    authHeaders: Record<string, string>,
    requestId: string,
    modelId?: string,
    env?: Env,
    logger?: Logger
): Promise<Response> {
    const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);
    const config = getGeminiConfig(env ?? {});

    activeLogger.debug(requestId, `Gemini endpoint type: ${config.endpointType}`);
    activeLogger.debug(requestId, `Gemini base URL: ${config.baseUrl}`);
    activeLogger.debug(requestId, `Gemini API version: ${config.apiVersion}`);

    if (config.endpointType === 'interactions') {
        return handleGeminiInteractionsRequest(
            request, targetUrl, authHeaders, requestId, modelId, env, logger
        );
    } else {
        return handleGeminiOpenAICompatibleRequest(
            request, targetUrl, authHeaders, requestId, modelId, env, logger
        );
    }
}

/**
 * Handle Gemini Interactions API request
 */
async function handleGeminiInteractionsRequest(
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

    // Determine if this is a native Gemini request or needs conversion from Claude format
    let geminiRequest: GeminiInteractionRequest;
    let isStreaming: boolean;

    if (isNativeGeminiRequest(requestBody)) {
        // Native Gemini format - use directly
        activeLogger.debug(requestId, 'Using native Gemini request format');
        geminiRequest = requestBody as unknown as GeminiInteractionRequest;
        isStreaming = geminiRequest.stream === true;
    } else {
        // Claude format - convert to Gemini
        activeLogger.debug(requestId, 'Converting Claude request to Gemini format');
        const claudeRequest = requestBody as unknown as ClaudeMessagesRequest;
        geminiRequest = convertClaudeToGeminiRequest(claudeRequest, modelId);
        isStreaming = claudeRequest.stream === true;
    }

    // Determine the target endpoint - append to existing targetUrl since parseFixedRoute already set it up
    const endpoint = determineGeminiEndpoint(request, geminiRequest);
    const fullTargetUrl = endpoint ? `${targetUrl}${endpoint}` : targetUrl;

    // Log request info
    activeLogger.debug(requestId, `Gemini upstream request url: ${fullTargetUrl}`);
    activeLogger.debug(requestId, `Gemini model: ${geminiRequest.model}`);
    activeLogger.debug(requestId, `Is streaming: ${isStreaming}`);

    // Prepare headers for Gemini API
    const geminiHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
    };

    // Add API key from headers or environment
    const apiKey = extractGeminiApiKey(request, authHeaders, env, 'interactions');
    if (apiKey) {
        geminiHeaders['x-goog-api-key'] = apiKey;
    }

    // Forward other auth headers
    if (authHeaders['Authorization']) {
        // Keep Authorization for backward compatibility
    }

    try {
        const response = await fetch(fullTargetUrl, {
            method: 'POST',
            headers: geminiHeaders,
            body: JSON.stringify(geminiRequest),
        });

        // Handle target API errors
        if (!response.ok) {
            handleTargetApiError(response, 'Gemini API');
        }

        // Handle streaming response
        if (isStreaming) {
            return handleGeminiStreamingResponse(response, geminiRequest.model || 'gemini-pro', requestId, activeLogger, 'interactions');
        }

        // Handle non-streaming response
        return handleGeminiNonStreamingResponse(response, geminiRequest.model || 'gemini-pro', requestId, activeLogger, 'interactions');

    } catch (error) {
        activeLogger.error(requestId, `Gemini API error: ${(error as Error).message}`);
        throw error;
    }
}

/**
 * Handle OpenAI-compatible Gemini wrapper request
 */
async function handleGeminiOpenAICompatibleRequest(
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

    // Always convert Claude to OpenAI format for OpenAI-compatible endpoints
    activeLogger.debug(requestId, 'Converting Claude request to OpenAI format for Gemini');
    const claudeRequest = requestBody as unknown as ClaudeMessagesRequest;
    const openaiRequest = convertClaudeToOpenAIRequest(claudeRequest, modelId || claudeRequest.model);
    const isStreaming = claudeRequest.stream === true;

    // Log request info
    activeLogger.debug(requestId, `Gemini upstream request url: ${targetUrl}`);
    activeLogger.debug(requestId, `Gemini model: ${openaiRequest.model}`);
    activeLogger.debug(requestId, `Is streaming: ${isStreaming}`);

    // Prepare headers for OpenAI-compatible API
    const openaiHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
    };

    // Add API key from headers or environment
    const apiKey = extractGeminiApiKey(request, authHeaders, env, 'openai-compatible');
    if (apiKey) {
        openaiHeaders['Authorization'] = `Bearer ${apiKey}`;
    }

    // Forward other auth headers
    if (authHeaders['Authorization']) {
        openaiHeaders['Authorization'] = authHeaders['Authorization'];
    }

    try {
        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: openaiHeaders,
            body: JSON.stringify(openaiRequest),
        });

        // Handle target API errors
        if (!response.ok) {
            handleTargetApiError(response, 'Gemini API (OpenAI-compatible)');
        }

        // Handle streaming response
        if (isStreaming) {
            return handleGeminiStreamingResponse(response, openaiRequest.model, requestId, activeLogger, 'openai-compatible');
        }

        // Handle non-streaming response
        return handleGeminiNonStreamingResponse(response, openaiRequest.model, requestId, activeLogger, 'openai-compatible');

    } catch (error) {
        activeLogger.error(requestId, `Gemini API (OpenAI-compatible) error: ${(error as Error).message}`);
        throw error;
    }
}

/**
 * Determine the Gemini endpoint based on request
 */
function determineGeminiEndpoint(request: Request, geminiRequest: GeminiInteractionRequest): string {
    const url = new URL(request.url);
    const path = url.pathname;

    // Check for specific endpoints
    if (path.endsWith('/cancel')) {
        // Cancel interaction
        const interactionId = extractInteractionId(path);
        // Return just the interaction ID suffix (parseFixedRoute already handles /interactions)
        return `/${interactionId}/cancel`;
    }

    if (path.match(/\/interactions\/[a-zA-Z0-9_-]+$/)) {
        // Get interaction
        const interactionId = extractInteractionId(path);
        const queryParams = new URLSearchParams();
        if (url.searchParams.get('stream') === 'true') {
            queryParams.set('stream', 'true');
        }
        const query = queryParams.toString();
        // Return just the interaction ID suffix (parseFixedRoute already handles /interactions)
        return `/${interactionId}${query ? '?' + query : ''}`;
    }

    if (request.method === 'DELETE') {
        // Delete interaction
        const interactionId = extractInteractionId(path);
        // Return just the interaction ID suffix (parseFixedRoute already handles /interactions)
        return `/${interactionId}`;
    }

    // Default: create interaction
    // Return empty string since parseFixedRoute already includes /interactions
    return '';
}

/**
 * Extract interaction ID from path
 */
function extractInteractionId(path: string): string {
    const parts = path.split('/');
    const interactionIndex = parts.findIndex(p => p === 'interactions');
    if (interactionIndex >= 0 && parts[interactionIndex + 1]) {
        return parts[interactionIndex + 1];
    }
    throw new Error('Invalid interaction path');
}

/**
 * Extract Gemini API key from request or environment
 */
function extractGeminiApiKey(
    request: Request,
    authHeaders: Record<string, string>,
    env?: Env,
    endpointType: 'interactions' | 'openai-compatible' = 'interactions'
): string | undefined {
    if (endpointType === 'openai-compatible') {
        // OpenAI-compatible endpoints: Authorization: Bearer or x-api-key
        const authHeader = authHeaders['Authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            return authHeader.slice(7);
        }

        const apiKeyHeader = request.headers.get('x-api-key');
        if (apiKeyHeader) {
            return apiKeyHeader;
        }

        // Check environment variable
        if (env?.GEMINI_API_KEY) {
            return env.GEMINI_API_KEY;
        }
    } else {
        // Native Gemini API: x-goog-api-key or Authorization: Bearer
        const headerKey = request.headers.get('x-goog-api-key');
        if (headerKey) {
            return headerKey;
        }

        const authHeader = authHeaders['Authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
            return authHeader.slice(7);
        }

        const apiKeyHeader = request.headers.get('x-api-key');
        if (apiKeyHeader) {
            return apiKeyHeader;
        }

        if (env?.GEMINI_API_KEY) {
            return env.GEMINI_API_KEY;
        }
    }

    return undefined;
}

/**
 * Handle non-streaming response
 */
async function handleGeminiNonStreamingResponse(
    response: Response,
    model: string,
    requestId: string,
    logger: Logger,
    endpointType: 'interactions' | 'openai-compatible' = 'interactions'
): Promise<Response> {
    try {
        const responseText = await response.text();
        logger.debug(requestId, 'Gemini response received');

        if (endpointType === 'openai-compatible') {
            // Parse OpenAI-compatible response
            const openaiResponse = JSON.parse(responseText);
            const claudeResponse = convertOpenAIToClaudeResponse(
                openaiResponse,
                model,
                requestId
            );
            return new Response(JSON.stringify(claudeResponse), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'x-request-id': requestId,
                },
            });
        } else {
            // Parse native Gemini response
            const geminiResponse: GeminiInteractionResponse = JSON.parse(responseText);

            // Convert to Claude format
            const claudeResponse: ClaudeMessagesResponse = convertGeminiToClaudeResponse(
                geminiResponse,
                model,
                requestId
            );

            return new Response(JSON.stringify(claudeResponse), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'x-request-id': requestId,
                },
            });
        }
    } catch (error) {
        logger.error(requestId, `Error converting Gemini response: ${(error as Error).message}`);
        throw new Error(`Failed to convert Gemini response: ${(error as Error).message}`);
    }
}

/**
 * Handle streaming response
 */
async function handleGeminiStreamingResponse(
    response: Response,
    model: string,
    requestId: string,
    logger: Logger,
    endpointType: 'interactions' | 'openai-compatible' = 'interactions'
): Promise<Response> {
    if (!response.body) {
        throw new Error('Response body is not readable');
    }

    const decoder = new TextDecoder();

    try {
        logger.debug(requestId, 'Gemini streaming response started');

        // Create streaming transformer based on endpoint type
        const transformer = endpointType === 'openai-compatible'
            ? createStreamTransformer(model, requestId)
            : createGeminiStreamTransformer(model, requestId);

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
                    const lines = rawData.split('\n');
                    if (lines.length > 1) {
                        for (const line of lines.slice(0, -1)) {
                            if (line.startsWith('data: ')) {
                                const data = line.substring(6);
                                if (data.trim() !== '[DONE]') {
                                    logger.debug(requestId, `Gemini SSE chunk: ${data}`);
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
        const transformerObj = transformer as any;
        const transformedStream = stream1
            .pipeThrough(new TransformStream(transformerObj));

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

/**
 * Check if a request is for Gemini API
 */
export function isGeminiRequest(request: Request, targetUrl: string): boolean {
    const url = new URL(request.url);
    const path = url.pathname;

    // Check if path indicates Gemini API
    if (path.includes('/v1/interactions') ||
        path.includes('/v1beta/interactions') ||
        targetUrl.includes('generativelanguage.googleapis.com')) {
        return true;
    }

    // Check for Gemini model identifiers in request
    if (targetUrl.includes('gemini')) {
        return true;
    }

    return false;
}
