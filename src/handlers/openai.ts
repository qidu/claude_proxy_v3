import { ClaudeMessagesRequest, ClaudeMessagesResponse } from '../types/claude.js';
import { convertClaudeToOpenAIRequest } from '../converters/claude-to-openai.js';
import { convertOpenAIToClaudeResponse } from '../converters/openai-to-claude.js';
import { createLogger } from '../utils/logger.js';
import type { Env, Logger } from '../types/shared.js';

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
  const model = (geminiRequest.model as string) || 'gemini-pro';
  
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
  const model = (geminiRequest.model as string) || 'gemini-pro';
  
  // Handle contents format
  if (Array.isArray(geminiRequest.contents)) {
    const messages = geminiRequest.contents.map((content: any) => ({
      role: content.role === 'model' ? 'assistant' : content.role,
      content: content.parts?.map((p: any) => p.text).join('') || '',
    }));
    
    const config = geminiRequest.generationConfig as Record<string, unknown> | undefined;
    return {
      model,
      messages,
      stream: config?.stream || false,
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
    logger?: Logger
): Promise<Response> {
    const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);

    // Check original request path for response format
    const url = new URL(request.url);
    const isInteractionsRequest = url.pathname === '/v1/interactions' || url.pathname.startsWith('/v1/interactions?');
    
    activeLogger.debug(requestId, `OpenAI handler - path: ${url.pathname}, isInteractions: ${isInteractionsRequest}`);

    // Parse request body
    const requestBody = await request.json() as Record<string, unknown>;
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

    // Log request info
    activeLogger.debug(requestId, `OpenAI upstream request url: ${targetUrl}`);
    activeLogger.debug(requestId, `Model: ${openaiRequest.model}`);
    activeLogger.debug(requestId, `Is streaming: ${isStreaming}`);

    // Prepare headers
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...authHeaders,
    };

    try {
        const response = await fetch(targetUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(openaiRequest),
        });

        // Handle target API errors
        if (!response.ok) {
            const errorText = await response.text();
            activeLogger.error(requestId, `OpenAI API error: ${response.status} ${errorText}`);
            throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
        }

        // Handle streaming response
        if (isStreaming) {
            return handleOpenAIStreamingResponse(response, openaiRequest.model as string, requestId, activeLogger, isInteractionsRequest);
        }

        // Handle non-streaming response
        return handleOpenAINonStreamingResponse(response, openaiRequest.model as string, requestId, activeLogger, isInteractionsRequest);

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
    isInteractionsRequest: boolean = false
): Promise<Response> {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // Process stream
    (async () => {
        try {
            const reader = response.body?.getReader();
            if (!reader) {
                throw new Error('No response body');
            }

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                // Convert OpenAI streaming format to Claude format
                const text = new TextDecoder().decode(value);
                const claudeChunk = convertOpenAIStreamToClaude(text, modelId, requestId);
                if (claudeChunk) {
                    await writer.write(encoder.encode(claudeChunk));
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
    isInteractionsRequest: boolean = false
): Promise<Response> {
    const openaiResponse = await response.json() as Record<string, unknown>;
    
    if (isInteractionsRequest) {
        // Convert to Interactions format
        const interactionResponse = {
            id: `v1_${Date.now()}_${requestId}`,
            model: modelId,
            status: 'completed',
            object: 'interaction',
            created: new Date().toISOString(),
            updated: new Date().toISOString(),
            role: 'model',
            outputs: [] as any[],
            usage: {
                total_input_tokens: (openaiResponse.usage as any)?.prompt_tokens || 0,
                total_output_tokens: (openaiResponse.usage as any)?.completion_tokens || 0,
                total_tokens: (openaiResponse.usage as any)?.total_tokens || 0,
            }
        };
        
        // Extract text from OpenAI response
        const choices = (openaiResponse.choices as any[]) || [];
        if (choices.length > 0 && choices[0].message?.content) {
            interactionResponse.outputs = [{
                type: 'text',
                text: choices[0].message.content
            }];
        }
        
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
