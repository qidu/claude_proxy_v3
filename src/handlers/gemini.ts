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
import { handleTargetApiError } from '../utils/errors';

/**
 * Gemini API configuration
 */
interface GeminiConfig {
    baseUrl: string;
    apiVersion: string;
}

/**
 * Default Gemini API configuration
 */
const DEFAULT_GEMINI_CONFIG: GeminiConfig = {
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiVersion: 'v1beta',
};

/**
 * Get Gemini API configuration from environment
 */
function getGeminiConfig(env: Env): GeminiConfig {
    return {
        baseUrl: env.GEMINI_BASE_URL || DEFAULT_GEMINI_CONFIG.baseUrl,
        apiVersion: env.GEMINI_API_VERSION || DEFAULT_GEMINI_CONFIG.apiVersion,
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
 * Handle Gemini API request
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

    // Determine the target endpoint
    const endpoint = determineGeminiEndpoint(request, geminiRequest);
    const fullTargetUrl = `${config.baseUrl}/${config.apiVersion}${endpoint}`;

    // Log request info
    activeLogger.debug(requestId, `Gemini upstream request url: ${fullTargetUrl}`);
    activeLogger.debug(requestId, `Gemini model: ${geminiRequest.model}`);
    activeLogger.debug(requestId, `Is streaming: ${isStreaming}`);

    // Prepare headers for Gemini API
    const geminiHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
    };

    // Add API key from headers or environment
    const apiKey = extractGeminiApiKey(request, authHeaders, env);
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
            return handleGeminiStreamingResponse(response, geminiRequest.model || 'gemini-pro', requestId, activeLogger);
        }

        // Handle non-streaming response
        return handleGeminiNonStreamingResponse(response, geminiRequest.model || 'gemini-pro', requestId, activeLogger);

    } catch (error) {
        activeLogger.error(requestId, `Gemini API error: ${(error as Error).message}`);
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
        return `/interactions/${interactionId}/cancel`;
    }

    if (path.match(/\/interactions\/[a-zA-Z0-9_-]+$/)) {
        // Get interaction
        const interactionId = extractInteractionId(path);
        const queryParams = new URLSearchParams();
        if (url.searchParams.get('stream') === 'true') {
            queryParams.set('stream', 'true');
        }
        const query = queryParams.toString();
        return `/interactions/${interactionId}${query ? '?' + query : ''}`;
    }

    if (request.method === 'DELETE') {
        // Delete interaction
        const interactionId = extractInteractionId(path);
        return `/interactions/${interactionId}`;
    }

    // Default: create interaction
    return '/interactions';
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
    env?: Env
): string | undefined {
    // Check request header first
    const headerKey = request.headers.get('x-goog-api-key');
    if (headerKey) {
        return headerKey;
    }

    // Check Authorization header for API key
    const authHeader = authHeaders['Authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }

    // Check x-api-key header (converted to Authorization format in routing)
    const apiKeyHeader = request.headers.get('x-api-key');
    if (apiKeyHeader) {
        return apiKeyHeader;
    }

    // Check environment variable
    if (env?.GEMINI_API_KEY) {
        return env.GEMINI_API_KEY;
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
    logger: Logger
): Promise<Response> {
    try {
        const responseText = await response.text();
        logger.debug(requestId, 'Gemini response received');

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
    logger: Logger
): Promise<Response> {
    if (!response.body) {
        throw new Error('Response body is not readable');
    }

    const decoder = new TextDecoder();

    try {
        logger.debug(requestId, 'Gemini streaming response started');

        // Create streaming transformer
        const transformer = createGeminiStreamTransformer(model, requestId);

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
