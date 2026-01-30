/**
 * Token counting utility
 *
 * Provides optional local token counting as an alternative to API-based counting.
 * This is useful for the /v1/messages/count_tokens endpoint when targeting
 * OpenAI-compatible APIs that don't have a native count_tokens endpoint.
 *
 * Configuration:
 * - LOCAL_TOKEN_COUNTING: Set to "true" to enable local token counting
 * - TIKTOKEN_MODEL: Model name for tiktoken encoding (default: cl100k_base)
 *   Supported models: cl100k_base, p50k_base, p50k_edit, r50k_base, gpt2, o200k_base
 * - TIKTOKEN_BPE_URL: URL to fetch tiktoken BPE data from (default: OpenAI's CDN)
 *   Note: bpeUrl parameter is currently not used with js-tiktoken
 */

import { Tiktoken } from 'js-tiktoken/lite';
import o200k_base from 'js-tiktoken/ranks/o200k_base';
import cl100k_base from 'js-tiktoken/ranks/cl100k_base';
import p50k_base from 'js-tiktoken/ranks/p50k_base';
import p50k_edit from 'js-tiktoken/ranks/p50k_edit';
import r50k_base from 'js-tiktoken/ranks/r50k_base';
import gpt2 from 'js-tiktoken/ranks/gpt2';

export interface TokenCountingOptions {
  /** Whether to use local token counting (default: false, use API) */
  useLocalCounting?: boolean;
  /** Characters per token estimate for local counting (default: 4) */
  charactersPerToken?: number;
  /** Whether to count whitespace tokens (default: true) */
  countWhitespace?: boolean;
  /** Custom Tiktoken instance for accurate counting */
  tokenizer?: Tiktoken | null;
}

/**
 * Default options
 */
const DEFAULT_OPTIONS: TokenCountingOptions = {
  useLocalCounting: false, // Default to API-based counting
  charactersPerToken: 4,
  countWhitespace: true,
  tokenizer: null,
};

// Cache for loaded tokenizer
let cachedTokenizer: Tiktoken | null = null;
let tokenizerModelName: string = '';

/**
 * Get or initialize the Tiktoken tokenizer
 */
export async function getTiktokenTokenizer(
  modelName: string = 'cl100k_base',
  bpeUrl?: string
): Promise<Tiktoken> {
  if (cachedTokenizer && tokenizerModelName === modelName) {
    return cachedTokenizer;
  }

  // Map model names to their corresponding encodings
  let encoding;
  switch (modelName) {
    case 'cl100k_base':
      encoding = cl100k_base;
      break;
    case 'p50k_base':
      encoding = p50k_base;
      break;
    case 'p50k_edit':
      encoding = p50k_edit;
      break;
    case 'r50k_base':
      encoding = r50k_base;
      break;
    case 'gpt2':
      encoding = gpt2;
      break;
    case 'o200k_base':
    default:
      encoding = o200k_base;
      break;
  }

  cachedTokenizer = new Tiktoken(encoding);
  tokenizerModelName = modelName;
  return cachedTokenizer!;
}

/**
 * Estimate token count for a text string using character-based approximation
 *
 * This is a simple estimation that works reasonably well for English text.
 * For more accurate counting, use tiktoken or similar libraries.
 *
 * @param text - The text to count tokens for
 * @param options - Counting options
 * @returns Estimated token count
 */
export function estimateTokenCount(
  text: string,
  options: TokenCountingOptions = DEFAULT_OPTIONS
): number {
  const { charactersPerToken = 4, countWhitespace } = { ...DEFAULT_OPTIONS, ...options };

  if (!text || text.length === 0) {
    return 0;
  }

  let content = text;

  // If not counting whitespace, remove extra whitespace
  if (!countWhitespace) {
    content = text.replace(/\s+/g, ' ').trim();
  }

  // Estimate tokens based on character count
  // Average English word is about 4.5 characters including space
  // This is a rough approximation suitable for estimation
  const estimatedTokens = Math.ceil(content.length / charactersPerToken);

  // Add overhead for special tokens (system prompt, role markers, etc.)
  // Roughly 3-5 tokens overhead per message
  const overheadTokens = 5;

  return estimatedTokens + overheadTokens;
}

/**
 * Count tokens in a text string using tiktoken (if available)
 *
 * @param text - The text to count tokens for
 * @param options - Counting options with tokenizer
 * @returns Token count
 */
export function countTokensWithTiktoken(
  text: string,
  options: TokenCountingOptions = DEFAULT_OPTIONS
): number {
  if (!text || text.length === 0) {
    return 0;
  }

  const tokenizer = options.tokenizer ?? null;
  if (!tokenizer) {
    // Fallback to estimation if no tokenizer available
    return estimateTokenCount(text, options);
  }

  // Use tiktoken to count actual tokens
  const tokens = tokenizer.encode(text);
  return tokens.length;
}

/**
 * Count tokens in a message object
 *
 * @param message - Message object with role and content
 * @param options - Counting options
 * @returns Token count for the message
 */
export function countMessageTokens(
  message: { role: string; content: string | Array<{ type: string; text?: string }> },
  options: TokenCountingOptions = DEFAULT_OPTIONS
): number {
  let tokenCount = 0;
  const useTiktoken = options.tokenizer != null;

  // Add tokens for role
  const roleText = `role: ${message.role}`;
  if (useTiktoken) {
    tokenCount += countTokensWithTiktoken(roleText, options);
  } else {
    tokenCount += estimateTokenCount(roleText, options);
  }

  // Count content
  if (typeof message.content === 'string') {
    if (useTiktoken) {
      tokenCount += countTokensWithTiktoken(message.content, options);
    } else {
      tokenCount += estimateTokenCount(message.content, options);
    }
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === 'text' && block.text) {
        if (useTiktoken) {
          tokenCount += countTokensWithTiktoken(block.text, options);
        } else {
          tokenCount += estimateTokenCount(block.text, options);
        }
      }
      // Skip non-text blocks for local counting
    }
  }

  // Add token for content type indicator
  tokenCount += 2;

  return tokenCount;
}

/**
 * Count tokens in a list of messages
 *
 * @param messages - Array of messages
 * @param options - Counting options
 * @returns Total token count
 */
export function countMessagesTokens(
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>,
  options: TokenCountingOptions = DEFAULT_OPTIONS
): number {
  let totalTokens = 0;

  for (const message of messages) {
    totalTokens += countMessageTokens(message, options);
  }

  // Add tokens for message separators
  totalTokens += 3;

  return totalTokens;
}

/**
 * Count tokens in system prompt
 *
 * @param system - System prompt (string or array of text blocks)
 * @param options - Counting options
 * @returns Token count for system prompt
 */
export function countSystemTokens(
  system: string | Array<{ type: string; text?: string }>,
  options: TokenCountingOptions = DEFAULT_OPTIONS
): number {
  if (!system) {
    return 0;
  }

  const useTiktoken = options.tokenizer != null;

  if (typeof system === 'string') {
    if (useTiktoken) {
      return countTokensWithTiktoken(system, options);
    }
    return estimateTokenCount(system, options);
  }

  let tokenCount = 0;
  for (const block of system) {
    if (block.type === 'text' && block.text) {
      if (useTiktoken) {
        tokenCount += countTokensWithTiktoken(block.text, options);
      } else {
        tokenCount += estimateTokenCount(block.text, options);
      }
    }
  }

  return tokenCount;
}

/**
 * Helper function to count tokens with appropriate method
 */
function countStringTokens(text: string, options: TokenCountingOptions): number {
  const useTiktoken = options.tokenizer != null;
  if (useTiktoken) {
    return countTokensWithTiktoken(text, options);
  }
  return estimateTokenCount(text, options);
}

/**
 * Main function to count tokens in a Claude-style request
 *
 * @param requestBody - Request body with model, messages, system, tools, etc.
 * @param options - Counting options
 * @returns Estimated input token count
 */
export function countClaudeRequestTokens(
  requestBody: {
    model?: string;
    messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
    system?: string | Array<{ type: string; text?: string }>;
    tools?: Array<{ name: string; description?: string; input_schema?: Record<string, unknown> }>;
    tool_choice?: { type: string; name?: string };
    thinking?: { type: string; budget_tokens?: number };
  },
  options: TokenCountingOptions = DEFAULT_OPTIONS
): number {
  let totalTokens = 0;
  const useTiktoken = options.tokenizer != null;

  // Count model name tokens (usually 1-2)
  if (requestBody.model) {
    totalTokens += countStringTokens(requestBody.model, options) + 1;
  }

  // Count system prompt tokens
  if (requestBody.system) {
    totalTokens += countSystemTokens(requestBody.system, options);
  }

  // Count messages tokens
  totalTokens += countMessagesTokens(requestBody.messages, options);

  // Estimate tool definition tokens
  if (requestBody.tools && requestBody.tools.length > 0) {
    for (const tool of requestBody.tools) {
      let toolContent = `tool: ${tool.name}`;
      if (tool.description) {
        toolContent += `\ndescription: ${tool.description}`;
      }
      if (tool.input_schema) {
        toolContent += `\nparameters: ${JSON.stringify(tool.input_schema)}`;
      }
      totalTokens += countStringTokens(toolContent, options) + 3;
    }
    // Add overhead for tools array
    totalTokens += 5;
  }

  // Estimate tool_choice tokens
  if (requestBody.tool_choice) {
    if (requestBody.tool_choice.type === 'tool' && requestBody.tool_choice.name) {
      totalTokens += countStringTokens(`tool_choice: ${requestBody.tool_choice.name}`, options) + 2;
    } else {
      totalTokens += countStringTokens(`tool_choice: ${requestBody.tool_choice.type}`, options) + 2;
    }
  }

  // Estimate thinking config tokens
  if (requestBody.thinking) {
    totalTokens += countStringTokens(`thinking: ${requestBody.thinking.type}`, options) + 2;
    if (requestBody.thinking.budget_tokens) {
      totalTokens += countStringTokens(`budget: ${requestBody.thinking.budget_tokens}`, options);
    }
  }

  return totalTokens;
}

/**
 * Get local token counting configuration from environment
 */
export function getLocalTokenCountingConfig(env?: Record<string, string>): {
  enabled: boolean;
  useTiktoken: boolean;
  modelName: string;
  bpeUrl?: string;
} {
  // Check for environment variable
  // In Cloudflare Workers, env is passed via the second parameter
  // Otherwise fall back to globalThis.process.env for local development
  const envVars = env || (typeof globalThis !== 'undefined' && (globalThis as any).process?.env ? (globalThis as any).process.env as Record<string, string> : {});

  const enabled = envVars.LOCAL_TOKEN_COUNTING === 'true' ||
    envVars.LOCAL_TOKEN_COUNTING === '1';

  // Tiktoken options
  const useTiktoken = envVars.LOCAL_TIKTOKEN !== 'false' && envVars.LOCAL_TIKTOKEN !== '0';
  const modelName = envVars.TIKTOKEN_MODEL || 'cl100k_base';
  const bpeUrl = envVars.TIKTOKEN_BPE_URL;

  return {
    enabled,
    useTiktoken,
    modelName,
    bpeUrl,
  };
}
