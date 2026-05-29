/**
 * SDK handler utility for Claude Proxy v3
 *
 * Handles sdk:// URLs by using chatjimmy SDK clients instead of HTTP fetch
 */

import { OpenAIRequest, OpenAIResponse } from '../types/openai.js';
import { ClaudeMessagesRequest, ClaudeMessagesResponse } from '../types/claude.js';
import { Env, Logger } from '../types/shared.js';
import { createLogger } from './logger.js';
import { convertOpenAIToClaudeResponse } from '../converters/openai-to-claude.js';
import { createStreamTransformer } from '../converters/streaming.js';
import { recordUpstreamResponseToolCount } from './dashboard-stats.js';

/**
 * Check if target URL is an SDK URL (sdk://)
 */
export function isSdkUrl(targetUrl: string): boolean {
  return targetUrl.startsWith('sdk://');
}

/**
 * Parse SDK URL to get SDK configuration
 */
export function parseSdkUrl(targetUrl: string): {
  sdkType: string;
  host: string;
  path?: string;
} {
  if (!isSdkUrl(targetUrl)) {
    throw new Error(`Invalid SDK URL: ${targetUrl}`);
  }

  // Remove sdk:// prefix (6 characters including //)
  const urlWithoutPrefix = targetUrl.substring(6);

  // Parse like a normal URL
  const match = urlWithoutPrefix.match(/^([^\/]+)(\/.*)?$/);
  if (!match) {
    throw new Error(`Invalid SDK URL format: ${targetUrl}`);
  }

  const host = match[1];
  const path = match[2] || undefined;

  // Determine SDK type based on host
  let sdkType = 'openai'; // Default

  if (host.includes('anthropic') || host.includes('claude')) {
    sdkType = 'anthropic';
  } else if (host.includes('gemini') || host.includes('google')) {
    sdkType = 'google';
  }

  return { sdkType, host, path };
}

/**
 * Dynamically import chatjimmy SDK from submodule
 */
async function importChatJimmySdk() {
  try {
    // Import from the built dist folder in the submodule
    const chatjimmy = await import('../../submodules/chatjimmy/dist/index.js');
    return chatjimmy;
  } catch (error) {
    console.warn('Failed to import chatjimmy SDK:', error);
    throw new Error('ChatJimmy SDK not available. Please ensure chatjimmy submodule is properly configured and built.');
  }
}

/**
 * Convert our OpenAI request to chatjimmy SDK OpenAI request
 */
function convertToChatJimmyOpenAIRequest(ourRequest: OpenAIRequest): any {
  // Convert messages content from OpenAIContent to string, preserve tool_calls
  const messages = ourRequest.messages.map(msg => {
    const converted: any = { ...msg };
    
    // Ensure content is a string
    if (typeof msg.content === 'string') {
      converted.content = msg.content;
    } else if (Array.isArray(msg.content)) {
      converted.content = msg.content.map(part => {
        if (part.type === 'text') return part.text;
        if (part.type === 'image_url') return `[Image: ${part.image_url.url}]`;
        return '';
      }).join(' ');
    } else {
      converted.content = String(msg.content);
    }
    
    // Ensure message has either content or tool_calls
    if (!converted.content && !converted.tool_calls) {
      converted.content = ' '; // Fallback to space if empty
    }
    
    return converted;
  });

  // Create base object without properties we'll set explicitly
  const { model, messages: _, stream, max_tokens, temperature, top_p, ...rest } = ourRequest;

  return {
    model,
    messages,
    stream,
    max_tokens,
    temperature,
    top_p,
    // Include other fields that might be present
    ...rest
  };
}

/**
 * Convert our Claude request to OpenAI format for chatjimmy SDK
 */
function convertClaudeToOpenAIForChatJimmy(claudeRequest: ClaudeMessagesRequest): any {
  // Convert Claude messages to OpenAI format
  const messages = claudeRequest.messages.map(msg => {
    const converted: any = { role: msg.role };
    const toolCalls: any[] = [];
    const textParts: string[] = [];

    // Process content array - extract tool_use and convert to tool_calls
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          // Convert Claude tool_use to OpenAI tool_calls
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input)
            }
          });
        } else if (block.type === 'image') {
          textParts.push(`[Image: ${block.source?.data}]`);
        }
        // tool_result blocks are handled differently - they contain assistant's response
      }
    } else {
      textParts.push(String(msg.content));
    }

    // Set content to remaining text (if any)
    const content = textParts.join(' ');
    if (content.trim()) {
      converted.content = content;
    }

    // Add tool_calls if any were extracted
    if (toolCalls.length > 0) {
      converted.tool_calls = toolCalls;
    }

    // Ensure message has either content or tool_calls
    if (!converted.content && !converted.tool_calls) {
      converted.content = ' '; // Fallback to space if empty
    }

    return converted;
  });

  // Create base object without properties we'll set explicitly
  const { model, messages: _, stream, max_tokens, temperature, ...rest } = claudeRequest;

  return {
    model,
    messages,
    stream: stream === true,
    max_tokens,
    temperature,
    // Include other fields
    ...rest
  };
}

/**
 * Handle SDK request for OpenAI-compatible mode
 */
export async function handleSdkOpenAIRequest(
  request: Request,
  targetUrl: string,
  requestId: string,
  apiKey?: string,
  modelAlias?: string,
  logger?: Logger,
  env?: Env,
  requestBody?: Record<string, unknown>,
  outputFormat: 'openai' | 'claude' = 'openai'
): Promise<Response> {
  const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);
  activeLogger.debug(requestId, `Using SDK client for OpenAI request model ${modelAlias} url=${request.url}, method=${request.method}`);

  // Use provided request body or parse from request
  const openaiRequest = (requestBody ?? (await request.json() as Record<string, unknown>)) as unknown as OpenAIRequest;
  // Validate that request body has required fields
  if (!openaiRequest.model || !openaiRequest.messages) {
    throw new Error('Invalid OpenAI request: missing model or messages');
  }

  // openai-completions doesn't support thinking field; derive reasoning_effort from budget_tokens
  if (openaiRequest.thinking !== undefined) {
    const thinking = openaiRequest.thinking as { enabled?: boolean; budget_tokens?: number; type?: boolean | string };
    if (thinking?.budget_tokens && !openaiRequest.reasoning_effort) {
      // Handle both OpenAI format (enabled) and Claude format (type)
      const isEnabled = 'enabled' in thinking ? thinking.enabled : thinking.type === true || thinking.type === 'enabled';
      if (isEnabled) {
        const budget = thinking.budget_tokens;
        openaiRequest.reasoning_effort = budget >= 4096 ? 'high' : budget >= 2048 ? 'medium' : 'low';
      }
    }
    delete openaiRequest.thinking;
  }

  const isStreaming = openaiRequest.stream === true;
  activeLogger.debug(requestId, `targetUrl: ${targetUrl}, streaming: ${isStreaming}`);

  // Import SDK
  const sdk = await importChatJimmySdk();

  // Create SDK client config
  const config: any = {
    baseURL: 'https://chatjimmy.ai/api', // ChatJimmy API endpoint
    apiKey: apiKey || '',
    timeout: 3000,
    maxRetries: 3,
    headers: {}
  };

  activeLogger.debug(requestId, `Using SDK client config: ${JSON.stringify(config)}`);
  // Create client
  const client = new sdk.OpenAICompatibleClient(config);

  try {
    // Convert request to chatjimmy SDK format
    const chatJimmyRequest = convertToChatJimmyOpenAIRequest(openaiRequest);
    
    // Debug log the converted request
    activeLogger.debug(requestId, `Converted request: ${JSON.stringify(chatJimmyRequest, null, 2)}`);

    if (isStreaming) {
      try {
        // Handle streaming request
        const stream = client.createChatCompletionStream(chatJimmyRequest);
        const encoder = new TextEncoder();
        recordUpstreamResponseToolCount(outputFormat === 'claude' ? 'anthropic-messages' : 'openai-completions', 0);

        if (outputFormat === 'claude') {
          const transformer = createStreamTransformer(
            modelAlias || openaiRequest.model,
            requestId,
            requestBody as Record<string, unknown>
          );

          const openAiSseReadable = new ReadableStream<Uint8Array>({
            async start(controller) {
              try {
                for await (const chunk of stream) {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
              } catch (error) {
                controller.error(error);
              }
            }
          });

          const claudeSseReadable = openAiSseReadable.pipeThrough(new TransformStream(transformer));
          return new Response(claudeSseReadable, {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
            },
          });
        }

        const readable = new ReadableStream({
          async start(controller) {
            for await (const chunk of stream) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            }
            controller.close();
          }
        });

        return new Response(readable, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
        });
      } catch (streamError) {
        activeLogger.warn(requestId, `SDK streaming not available, fallback to non-stream response: ${(streamError as Error).message}`);
      }
    }

    // Handle non-streaming request (default or fallback)
    const response = await client.createChatCompletion({
      ...chatJimmyRequest,
      stream: false,
    }) as OpenAIResponse;

    recordUpstreamResponseToolCount('openai-completions', 0);

    if (outputFormat === 'claude') {
      const claudeResponse: ClaudeMessagesResponse = await convertOpenAIToClaudeResponse(
        response,
        modelAlias || openaiRequest.model,
        requestId,
        requestBody as Record<string, any>
      );

      return new Response(JSON.stringify(claudeResponse), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      });
    }

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    activeLogger.error(requestId, `SDK client error: ${(error as Error).message}`);
    activeLogger.error(requestId, `Error stack: ${(error as Error).stack}`);
    activeLogger.error(requestId, `Error name: ${(error as Error).name}`);

    // Log specific tool call errors
    if ((error as Error).message.includes('tool_calls') || (error as Error).message.includes('content')) {
      activeLogger.error(requestId, `Tool call validation failed - request may have empty content and no tool_calls`);
    }
    
    return new Response(JSON.stringify({
      error: {
        message: (error as Error).message,
        type: 'SDK_ERROR',
        code: 500
      }
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }
}

/**
 * Handle SDK request for Anthropic-compatible mode
 */
export async function handleSdkAnthropicRequest(
  request: Request,
  targetUrl: string,
  requestId: string,
  apiKey?: string,
  modelAlias?: string,
  logger?: Logger,
  env?: Env,
  requestBody?: Record<string, unknown>
): Promise<Response> {
  const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);
  activeLogger.debug(requestId, `Using SDK client for Claude request model ${modelAlias} url=${request.url}, method=${request.method}`);

  // Use provided request body or parse from request
  const claudeRequest = (requestBody ?? (await request.json() as Record<string, unknown>)) as unknown as ClaudeMessagesRequest;
  // Validate that request body has required fields
  if (!claudeRequest.model || !claudeRequest.messages || !claudeRequest.max_tokens) {
    activeLogger.debug(requestId, `request model ${claudeRequest.model} ${claudeRequest.messages} ${claudeRequest.max_tokens}`);
    throw new Error(`Invalid Claude request: missing model, messages, or max_tokens`);
  }
  const isStreaming = claudeRequest.stream === true;
  activeLogger.debug(requestId, `targetUrl: ${targetUrl}, streaming: ${isStreaming}`);

  // Import SDK
  const sdk = await importChatJimmySdk();

  // Create SDK client config
  const config: any = {
    baseURL: 'https://chatjimmy.ai/api', // ChatJimmy API endpoint
    apiKey: apiKey || '',
    timeout: 30000,
    maxRetries: 3,
    headers: {}
  };

  // Create client - use OpenAI client for Anthropic requests (as fallback)
  const client = new sdk.OpenAICompatibleClient(config);

  try {
    // Convert Claude request to OpenAI format for chatjimmy SDK
    const chatJimmyRequest = convertClaudeToOpenAIForChatJimmy(claudeRequest);

    if (isStreaming) {
      try {
        // Handle streaming request and convert OpenAI SSE to Claude SSE
        const stream = client.createChatCompletionStream(chatJimmyRequest);
        const encoder = new TextEncoder();
        recordUpstreamResponseToolCount('anthropic-messages', 0);
        const transformer = createStreamTransformer(
          modelAlias || claudeRequest.model,
          requestId,
          requestBody as Record<string, unknown>
        );

        const openAiSseReadable = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              for await (const chunk of stream) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            } catch (error) {
              controller.error(error);
            }
          }
        });

        const claudeSseReadable = openAiSseReadable.pipeThrough(new TransformStream(transformer));

        return new Response(claudeSseReadable, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          },
        });
      } catch (streamError) {
        activeLogger.warn(requestId, `SDK streaming not available, fallback to non-stream response: ${(streamError as Error).message}`);
      }
    }

    // Handle non-streaming request (default or fallback)
    const response = await client.createChatCompletion({
      ...chatJimmyRequest,
      stream: false,
    }) as OpenAIResponse;
    recordUpstreamResponseToolCount('anthropic-messages', 0);
    const claudeResponse: ClaudeMessagesResponse = await convertOpenAIToClaudeResponse(
      response,
      modelAlias || claudeRequest.model,
      requestId,
      requestBody as Record<string, any>
    );

    return new Response(JSON.stringify(claudeResponse), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    activeLogger.error(requestId, `SDK client error: ${(error as Error).message}`);
    activeLogger.error(requestId, `Error stack: ${(error as Error).stack}`);
    activeLogger.error(requestId, `Error name: ${(error as Error).name}`);

    // Log specific tool call errors
    if ((error as Error).message.includes('tool_calls') || (error as Error).message.includes('content')) {
      activeLogger.error(requestId, `Tool call validation failed - request may have empty content and no tool_calls`);
    }
    return new Response(JSON.stringify({
      error: {
        message: (error as Error).message,
        type: 'SDK_ERROR',
        code: 500
      }
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }
}
