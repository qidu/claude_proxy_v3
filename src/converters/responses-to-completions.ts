/**
 * Converter: OpenAI Responses API format to Chat Completions format
 */

import { OpenAIRequest, OpenAIMessage } from '../types/openai.js';

/**
 * Convert OpenAI Responses API request to Chat Completions request
 */
export function convertResponsesToChatCompletions(
  responsesRequest: Record<string, unknown>,
  model: string
): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  // Extract model from responses request (may have different naming)
  const responseModel = (responsesRequest.model as string) || model;

  // Convert input items to messages
  const input = responsesRequest.input;
  if (input) {
    if (typeof input === 'string') {
      // Simple text input - treat as user message
      messages.push({
        role: 'user',
        content: input,
      });
    } else if (Array.isArray(input)) {
      // Array of input items
      for (const item of input) {
        const convertedMessages = convertInputItemToMessages(item as Record<string, unknown>);
        messages.push(...convertedMessages);
      }
    } else {
      // Object input - treat as user message
      messages.push({
        role: 'user',
        content: JSON.stringify(input),
      });
    }
  }

  // Build the completions request
  const completionsRequest: OpenAIRequest = {
    model: responseModel,
    messages,
    stream: responsesRequest.stream === true,
  };

  // Copy optional parameters
  if (responsesRequest.temperature !== undefined) {
    completionsRequest.temperature = responsesRequest.temperature as number;
  }
  if (responsesRequest.max_tokens !== undefined) {
    completionsRequest.max_tokens = responsesRequest.max_tokens as number;
  }
  if (responsesRequest.top_p !== undefined) {
    completionsRequest.top_p = responsesRequest.top_p as number;
  }
  if (responsesRequest.stop !== undefined) {
    completionsRequest.stop = responsesRequest.stop as string | string[];
  }
  if (responsesRequest.response_format !== undefined) {
    completionsRequest.response_format = responsesRequest.response_format as { type: 'text' | 'json_object' };
  }
  if (responsesRequest.tools !== undefined) {
    completionsRequest.tools = responsesRequest.tools as OpenAIRequest['tools'];
  }
  if (responsesRequest.tool_choice !== undefined) {
    completionsRequest.tool_choice = responsesRequest.tool_choice as OpenAIRequest['tool_choice'];
  }
  if (responsesRequest.frequency_penalty !== undefined) {
    completionsRequest.frequency_penalty = responsesRequest.frequency_penalty as number;
  }
  if (responsesRequest.presence_penalty !== undefined) {
    completionsRequest.presence_penalty = responsesRequest.presence_penalty as number;
  }
  if (responsesRequest.seed !== undefined) {
    completionsRequest.seed = responsesRequest.seed as number;
  }
  if (responsesRequest.logprobs !== undefined) {
    completionsRequest.logprobs = responsesRequest.logprobs as boolean | number;
  }
  if (responsesRequest.top_logprobs !== undefined) {
    completionsRequest.top_logprobs = responsesRequest.top_logprobs as number;
  }
  if (responsesRequest.thinking !== undefined) {
    completionsRequest.thinking = responsesRequest.thinking as { enabled?: boolean; budget_tokens?: number };
  }
  if (responsesRequest.reasoning_effort !== undefined) {
    completionsRequest.reasoning_effort = responsesRequest.reasoning_effort as 'low' | 'medium' | 'high';
  }

  return completionsRequest;
}

/**
 * Convert a single input item to one or more messages
 */
function convertInputItemToMessages(item: Record<string, unknown>): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  const role = item.role as string;
  const type = item.type as string;

  // Handle message type inputs
  if (type === 'message') {
    const content = item.content;
    if (content) {
      messages.push({
        role: convertRole(role),
        content: convertContentToString(content),
      });
    }
  }

  // Handle output messages being passed as input (for continuing conversations)
  if (type === 'message' && role === 'assistant') {
    const content = item.content;
    if (content && Array.isArray(content)) {
      const textContent = content.find(
        (c: Record<string, unknown>) => c.type === 'output_text'
      );
      if (textContent) {
        messages.push({
          role: 'assistant',
          content: (textContent as Record<string, unknown>).text as string,
        });
      }
    }
  }

  return messages;
}

/**
 * Convert Responses API role to Chat Completions role
 */
function convertRole(role: string): OpenAIMessage['role'] {
  switch (role) {
    case 'system':
      return 'system';
    case 'developer':
      return 'developer';
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    default:
      return 'user';
  }
}

/**
 * Convert content to string representation for simple message format
 */
function convertContentToString(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    // Array of content parts - extract text
    const texts: string[] = [];
    for (const part of content) {
      if (typeof part === 'object' && part !== null) {
        const partObj = part as Record<string, unknown>;
        if (partObj.type === 'input_text') {
          texts.push(partObj.text as string);
        } else if (partObj.type === 'input_image') {
          // Images can't be represented as simple strings in chat completions
          // Return a placeholder
          texts.push('[Image input]');
        } else if (partObj.type === 'input_file') {
          texts.push(`[File: ${(partObj.filename as string) || 'unknown'}]`);
        }
      }
    }
    return texts.join('\n');
  }

  return JSON.stringify(content);
}