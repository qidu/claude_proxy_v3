/**
 * Token Counting API handler for Claude Proxy v3
 *
 * Handles POST /v1/messages/count_tokens endpoint
 *
 * Features:
 * - Supports both API-based and local token counting
 * - Local counting is enabled via LOCAL_TIKTOKEN=true environment variable
 * - Falls back to byte-based counting for user text when API-based counting fails
 * - Uses tiktoken for accurate BPE token counting when LOCAL_TIKTOKEN=true
 */

import { Env } from '../types/shared.js';
import { Logger, createLogger } from '../utils/logger.js';
import { ClaudeTokenCountingRequest, ClaudeTokenCountingResponse } from '../types/claude.js';
import { OpenAIResponse, OpenAITokenCountingRequest } from '../types/openai.js';
import { convertClaudeTokenCountingToOpenAI } from '../converters/claude-to-openai.js';
import { validateClaudeTokenCountingRequest, validateAuthHeaders } from '../utils/validation.js';
import { handleTargetApiError } from '../utils/errors.js';
import {
  countClaudeRequestTokens,
  getLocalTokenCountingConfig,
  TokenCountingOptions,
  getTiktokenTokenizer,
} from '../utils/token-counting.js';
import { addForwardedHeaders } from '../utils/routing.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';

/**
 * Handle token counting API request
 *
 * @param request - Incoming request
 * @param targetUrl - Target API URL
 * @param authHeaders - Authentication headers
 * @param requestId - Request ID for logging
 * @param env - Environment variables (Cloudflare Workers)
 * @param logger - Logger instance
 * @returns Response with token count
 */
export async function handleTokenCountingRequest(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  env?: Env,
  logger?: Logger
): Promise<Response> {
  const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);
  // Parse request body
  const requestBody = await request.json() as ClaudeTokenCountingRequest;
  const claudeRequest = requestBody;

  // Calculate max image data size from environment or use default
  const maxImageDataSize = env?.IMAGE_BLOCK_DATA_MAX_SIZE
    ? parseInt(env.IMAGE_BLOCK_DATA_MAX_SIZE, 10)
    : 1 * 1024 * 1024; // Default 1MB

  // Validate request
  validateClaudeTokenCountingRequest(claudeRequest, maxImageDataSize);
  validateAuthHeaders(authHeaders);

  // Use env for local config (cast to Record<string, string> for compatibility)
  const localConfig = getLocalTokenCountingConfig(env as unknown as Record<string, string> | undefined);

  if (localConfig.enabled) {
    return handleLocalTokenCounting(claudeRequest, requestId, localConfig, activeLogger);
  }

  // Fall back to API-based token counting
  return handleApiBasedTokenCounting(claudeRequest, targetUrl, authHeaders, requestId, request, activeLogger, env);
}

/**
 * Handle token counting using local estimation or tiktoken
 *
 * This uses character-based approximation or tiktoken BPE encoding.
 * No API call is made, making it free and fast.
 */
async function handleLocalTokenCounting(
  claudeRequest: ClaudeTokenCountingRequest,
  requestId: string,
  localConfig: { enabled: boolean; useTiktoken: boolean; modelName: string; bpeUrl?: string },
  logger: Logger
): Promise<Response> {
  let options: TokenCountingOptions;
  let countingMethod: 'tiktoken' | 'estimation';
  let tokenizerInfo: string = '';

  if (localConfig.useTiktoken) {
    // Initialize tiktoken tokenizer
    logger.debug(requestId, `Initializing tiktoken with model: ${localConfig.modelName}`);
    try {
      const tokenizer = await getTiktokenTokenizer(localConfig.modelName, localConfig.bpeUrl);
      options = {
        useLocalCounting: true,
        tokenizer,
        countWhitespace: true,
      };
      countingMethod = 'tiktoken';
      tokenizerInfo = ` (model: ${localConfig.modelName})`;
    } catch (error) {
      logger.warn(requestId, `Failed to initialize tiktoken: ${(error as Error).message}, falling back to estimation`);
      options = {
        useLocalCounting: true,
        countWhitespace: true,
      };
      countingMethod = 'estimation';
    }
  } else {
    // Use character-based estimation
    options = {
      useLocalCounting: true,
      countWhitespace: true,
    };
    countingMethod = 'estimation';
  }

  // Count tokens
  const inputTokens = countClaudeRequestTokens(claudeRequest, options);

  logger.debug(requestId, `Local token count (${countingMethod}): ${inputTokens}${tokenizerInfo}`);

  const response: ClaudeTokenCountingResponse = {
    type: "token_count",
    input_tokens: inputTokens,
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': requestId,
      'x-token-counting': countingMethod,
    },
  });
}

/**
 * Handle token counting using API-based approach
 *
 * This sends a request to the target API's chat completions endpoint
 * and extracts the usage information from the response.
 *
 * Note: This may incur API costs and make an actual API call.
 */
function extractUserTextBytesAsTokenEstimate(claudeRequest: ClaudeTokenCountingRequest): number {
  let totalBytes = 0;

  for (const message of claudeRequest.messages || []) {
    if (message.role !== 'user') {
      continue;
    }

    if (typeof message.content === 'string') {
      totalBytes += new TextEncoder().encode(message.content).length;
      continue;
    }

    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type === 'text' && typeof part.text === 'string') {
          totalBytes += new TextEncoder().encode(part.text).length;
        }
      }
    }
  }

  return totalBytes;
}

function buildByteFallbackTokenCountResponse(requestId: string, inputTokens: number): Response {
  const claudeResponse: ClaudeTokenCountingResponse = {
    type: 'token_count',
    input_tokens: inputTokens,
  };

  return new Response(JSON.stringify(claudeResponse), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': requestId,
      'x-token-counting': 'bytes-fallback',
    },
  });
}

async function handleApiBasedTokenCounting(
  claudeRequest: ClaudeTokenCountingRequest,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  request: Request,
  logger: Logger,
  env?: Env
): Promise<Response> {
  // Convert Claude request to OpenAI format
  const openaiRequest: OpenAITokenCountingRequest = convertClaudeTokenCountingToOpenAI(
    claudeRequest,
    claudeRequest.model,
    requestId
  );

  // Convert endpoint from Claude format to OpenAI format
  // /v1/messages/count_tokens -> /v1/chat/completions
  if (targetUrl.includes('v1/messages/count_tokens')) {
    targetUrl = targetUrl.replace('v1/messages/count_tokens', 'v1/chat/completions');
  }

  // Log request info (without auth keys for security)
  logger.debug(requestId, `Upstream request url: ${targetUrl}`);
  logger.debug(requestId, `Has auth headers: ${!!authHeaders['Authorization'] || !!authHeaders['x-api-key']}`);
  logger.info(requestId, 'Using API-based token counting (may incur costs)');

  // Make request to target API
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...addForwardedHeaders(authHeaders, request),
    },
    body: JSON.stringify(openaiRequest),
    signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
  });

  // Handle target API errors (fallback to byte-based estimate for user text)
  if (!response.ok) {
    const bodyPreview = JSON.stringify(openaiRequest).substring(0, 1000);
    logger.warn(requestId, `API-based token counting failed (${response.status}), falling back to byte-based estimate`);
    const byteEstimate = extractUserTextBytesAsTokenEstimate(claudeRequest);
    return buildByteFallbackTokenCountResponse(requestId, byteEstimate);
  }

  // Parse target API response
  const responseText = await response.text();

  const openaiResponse: OpenAIResponse = JSON.parse(responseText);

  // Extract input tokens from usage
  const inputTokens = openaiResponse.usage?.prompt_tokens ?? 0;
  logger.debug(requestId, `Token count: ${inputTokens}`);

  // Build Claude format response
  const claudeResponse: ClaudeTokenCountingResponse = {
    type: "token_count",
    input_tokens: inputTokens,
  };

  // Return response with Claude headers
  return new Response(JSON.stringify(claudeResponse), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': requestId,
      'x-token-counting': 'api',
    },
  });
}
