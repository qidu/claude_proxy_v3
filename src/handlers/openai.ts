import { ClaudeMessagesRequest, ClaudeMessagesResponse } from '../types/claude.js';
import { convertClaudeToOpenAIRequest } from '../converters/claude-to-openai.js';
import { convertOpenAIToClaudeResponse } from '../converters/openai-to-claude.js';
import { convertOpenAIToGeminiGenerateContent, convertOpenAIToGeminiInteractions } from '../converters/openai-to-gemini.js';
import { createLogger } from '../utils/logger.js';
import { isSdkUrl, handleSdkOpenAIRequest } from '../utils/sdk-handler.js';
import type { Env, Logger } from '../types/shared.js';
import { addForwardedHeaders } from '../utils/routing.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';
import { recordResponseStatusCodeFromUpstream, recordUpstreamResponseToolCount } from '../utils/dashboard-stats.js';
import { handleTargetApiError } from '../utils/errors.js';

/**
 * Check if request is in Gemini Interactions format
 */
function isGeminiInteractionsRequest(body: Record<string, unknown>): boolean {
  return 'input' in body || 'contents' in body;
}

/**
 * Convert Gemini Interactions request to OpenAI format
 */
function convertGeminiInteractionsToOpenAI(geminiRequest: Record<string, unknown>): Record<string, unknown> {
  const model = (geminiRequest.model as string) || 'gemini-no-id-at-proxy';
  
  // Handle input.messages format (Interactions API)
  if (geminiRequest.input && typeof geminiRequest.input === 'object') {
    const input = geminiRequest.input as Record<string, unknown>;
    if (Array.isArray(input.messages)) {
      return {
        model,
        messages: input.messages,
        stream: geminiRequest.stream || false,
      };
    }
  }
  
  // Handle input as array-of-turns (TC203: [{role, content}, ...])
  if (Array.isArray(geminiRequest.input)) {
    return {
      model,
      messages: (geminiRequest.input as any[]).map((turn: any) => ({
        role: turn.role === 'model' ? 'assistant' : turn.role,
        content: typeof turn.content === 'string' ? turn.content : String(turn.content),
      })),
      stream: geminiRequest.stream || false,
    };
  }

  // Handle simple input format
  if (typeof geminiRequest.input === 'string') {
    return {
      model,
      messages: [{ role: 'user', content: geminiRequest.input }],
      stream: geminiRequest.stream || false,
    };
  }
  
  // Handle contents format
  if (Array.isArray(geminiRequest.contents)) {
    const messages = geminiRequest.contents.map((content: any) => ({
      role: content.role === 'model' ? 'assistant' : content.role,
      content: content.parts?.map((p: any) => p.text).join('') || '',
    }));
    
    return {
      model,
      messages,
      stream: geminiRequest.stream || false,
    };
  }
  
  throw new Error('Invalid Gemini Interactions request format');
}

/**
 * Convert Gemini generateContent request to OpenAI format
 */
function convertGeminiGenerateContentToOpenAI(geminiRequest: Record<string, unknown>): Record<string, unknown> {
  const model = (geminiRequest.model as string) || 'gemini-no-id-at-proxy';
  
  // Handle contents format
  if (Array.isArray(geminiRequest.contents)) {
    const messages = geminiRequest.contents.map((content: any) => ({
      role: content.role === 'model' ? 'assistant' : content.role,
      content: content.parts?.map((p: any) => p.text).join('') || '',
    }));
    
    // Check for stream parameter in both top-level and generationConfig
    const config = geminiRequest.generationConfig as Record<string, unknown> | undefined;
    const stream = geminiRequest.stream === true || config?.stream === true;
    
    return {
      model,
      messages,
      stream,
    };
  }
  
  throw new Error('Invalid Gemini generateContent request format');
}

/**
 * Handle OpenAI-compatible API request
 */
export async function handleOpenAIRequest(
    request: Request,
    targetUrl: string,
    authHeaders: Record<string, string>,
    requestId: string,
    modelId?: string,
    env?: Env,
    logger?: Logger,
    forceStreaming?: boolean
): Promise<Response> {
    const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);

    // Check original request path for response format
    const url = new URL(request.url);
    const isStreamRequest = url.searchParams.get('alt') === 'sse' || url.pathname.includes(':streamGenerateContent');
    const isInteractionsRequest = url.pathname === '/v1/interactions' || url.pathname.startsWith('/v1/interactions?');
    const isGenerateContentRequest = url.pathname.includes(':generateContent') || url.pathname.includes(':streamGenerateContent');
    const isGeminiEndpoint = isInteractionsRequest || isGenerateContentRequest;
    
    activeLogger.debug(requestId, `OpenAI handler - path: ${url.pathname}, isGeminiEndpoint: ${isGeminiEndpoint}`);
    const authTokenIn = request.headers.get('Authorization') || '';
    const apiKey = request.headers.get('x-api-key') || '';
    const googApiKey = request.headers.get('x-goog-api-key') || '';
    activeLogger.debug(requestId, `Authorization: ${authTokenIn.substring(0, 16)}... at endpoint`);
    activeLogger.debug(requestId, `x-api-key: ${apiKey.substring(0, 16)}...`);
    activeLogger.debug(requestId, `x-goog-api-key: ${googApiKey.substring(0, 16)}...`);

    // This handler always targets an OpenAI-compatible upstream (openai-completions),
    // which expects `Authorization: Bearer <key>` regardless of the incoming endpoint
    // (/v1/messages, /v1/interactions, or :generateContent mapped here). Resolve the
    // key from whichever header the client supplied and forward it as Bearer.
    const incomingKey =
        (authTokenIn ? authTokenIn.replace(/^Bearer\s+/i, '') : '') ||
        apiKey ||
        (googApiKey ? googApiKey.replace(/^Bearer\s+/i, '') : '');
    if (incomingKey) {
        authHeaders['Authorization'] = `Bearer ${incomingKey}`;
    }

    // Parse request body
    const requestBody = await request.json() as Record<string, unknown>;
    
    // Detect Gemini CLI and force non-streaming to avoid JSON parsing issues
    const userAgent = request.headers.get('user-agent') || '';
    if (userAgent.includes('gemini-cli')) {
        activeLogger.debug(requestId, 'Gemini CLI detected');
    }
    
    activeLogger.debug(requestId, `Request body keys: ${Object.keys(requestBody).join(', ')}`);

    let openaiRequest: Record<string, unknown>;
    let isStreaming: boolean;

    // Detect input format and convert to OpenAI
    if (isGeminiInteractionsRequest(requestBody)) {
      activeLogger.debug(requestId, 'Converting Gemini request to OpenAI format');
      
      // Check if it's generateContent format (has contents array)
      if (Array.isArray(requestBody.contents)) {
        activeLogger.debug(requestId, 'Detected generateContent format with contents array');
        openaiRequest = convertGeminiGenerateContentToOpenAI(requestBody);
      } else {
        activeLogger.debug(requestId, 'Detected Interactions format with input field');
        openaiRequest = convertGeminiInteractionsToOpenAI(requestBody);
      }
      
      isStreaming = (openaiRequest.stream as boolean) === true;
    } else {
      // Assume Claude format
      activeLogger.debug(requestId, 'Converting Claude request to OpenAI format');
      const claudeRequest = requestBody as unknown as ClaudeMessagesRequest;
      const converted = convertClaudeToOpenAIRequest(claudeRequest, modelId || claudeRequest.model);
      openaiRequest = converted as unknown as Record<string, unknown>;
      isStreaming = claudeRequest.stream === true;
    }

    // Override model if provided
    if (modelId) {
      openaiRequest.model = modelId;
    }

    // Force streaming for ?alt=sse query parameter
    if (forceStreaming || isStreamRequest) {
      openaiRequest.stream = true;
      isStreaming = true;
    }

    // Log request info
    activeLogger.debug(requestId, `OpenAI upstream url: ${targetUrl}`);
    activeLogger.debug(requestId, `Model: ${openaiRequest.model}, stream=${isStreaming}`);
    const authBaerer = authHeaders['Authorization'] || '';
    activeLogger.debug(requestId, `Authorization: ${authBaerer.substring(0, 16)}... upstream`);

    // Prepare headers
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...authHeaders,
    };

    try {
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

            // Use SDK handler for OpenAI requests
            return handleSdkOpenAIRequest(
                request,
                targetUrl,
                requestId,
                apiKey,
                modelId,
                activeLogger,
                env
            );
        }

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: addForwardedHeaders(headers, request),
            body: JSON.stringify(openaiRequest),
            signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
        });

        recordResponseStatusCodeFromUpstream(response.status);
        recordUpstreamResponseToolCount('openai-completions', 0);

        // Handle target API errors
        if (!response.ok) {
            const errorText = await response.text();
            activeLogger.error(requestId, `OpenAI API error: ${response.status} ${errorText}`);
            handleTargetApiError(response, 'OpenAI API', { url: targetUrl, upstreamBody: errorText });
        }

        // Handle streaming response
        if (isStreaming) {
            return handleOpenAIStreamingResponse(response, openaiRequest.model as string, requestId, activeLogger, isInteractionsRequest, isGenerateContentRequest);
        }

        // Handle non-streaming response
        return handleOpenAINonStreamingResponse(response, openaiRequest.model as string, requestId, activeLogger, isInteractionsRequest, isGenerateContentRequest);

    } catch (error) {
        activeLogger.error(requestId, `OpenAI API error: ${(error as Error).message}`);
        throw error;
    }
}

/**
 * Handle OpenAI streaming response
 */
async function handleOpenAIStreamingResponse(
    response: Response,
    modelId: string,
    requestId: string,
    logger: Logger,
    isInteractionsRequest: boolean = false,
    isGenerateContentRequest: boolean = false
): Promise<Response> {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    logger.debug(requestId, `OpenAI streaming response started, status: ${response.status}, ok: ${response.ok}`);

    // Process stream
    (async () => {
        try {
            const reader = response.body?.getReader();
            if (!reader) {
                logger.error(requestId, 'No response body in streaming response');
                throw new Error('No response body');
            }

            let buffer = '';
            let chunkCount = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    logger.debug(requestId, `Stream ended, processed ${chunkCount} chunks`);
                    break;
                }

                // Append to buffer
                buffer += new TextDecoder().decode(value);
                chunkCount++;
                
                // Process complete SSE events
                const { processed, remaining } = processSSEBuffer(buffer, modelId, requestId, isInteractionsRequest, isGenerateContentRequest);
                buffer = remaining;
                
                if (processed) {
                    logger.debug(requestId, `OpenAI SSE chunk ${chunkCount}: ${processed.substring(0, 200)}...`);
                    await writer.write(encoder.encode(processed));
                }
            }

            // Process any remaining buffer
            if (buffer.trim()) {
                const { processed } = processSSEBuffer(buffer + '\n\n', modelId, requestId, isInteractionsRequest, isGenerateContentRequest);
                if (processed) {
                    logger.debug(requestId, `Final buffer processed: ${processed.substring(0, 200)}...`);
                    await writer.write(encoder.encode(processed));
                }
            }

            await writer.close();
        } catch (error) {
            logger.error(requestId, `OpenAI streaming error: ${(error as Error).message}`);
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
 * Handle OpenAI non-streaming response
 */
async function handleOpenAINonStreamingResponse(
    response: Response,
    modelId: string,
    requestId: string,
    logger: Logger,
    isInteractionsRequest: boolean = false,
    isGenerateContentRequest: boolean = false
): Promise<Response> {
    const openaiResponse = await response.json() as Record<string, unknown>;
    
    if (isGenerateContentRequest) {
        // Convert to Gemini generateContent format
        const geminiResponse = convertOpenAIToGeminiGenerateContent(
            openaiResponse as any,
            modelId,
            requestId
        );
        
        return new Response(JSON.stringify(geminiResponse), {
            headers: {
                'Content-Type': 'application/json',
                'x-request-id': requestId,
            },
        });
    } else if (isInteractionsRequest) {
        // Convert to Interactions format
        const interactionResponse = convertOpenAIToGeminiInteractions(
            openaiResponse as any,
            modelId,
            requestId
        );
        
        return new Response(JSON.stringify(interactionResponse), {
            headers: {
                'Content-Type': 'application/json',
                'x-request-id': requestId,
            },
        });
    }
    
    // Convert to Claude format
    const claudeResponse = convertOpenAIToClaudeResponse(openaiResponse as any, modelId, requestId);

    return new Response(JSON.stringify(claudeResponse), {
        headers: {
            'Content-Type': 'application/json',
        },
    });
}

/**
 * Convert OpenAI streaming chunk to Claude format
 */
/**
 * Process SSE buffer and extract complete events
 */
function processSSEBuffer(buffer: string, modelId: string, requestId: string, isInteractionsRequest: boolean = false, isGenerateContentRequest: boolean = false): { processed: string; remaining: string } {
    let result = '';
    let remaining = buffer;
    
    // Split by double newline (SSE event separator)
    const events = buffer.split('\n\n');
    
    // Last element might be incomplete, keep it in buffer
    remaining = events.pop() || '';
    
    for (const event of events) {
        if (!event.trim()) continue;
        
        const lines = event.split('\n');
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    if (isGenerateContentRequest) {
                        // Gemini generateContent doesn't need explicit end marker
                        continue;
                    } else {
                        result += 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
                    }
                } else {
                    try {
                        const parsed = JSON.parse(data);
                        
                        let convertedChunk: Record<string, any> | null = null;
                        
                        if (isGenerateContentRequest) {
                            // Convert to Gemini generateContent format
                            convertedChunk = convertOpenAIToGeminiGenerateContent(parsed, modelId, requestId);
                        } else if (isInteractionsRequest) {
                            // Convert to Gemini Interactions format
                            convertedChunk = convertOpenAIToGeminiInteractions(parsed, modelId, requestId);
                        } else {
                            // Convert to Claude format
                            convertedChunk = convertOpenAIToClaudeResponse(parsed, modelId, requestId);
                        }
                        
                        // Skip chunks with no candidates/content
                        if (!convertedChunk || (!convertedChunk.candidates && !convertedChunk.content)) {
                            continue;
                        }
                        
                        result += `data: ${JSON.stringify(convertedChunk)}\n\n`;
                    } catch {
                        // Skip invalid JSON
                    }
                }
            }
        }
    }
    
    return { processed: result, remaining };
}

function convertOpenAIStreamToClaude(chunk: string, modelId: string, requestId: string): string | null {
    // Parse and convert OpenAI SSE format to Claude format
    const lines = chunk.split('\n');
    let result = '';
    
    for (const line of lines) {
        if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data.trim() === '[DONE]') {
                result += 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
            } else {
                try {
                    const parsed = JSON.parse(data);
                    // Convert OpenAI chunk to Claude chunk format
                    const claudeChunk = convertOpenAIToClaudeResponse(parsed, modelId, requestId);
                    result += `data: ${JSON.stringify(claudeChunk)}\n\n`;
                } catch {
                    // Pass through if parsing fails
                    result += line + '\n';
                }
            }
        }
    }
    
    return result || null;
}
