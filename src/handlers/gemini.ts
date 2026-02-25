/**
 * Gemini API handler for Claude Proxy v3
 *
 * Handles interactions with Gemini Generative Language API
 * Supports both standard Claude API format and Gemini Interactions API
 */

import { Env } from '../types/shared.js';
import { Logger, createLogger } from '../utils/logger.js';
import { ClaudeMessagesRequest, ClaudeMessagesResponse } from '../types/claude.js';
import { GeminiInteractionRequest, GeminiInteractionResponse } from '../types/gemini.js';
import { convertClaudeToGeminiRequest } from '../converters/claude-to-gemini.js';
import { convertGeminiToClaudeResponse } from '../converters/gemini-to-claude.js';
import { convertGeminiGenerateContentToClaude } from '../converters/gemini-to-claude.js';
import { createGeminiStreamTransformer } from '../converters/gemini-streaming.js';
import { convertClaudeToOpenAIRequest } from '../converters/claude-to-openai.js';
import { convertOpenAIToClaudeResponse } from '../converters/openai-to-claude.js';
import { createStreamTransformer } from '../converters/streaming.js';
import { handleTargetApiError } from '../utils/errors.js';

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
 * Handle Gemini API request (factory function)
 * Routes to either Interactions or generateContent handler based on URL
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

    // Determine which Gemini endpoint to use based on URL
    if (targetUrl.includes(':generateContent')) {
        activeLogger.debug(requestId, 'Routing to Gemini generateContent handler');
        return handleGeminiGenerateContentRequest(
            request, targetUrl, authHeaders, requestId, modelId, env, logger
        );
    } else {
        activeLogger.debug(requestId, 'Routing to Gemini Interactions handler');
        return handleGeminiInteractionsRequest(
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

    // Native mode - pass through to Gemini API
    return handleGeminiToGeminiMode(request, targetUrl, authHeaders, requestId, modelId, env, activeLogger);
}

/**
 * Handle Gemini Interactions → OpenAI upstream mode
 */
async function handleGeminiToOpenAIMode(
    request: Request,
    targetUrl: string,
    authHeaders: Record<string, string>,
    requestId: string,
    modelId?: string,
    env?: Env,
    logger?: Logger
): Promise<Response> {
    const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);
    const requestBody = await request.json() as Record<string, unknown>;

    // Convert Gemini Interactions format to OpenAI format
    let openaiRequest: Record<string, unknown>;
    const model = modelId || (requestBody.model as string) || 'gemini-pro';
    
    if (typeof requestBody.input === 'string') {
        openaiRequest = {
            model,
            messages: [{ role: 'user', content: requestBody.input }],
            stream: requestBody.stream || false,
        };
    } else if (Array.isArray(requestBody.contents)) {
        const messages = requestBody.contents.map((content: any) => ({
            role: content.role === 'model' ? 'assistant' : content.role,
            content: content.parts?.map((p: any) => p.text).join('') || '',
        }));
        openaiRequest = {
            model,
            messages,
            stream: requestBody.stream || false,
        };
    } else {
        throw new Error('Invalid Gemini Interactions request format');
    }

    activeLogger.debug(requestId, `Gemini→OpenAI mode: ${targetUrl}`);

    const response = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(openaiRequest),
    });

    if (!response.ok) {
        handleTargetApiError(response, 'OpenAI API');
    }

    // Convert OpenAI response back to Claude format
    if (openaiRequest.stream) {
        return handleOpenAIStreamingToClaude(response, model, requestId, activeLogger);
    } else {
        const openaiResponse = await response.json() as Record<string, unknown>;
        const claudeResponse = convertOpenAIToClaudeResponse(openaiResponse as any, model, requestId);
        return new Response(JSON.stringify(claudeResponse), {
            headers: { 'Content-Type': 'application/json' },
        });
    }
}

/**
 * Helper: Handle OpenAI streaming response and convert to Claude format
 */
async function handleOpenAIStreamingToClaude(
    response: Response,
    model: string,
    requestId: string,
    logger: Logger
): Promise<Response> {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
        try {
            const reader = response.body?.getReader();
            if (!reader) throw new Error('No response body');

            const decoder = new TextDecoder();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const text = decoder.decode(value);
                const lines = text.split('\n');
                
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);
                        if (data.trim() === '[DONE]') {
                            await writer.write(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
                        } else {
                            try {
                                const parsed = JSON.parse(data);
                                const claudeChunk = convertOpenAIToClaudeResponse(parsed, model, requestId);
                                await writer.write(encoder.encode(`data: ${JSON.stringify(claudeChunk)}\n\n`));
                            } catch {
                                // Skip invalid chunks
                            }
                        }
                    }
                }
            }
            await writer.close();
        } catch (error) {
            logger.error(requestId, `Streaming error: ${(error as Error).message}`);
            await writer.abort();
        }
    })();

    return new Response(readable, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    });
}

/**
 * Handle Gemini Interactions → Gemini generateContent mode
 */
async function handleGeminiToGeminiMode(
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
    let geminiRequest: Record<string, unknown>;
    let isStreaming: boolean;
    let effectiveModelId = modelId;

    if (isNativeGeminiRequest(requestBody)) {
        // Native Gemini format - use directly
        activeLogger.debug(requestId, 'Using native Gemini request format');
        geminiRequest = requestBody;
        isStreaming = requestBody.stream === true;
        effectiveModelId = effectiveModelId || (requestBody.model as string);
        
        // Convert native format (input: string) to generateContent format (contents: [...])
        if (typeof geminiRequest.input === 'string') {
            geminiRequest = {
                model: effectiveModelId || geminiRequest.model || 'gemini-pro',
                contents: [{ role: 'user', parts: [{ text: geminiRequest.input }] }],
                stream: isStreaming,
            };
        }
    } else {
        // Claude format - convert to Gemini generateContent format
        activeLogger.debug(requestId, 'Converting Claude request to Gemini format');
        const claudeRequest = requestBody as unknown as ClaudeMessagesRequest;
        geminiRequest = convertClaudeToGeminiRequest(claudeRequest, modelId);
        isStreaming = claudeRequest.stream === true;
        effectiveModelId = effectiveModelId || claudeRequest.model;
    }

    // Determine the target endpoint
    // Determine if targetUrl already contains :generateContent
    const needsEndpoint = !targetUrl.includes(":generateContent");
    const fullTargetUrl = needsEndpoint ? `${targetUrl}${determineGeminiEndpoint(request, geminiRequest, effectiveModelId)}` : targetUrl;

    // Log request info
    activeLogger.debug(requestId, `Gemini upstream request url: ${fullTargetUrl}`);
    activeLogger.debug(requestId, `Gemini model: ${effectiveModelId || 'gemini-pro'}`);
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
            return handleGeminiStreamingResponse(response, effectiveModelId || 'gemini-pro', requestId, activeLogger, 'interactions');
        }

        // Handle non-streaming response
        return handleGeminiNonStreamingResponse(response, effectiveModelId || 'gemini-pro', requestId, activeLogger, 'interactions');

    } catch (error) {
        activeLogger.error(requestId, `Gemini API error: ${(error as Error).message}`);
        throw error;
    }
}

/**
 * Handle Gemini generateContent API request
 */
async function handleGeminiGenerateContentRequest(
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
    let geminiRequest: Record<string, unknown>;
    let isStreaming: boolean;
    let effectiveModelId = modelId;

    if (isNativeGeminiRequest(requestBody)) {
        // Native Gemini format - use directly
        activeLogger.debug(requestId, 'Using native Gemini request format');
        geminiRequest = requestBody;
        isStreaming = requestBody.stream === true;
        effectiveModelId = effectiveModelId || (requestBody.model as string);
        
        // Convert native format (input: string) to generateContent format (contents: [...])
        if (typeof geminiRequest.input === 'string') {
            geminiRequest = {
                model: effectiveModelId || geminiRequest.model || 'gemini-pro',
                contents: [{ role: 'user', parts: [{ text: geminiRequest.input }] }],
                stream: isStreaming,
            };
        }
    } else {
        // Claude format - convert to Gemini generateContent format
        activeLogger.debug(requestId, 'Converting Claude request to Gemini format');
        const claudeRequest = requestBody as unknown as ClaudeMessagesRequest;
        geminiRequest = convertClaudeToGeminiRequest(claudeRequest, modelId);
        isStreaming = claudeRequest.stream === true;
        effectiveModelId = effectiveModelId || claudeRequest.model;
    }

    // Determine the target endpoint
    // Determine if targetUrl already contains :generateContent
    const needsEndpoint = !targetUrl.includes(":generateContent");
    const fullTargetUrl = needsEndpoint ? `${targetUrl}${determineGeminiEndpoint(request, geminiRequest, effectiveModelId)}` : targetUrl;

    // Log request info
    activeLogger.debug(requestId, `Gemini upstream request url: ${fullTargetUrl}`);
    activeLogger.debug(requestId, `Gemini model: ${effectiveModelId || 'gemini-pro'}`);
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
            return handleGeminiStreamingResponse(response, effectiveModelId || 'gemini-pro', requestId, activeLogger, 'interactions');
        }

        // Handle non-streaming response
        return handleGeminiNonStreamingResponse(response, effectiveModelId || 'gemini-pro', requestId, activeLogger, 'interactions');

    } catch (error) {
        activeLogger.error(requestId, `Gemini API error: ${(error as Error).message}`);
        throw error;
    }
}

/**
 * Determine the Gemini endpoint based on request
 */
function determineGeminiEndpoint(request: Request, geminiRequest: Record<string, unknown>, modelId?: string): string {
    // Default: generateContent endpoint
    const model = modelId || (geminiRequest.model as string) || 'gemini-pro';
    return `/${model}:generateContent`;
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
            // Parse native Gemini generateContent response
            const geminiResponse = JSON.parse(responseText);
            
            // Convert to Claude format
            const claudeResponse = convertGeminiGenerateContentToClaude(geminiResponse, model, requestId);

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
