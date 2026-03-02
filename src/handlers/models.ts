/**
 * Models API handler for Claude Proxy v3
 *
 * Handles GET /v1/models endpoint
 */

import { Logger } from '../utils/logger.js';
import { ClaudeModelsResponse } from '../types/claude.js';
import { OpenAIModelsResponse } from '../types/openai.js';
import { convertOpenAIModelsToClaude } from '../converters/openai-to-claude.js';
import { validateModelsRequestParams } from '../utils/validation.js';
import { handleTargetApiError } from '../utils/errors.js';

/**
 * Handle models API request
 */
export async function handleModelsRequest(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  logger: Logger
): Promise<Response> {
  // Parse query parameters
  const url = new URL(request.url);
  const afterId = url.searchParams.get('after_id') || undefined;
  const beforeId = url.searchParams.get('before_id') || undefined;
  const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!, 10) : undefined;

  // Validate parameters
  validateModelsRequestParams({ after_id: afterId, before_id: beforeId, limit });

  // Build target API URL with query parameters
  const targetApiUrl = new URL(targetUrl);
  if (afterId) targetApiUrl.searchParams.set('after', afterId);
  if (beforeId) targetApiUrl.searchParams.set('before', beforeId);
  if (limit) targetApiUrl.searchParams.set('limit', limit.toString());

  // Log upstream request headers (without auth keys for security)
  logger.debug(requestId, `Upstream request URL: ${targetApiUrl.toString()}`);
  logger.debug(requestId, `Has auth headers: ${!!authHeaders['Authorization'] || !!authHeaders['x-api-key']}`);

  // Make request to target API
  const response = await fetch(targetApiUrl.toString(), {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
  });

  // Handle target API errors
  if (!response.ok) {
    handleTargetApiError(response, 'Models API', { url: targetApiUrl.toString() });
  }

  // Parse target API response
  const responseText = await response.text();

  const openaiResponse: OpenAIModelsResponse = JSON.parse(responseText);

  // Convert to Claude format
  const claudeResponse: ClaudeModelsResponse = convertOpenAIModelsToClaude(openaiResponse);

  // Return response with Claude headers
  return new Response(JSON.stringify(claudeResponse), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': requestId,
    },
  });
}
