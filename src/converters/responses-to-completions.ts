/**
 * Converter: OpenAI Responses API format to Chat Completions format
 */

import { OpenAIRequest, OpenAIMessage } from '../types/openai.js';
import { stringify } from '../utils/stringify.js';

/**
 * Convert OpenAI Responses API request to Chat Completions request
 */
export function convertResponsesToChatCompletions(
  responsesRequest: Record<string, unknown>,
  model: string
): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  // model parameter is the alias (already resolved by the caller); prefer it over the raw
  // body field so that model remapping (e.g. codex-mini-latest → gpt-4o-mini) takes effect.
  const responseModel = model || (responsesRequest.model as string);

  // Map top-level instructions to a system message (prepended before input)
  if (responsesRequest.instructions) {
    messages.push({
      role: 'system',
      content: responsesRequest.instructions as string,
    });
  }

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
      // Array of input items — use the stateful converter to thread reasoning across turns
      messages.push(...convertInputItemsToMessages(input as Array<Record<string, unknown>>));
    } else {
      // Object input - treat as user message
      messages.push({
        role: 'user',
        content: stringify(input),
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
  if (responsesRequest.max_output_tokens !== undefined) {
    completionsRequest.max_tokens = responsesRequest.max_output_tokens as number;
  } else if (responsesRequest.max_tokens !== undefined) {
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
    // Responses API function tools use a flat format:
    //   { type: "function", name: "fn", description?: "...", parameters: {...} }
    // Chat Completions uses a nested format:
    //   { type: "function", function: { name: "fn", description?: "...", parameters: {...} } }
    // Non-function Responses API tools (web_search_preview, file_search, etc.) are dropped.
    const converted = (responsesRequest.tools as Array<Record<string, unknown>>)
      .filter(t => t.type === 'function')
      .map(t => {
        if (t.function != null) {
          // Already in Chat Completions nested format — pass through as-is
          return t as unknown as { type: 'function'; function: { name: string; description?: string; parameters: any } };
        }
        // Responses API flat format → Chat Completions nested format
        return {
          type: 'function' as const,
          function: {
            name: t.name as string,
            ...(t.description != null ? { description: t.description as string } : {}),
            parameters: t.parameters,
          },
        };
      });
    if (converted.length > 0) {
      completionsRequest.tools = converted;
    }
  }
  if (responsesRequest.tool_choice !== undefined) {
    const tc = responsesRequest.tool_choice as Record<string, unknown> | string;
    if (typeof tc === 'object' && tc !== null && tc.type === 'function') {
      // Responses API: { type: "function", name: "fn" }
      // Chat Completions: { type: "function", function: { name: "fn" } }
      completionsRequest.tool_choice = {
        type: 'function',
        function: { name: tc.name as string },
      };
    } else {
      // "auto" | "none" | "required" — pass through as-is
      completionsRequest.tool_choice = tc as OpenAIRequest['tool_choice'];
    }
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
 * Convert a list of input items to messages, threading reasoning_content from
 * standalone reasoning items through to adjacent assistant/function_call turns.
 *
 * Multiple consecutive function_call items are merged into a single assistant
 * message with multiple tool_calls — the Chat Completions API (and DeepSeek)
 * require all tool_calls from a single turn to appear in one assistant message.
 */
export function convertInputItemsToMessages(items: Array<Record<string, unknown>>): OpenAIMessage[] {
  const allMessages: OpenAIMessage[] = [];
  let pendingReasoningContent: string | null = null;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if (item.type === 'reasoning') {
      // Extract text from reasoning item content array
      const content = item.content as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(content)) {
        pendingReasoningContent = content
          .filter(c => c.type === 'reasoning_text')
          .map(c => c.text as string)
          .join('');
      }
      continue; // no message emitted for reasoning items
    }

    if (item.type === 'function_call') {
      // Collect ALL consecutive function_call items and merge into ONE assistant
      // message with multiple tool_calls.  This is required by Chat Completions:
      // a single assistant turn that calls N tools must list all N calls in one
      // message, followed by N tool-result messages.
      const toolCallItems: Record<string, unknown>[] = [item];
      while (i + 1 < items.length && items[i + 1].type === 'function_call') {
        i++;
        toolCallItems.push(items[i]);
      }

      const assistantMsg: OpenAIMessage = {
        role: 'assistant',
        content: null as unknown as string,
        tool_calls: toolCallItems.map(tc => ({
          id: tc.call_id as string || tc.id as string,
          type: 'function' as const,
          function: {
            name: tc.name as string,
            arguments: tc.arguments as string,
          },
        })),
      };
      if (pendingReasoningContent) {
        (assistantMsg as unknown as Record<string, unknown>).reasoning_content = pendingReasoningContent;
      }
      pendingReasoningContent = null;
      allMessages.push(assistantMsg);
      continue;
    }

    const msgs = convertInputItemToMessages(item, pendingReasoningContent);
    if (item.type === 'message') {
      pendingReasoningContent = null;
    }
    allMessages.push(...msgs);
  }
  return allMessages;
}

/**
 * Convert a single input item to one or more messages
 */
function convertInputItemToMessages(item: Record<string, unknown>, pendingReasoningContent?: string | null): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  const role = item.role as string;
  const type = item.type as string;

  if (type === 'reasoning') {
    // Standalone reasoning output item — consumed by convertInputItemsToMessages above.
    // Emit nothing here; the reasoning text is attached to the next assistant turn.
    return messages;
  }

  if (type === 'message') {
    const content = item.content;
    if (role === 'assistant' && Array.isArray(content)) {
      // Output messages passed as input (continuing conversations) — extract output_text.
      // When the prior turn used thinking mode, also pull out reasoning_text so
      // upstreams like DeepSeek that require reasoning_content to be round-tripped
      // (when sending the conversation back on a later turn) do not reject the request.
      const textContent = content.find(
        (c: Record<string, unknown>) => c.type === 'output_text'
      );
      const reasoningContent = content.find(
        (c: Record<string, unknown>) => c.type === 'reasoning_text'
      );
      if (textContent || reasoningContent) {
        const assistantMsg: OpenAIMessage = {
          role: 'assistant',
          content: textContent
            ? (textContent as Record<string, unknown>).text as string
            : '',
        };
        if (reasoningContent) {
          (assistantMsg as unknown as Record<string, unknown>).reasoning_content =
            (reasoningContent as Record<string, unknown>).text as string;
        }
        messages.push(assistantMsg);
      }
    } else if (content) {
      messages.push({
        role: convertRole(role),
        content: convertContentToString(content),
      });
    }
  } else if (type === 'function_call') {
    // Assistant-side tool call — map to an assistant message with tool_calls.
    // Attach reasoning_content when a preceding reasoning item was collected so
    // thinking-mode upstreams (e.g. DeepSeek) don't reject the multi-turn request.
    const assistantMsg: OpenAIMessage = {
      role: 'assistant',
      content: null as unknown as string,
      tool_calls: [{
        id: item.call_id as string || item.id as string,
        type: 'function',
        function: {
          name: item.name as string,
          arguments: item.arguments as string,
        },
      }],
    };
    if (pendingReasoningContent) {
      (assistantMsg as unknown as Record<string, unknown>).reasoning_content = pendingReasoningContent;
    }
    messages.push(assistantMsg);
  } else if (type === 'function_call_output') {
    // Tool result — map to a tool message
    messages.push({
      role: 'tool',
      content: item.output as string ?? '',
      tool_call_id: item.call_id as string,
    });
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
      return 'system';
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

  return stringify(content);
}