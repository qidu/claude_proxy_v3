/**
 * Main router and middleware for Claude Proxy v3
 *
 * Handles dynamic routing to target APIs and converts between Claude and OpenAI formats.
 * Also supports Gemini API bypass mode for direct Gemini API access.
 */

import { Env } from './types/shared';
import { parseDynamicRoute, getHandlerType, buildTargetUrl, extractAuthHeaders, isHostAllowed } from './utils/routing';
import { createErrorResponse } from './utils/errors';
import { createLogger } from './utils/logger';
import { handleModelsRequest } from './handlers/models';
import { handleTokenCountingRequest } from './handlers/token-counting';
import { handleMessagesRequest } from './handlers/messages';
import { handleGeminiRequest } from './handlers/gemini';

/**
 * Generate a unique request ID
 */
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Get CORS origin based on environment configuration
 */
function getCorsOrigin(request: Request, env: Env): string {
  // Development mode: allow all origins
  if (env.DEV_MODE === 'true' || env.DEV_MODE === '1') {
    return '*';
  }

  // Check if allowed origins are configured
  const allowedOrigins = env.ALLOWED_ORIGINS;
  if (!allowedOrigins) {
    // No configuration - be restrictive in production
    const origin = request.headers.get('origin');
    if (origin) {
      // In production without ALLOWED_ORIGINS, only allow the request's origin
      // This is a safe middle ground
      return origin;
    }
    return 'null'; // No origin header (e.g., curl requests)
  }

  // Parse allowed origins list
  const allowedList = allowedOrigins.split(',').map(o => o.trim());

  // If wildcard is in the list, allow all
  if (allowedList.includes('*')) {
    return '*';
  }

  // Check if request origin is in the allowed list
  const requestOrigin = request.headers.get('origin');
  if (requestOrigin && allowedList.includes(requestOrigin)) {
    return requestOrigin;
  }

  // Origin not allowed - return first allowed origin (or null for same-origin requests)
  return allowedList[0] || 'null';
}

/**
 * Get CORS headers configuration
 */
function getCorsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = getCorsOrigin(request, env);

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-goog-api-key, anthropic-beta',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * Apply CORS headers to response
 */
function applyCorsHeaders(response: Response, request: Request, env: Env): Response {
  const newHeaders = new Headers(response.headers);
  const corsHeaders = getCorsHeaders(request, env);

  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

/**
 * Handle OPTIONS requests for CORS preflight
 */
function handleOptionsRequest(request: Request, env: Env): Response {
  const corsHeaders = getCorsHeaders(request, env);

  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

/**
 * Check if URL uses dynamic routing (starts with /http/ or /https/)
 */
function isDynamicRoute(path: string): boolean {
  return path.startsWith('/http/') || path.startsWith('/https/');
}

/**
 * Parse fixed route and return target configuration
 * Fixed route: /v1/messages -> /v1/chat/completions
 * Uses FIXED_ROUTE_TARGET_URL and FIXED_ROUTE_PATH_PREFIX from env
 */
function parseFixedRoute(path: string, env: Env): { targetUrl: string; targetEndpoint: string } {
  const baseUrl = env.FIXED_ROUTE_TARGET_URL || 'https://api.example.com';
  const pathPrefix = env.FIXED_ROUTE_PATH_PREFIX || '';

  // Fixed route mapping: /v1/messages -> /v1/chat/completions
  if (path === '/v1/messages' || path.startsWith('/v1/messages?')) {
    return {
      targetUrl: `${baseUrl}${pathPrefix}/v1/chat/completions`,
      targetEndpoint: 'v1/chat/completions',
    };
  }

  // Token counting endpoint
  if (path === '/v1/messages/count_tokens' || path.startsWith('/v1/messages/count_tokens?')) {
    return {
      targetUrl: `${baseUrl}${pathPrefix}/v1/messages/count_tokens`,
      targetEndpoint: 'v1/messages/count_tokens',
    };
  }

  // Models endpoint
  if (path === '/v1/models' || path.startsWith('/v1/models?')) {
    return {
      targetUrl: `${baseUrl}${pathPrefix}/v1/models`,
      targetEndpoint: 'v1/models',
    };
  }

  // Gemini Interactions endpoint - bypass to Gemini API
  if (path === '/v1/interactions' || path.startsWith('/v1/interactions?')) {
    const config = {
      baseUrl: env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
      apiVersion: env.GEMINI_API_VERSION || 'v1beta',
    };
    return {
      targetUrl: `${config.baseUrl}/${config.apiVersion}/interactions`,
      targetEndpoint: 'v1/interactions',
    };
  }

  // Get specific interaction
  const interactionMatch = path.match(/^\/v1\/interactions\/(v[0-9]+_[A-Za-z0-9_-]+)$/);
  if (interactionMatch) {
    const config = {
      baseUrl: env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
      apiVersion: env.GEMINI_API_VERSION || 'v1beta',
    };
    return {
      targetUrl: `${config.baseUrl}/${config.apiVersion}/interactions/${interactionMatch[1]}`,
      targetEndpoint: 'v1/interactions/get',
    };
  }

  // Cancel interaction
  const cancelMatch = path.match(/^\/v1\/interactions\/(v[0-9]+_[A-Za-z0-9_-]+)\/cancel$/);
  if (cancelMatch) {
    const config = {
      baseUrl: env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
      apiVersion: env.GEMINI_API_VERSION || 'v1beta',
    };
    return {
      targetUrl: `${config.baseUrl}/${config.apiVersion}/interactions/${cancelMatch[1]}/cancel`,
      targetEndpoint: 'v1/interactions/cancel',
    };
  }

  throw new Error(`Unsupported fixed route: ${path}`);
}

/**
 * Main request handler
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = generateRequestId();
    const logger = createLogger(env as Record<string, unknown>);

    try {
      // Handle CORS preflight
      if (request.method === 'OPTIONS') {
        return handleOptionsRequest(request, env);
      }

      const url = new URL(request.url);
      const path = url.pathname;

      // Skip favicon requests
      if (path === '/favicon.ico') {
        return new Response(null, { status: 204 });
      }

      // Request body size limit (10MB)
      const contentLength = request.headers.get('content-length');
      if (contentLength) {
        const sizeInBytes = parseInt(contentLength, 10);
        const maxSizeBytes = 10 * 1024 * 1024; // 10MB
        if (sizeInBytes > maxSizeBytes) {
          logger.warn(requestId, `Request body too large: ${sizeInBytes} bytes`);
          return createErrorResponse(new Error('Request body too large'), requestId, 413);
        }
      }

      let targetUrl: string;
      let handlerType: 'models' | 'token-counting' | 'messages' | 'gemini';
      let modelId: string | undefined;
      let isGeminiBypass = false;

      // Determine routing mode based on URL path
      if (isDynamicRoute(path)) {
        // Dynamic routing: /https/api.qnaigc.com/v1/messages
        const parsedRoute = parseDynamicRoute(path);
        const { targetConfig, claudeEndpoint } = parsedRoute;
        modelId = parsedRoute.modelId;

        // Check for Gemini API bypass mode
        const isGeminiApi = targetConfig.targetUrl.includes('generativelanguage.googleapis.com') ||
                           targetConfig.targetUrl.includes('gemini');

        if (isGeminiApi && (env.GEMINI_BYPASS_ENABLED === 'true' || env.GEMINI_BYPASS_ENABLED === '1')) {
          // Gemini API bypass mode
          isGeminiBypass = true;
          handlerType = 'gemini';
          targetUrl = buildTargetUrl(targetConfig, claudeEndpoint, modelId);
        } else {
          // Standard routing
          // SSRF protection: validate host against whitelist
          const host = targetConfig.targetUrl.replace(/^https?:\/\//, '');
          if (!isHostAllowed(host, env.ALLOWED_HOSTS)) {
            logger.warn(requestId, `Host not allowed: ${host}. Allowed hosts: ${env.ALLOWED_HOSTS || '127.0.0.1, localhost'}`);
            return createErrorResponse(new Error('Host not allowed'), requestId, 403);
          }

          handlerType = getHandlerType(claudeEndpoint);
          targetUrl = buildTargetUrl(targetConfig, claudeEndpoint, modelId);
        }
      } else {
        // Fixed routing: /v1/messages -> /v1/chat/completions
        const fixedRoute = parseFixedRoute(path, env);
        targetUrl = fixedRoute.targetUrl;

        // Map endpoint to handler type
        if (fixedRoute.targetEndpoint === 'v1/models') {
          handlerType = 'models';
        } else if (fixedRoute.targetEndpoint === 'v1/messages/count_tokens') {
          handlerType = 'token-counting';
        } else if (fixedRoute.targetEndpoint.startsWith('v1/interactions')) {
          handlerType = 'gemini';
        } else {
          handlerType = 'messages';
        }
      }

      // Extract authentication headers
      const authHeaders = extractAuthHeaders(request);

      // Route to appropriate handler
      let response: Response;
      switch (handlerType) {
        case 'models':
          response = await handleModelsRequest(request, targetUrl, authHeaders, requestId, logger);
          break;

        case 'token-counting':
          response = await handleTokenCountingRequest(request, targetUrl, authHeaders, requestId, env, logger);
          break;

        case 'messages':
          response = await handleMessagesRequest(request, targetUrl, authHeaders, requestId, modelId, env, logger);
          break;

        case 'gemini':
          response = await handleGeminiRequest(request, targetUrl, authHeaders, requestId, modelId, env, logger);
          break;

        default:
          throw new Error(`Unsupported handler type: ${handlerType}`);
      }

      // Apply CORS headers
      return applyCorsHeaders(response, request, env);

    } catch (error) {
      // Handle errors with Claude API format (without exposing sensitive info)
      logger.error(requestId, `Error: ${(error as Error).message}`);
      return createErrorResponse(error as Error, requestId);
    }
  },
};
