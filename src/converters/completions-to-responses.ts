/**
 * Converter: Chat Completions response to Responses API format
 */

import { OpenAIResponse } from '../types/openai.js';

/**
 * OpenAI Responses API Response format
 */
export interface OpenAIResponsesResponse {
  id: string;
  object: 'response';
  created: number;
  status: 'completed' | 'in_progress' | 'failed';
  model: string;
  output_text?: string;
  output_items: Array<{
    id: string;
    type: 'message' | 'function_call' | 'function_call_output' | 'web_search_call' | 'code_interpreter_call' | 'computer_call' | 'computer_call_output' | 'file_search_call' | 'reasoning' | 'refusal';
    status?: 'completed' | 'in_progress' | 'failed';
    content?: Array<{
      type: 'output_text' | 'input_text' | 'input_image' | 'input_file' | 'refusal';
      text?: string;
      image_url?: string;
      file_id?: string;
    }>;
    name?: string;
    arguments?: string;
    call_id?: string;
    output?: string;
  }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: {
      cached_tokens: number;
      audio_tokens?: number;
    };
    output_tokens_details?: {
      audio_tokens?: number;
      reasoning_tokens?: number;
    };
  };
}

/**
 * Convert Chat Completions response to Responses API format
 */
export function convertCompletionsToResponses(
  completionsResponse: OpenAIResponse,
  model: string
): OpenAIResponsesResponse {
  const responseId = `resp_${completionsResponse.id || generateResponseId()}`;
  const created = completionsResponse.created || Math.floor(Date.now() / 1000);

  // Extract the assistant message content
  const choice = completionsResponse.choices[0];
  const message = choice?.message;

  // Build output items from the chat completion message
  const outputItems: OpenAIResponsesResponse['output_items'] = [];

  if (message) {
    const outputItem: OpenAIResponsesResponse['output_items'][0] = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      type: 'message',
      status: 'completed',
      content: [],
    };

    // Handle text content
    if (message.content) {
      if (typeof message.content === 'string') {
        outputItem.content = [{
          type: 'output_text',
          text: message.content,
        }];
      } else if (Array.isArray(message.content)) {
        outputItem.content = message.content.map(part => {
          if (part.type === 'text') {
            return {
              type: 'output_text' as const,
              text: part.text,
            };
          } else if (part.type === 'image_url') {
            return {
              type: 'input_image' as const,
              image_url: part.image_url?.url,
            };
          } else if (part.type === 'thinking') {
            // Convert thinking to reasoning item
            outputItems.push({
              id: `reasoning_${Date.now()}`,
              type: 'reasoning',
              status: 'completed',
              content: [{
                type: 'output_text' as const,
                text: part.thinking,
              }],
            });
            return {
              type: 'output_text' as const,
              text: '[Reasoning hidden]',
            };
          }
          return {
            type: 'output_text' as const,
            text: '',
          };
        }).filter(c => c.text);
      }
    }

    // Handle tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        outputItems.push({
          id: toolCall.id || `tool_${Date.now()}`,
          type: 'function_call',
          status: 'completed',
          name: toolCall.function?.name || '',
          arguments: toolCall.function?.arguments || '',
          call_id: toolCall.id,
        });
      }
    }

    outputItems.push(outputItem);
  }

  // Build usage info
  const usage = completionsResponse.usage ? {
    input_tokens: completionsResponse.usage.prompt_tokens,
    output_tokens: completionsResponse.usage.completion_tokens,
    total_tokens: completionsResponse.usage.total_tokens,
    input_tokens_details: {
      cached_tokens: completionsResponse.usage.prompt_cache_hit_tokens || 0,
    },
  } : undefined;

  return {
    id: responseId,
    object: 'response',
    created,
    status: 'completed',
    model: completionsResponse.model || model,
    output_items: outputItems,
    usage,
  };
}

/**
 * Generate a response ID
 */
function generateResponseId(): string {
  return `resp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}