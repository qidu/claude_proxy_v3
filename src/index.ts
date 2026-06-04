/**
 * Main router and middleware for Claude Proxy v3
 *
 * Handles dynamic routing to target APIs and converts between Claude and OpenAI formats.
 * Also supports Gemini API bypass mode for direct Gemini API access.
 */

import { Env } from './types/shared.js';
import { extractAuthHeaders, transformAuthHeadersForUpstream, formatApiKeyForUpstream } from './utils/routing.js';
import { createErrorResponse, OverLimitError } from './utils/errors.js';
import { createLogger } from './utils/logger.js';
import { handleModelsRequest, getModelCount } from './handlers/models.js';
import { handleTokenCountingRequest } from './handlers/token-counting.js';
import { handleMessagesRequest } from './handlers/messages.js';
import { handleResponsesRequest, handleResponsesCompactRequest, handleResponsesInputTokensRequest } from './handlers/responses.js';
import { handleGeminiRequest, handleGeminiRequestForMessages } from './handlers/gemini.js';
import { handleOpenAIRequest } from './handlers/openai.js';
import { handleClaudeRequest } from './handlers/claude.js';
import { handleEmbeddingsRequest } from './handlers/embeddings.js';
import { handleChatCompletionsPassthrough } from './handlers/chat-completions.js';
import {
  handleDashboardAgentStats,
  handleDashboardGetConfig,
  handleDashboardModelStats,
  handleDashboardPage,
  handleDashboardPutConfig,
  handleDashboardRequestStats,
} from './handlers/dashboard.js';
import { loadProxyConfig, clearProxyConfigCache, dumpProxyConfigToml, getConfiguredModelIds, getModelRouteConfig, getCompositeRouteCandidates, ModelRouteConfig, ProxyConfig } from './utils/config-loader.js';
import {
  extractToolNamesFromBody,
  extractToolRequestCharLengthsFromBody,
  extractToolNamesFromResponsePayload,
  extractUsageFromResponsePayload,
  extractUserAgentPrefix,
  createResponseToolTrackingTransformStream,
  recordAgentStat,
  recordModelStat,
  recordToolRequestChars,
  recordUpstreamResponseToolNames,
  recordModelFailedRequest,
  recordModelUsage,
  getModelTotalTokens,
  recordRequestEndpoint,
  recordRequestTiming,
  recordResponseStatusCodeFromUpstream,
  recordResponseStatusCodeToEndpoint,
  recordResponseUpstream,
  createUsageTrackingTransformStream,
} from './utils/dashboard-stats.js';
import { ThinkingConversionOptions } from './converters/claude-to-openai.js';

let hasLoggedUpstreamConfig = false;

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
  const requestOrigin = request.headers.get('origin');
  const isLocalhostOrigin = requestOrigin === 'http://localhost' ||
    requestOrigin === 'https://localhost' ||
    requestOrigin?.startsWith('http://localhost:') ||
    requestOrigin?.startsWith('https://localhost:') ||
    requestOrigin === 'http://127.0.0.1' ||
    requestOrigin === 'https://127.0.0.1' ||
    requestOrigin?.startsWith('http://127.0.0.1:') ||
    requestOrigin?.startsWith('https://127.0.0.1:');

  // Always allow localhost origins for local dashboard/API usage.
  if (isLocalhostOrigin && requestOrigin) {
    return requestOrigin;
  }

  // Development mode: allow all origins
  if (env.DEV_MODE === 'true' || env.DEV_MODE === '1') {
    return '*';
  }

  // Check if allowed origins are configured
  const allowedOrigins = env.ALLOWED_ORIGINS;
  if (!allowedOrigins) {
    // No configuration - be restrictive in production
    if (requestOrigin) {
      // In production without ALLOWED_ORIGINS, only allow the request's origin
      // This is a safe middle ground
      return requestOrigin;
    }
    return 'null'; // No origin header (e.g., curl requests)
  }

  // Parse allowed origins list
  const allowedList = (allowedOrigins as string).split(',').map((o: string) => o.trim());

  // If wildcard is in the list, allow all
  if (allowedList.includes('*')) {
    return '*';
  }

  // Check if request origin is in the allowed list
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
 * Uses [models.default] and [upstream] from proxy_config.toml
 */
function parseFixedRoute(path: string, proxyConfig: ProxyConfig, env: Env): {
  targetUrl: string;
  targetEndpoint: string;
  handlerType: 'messages' | 'interactions' | 'generateContent' | 'models' | 'token-counting' | 'responses' | 'responses-compact' | 'responses-input-tokens' | 'embeddings' | 'chat-completions';
  upstreamMode?: string;
  modelId?: string;
  forceStreaming?: boolean;
} {
  // Get default config from [models.default] or [upstream]
  const defaultCategory = proxyConfig.models?.default;
  const defaultCategoryConfig = defaultCategory && !Array.isArray(defaultCategory) ? defaultCategory : undefined;
  const defaultMode = defaultCategoryConfig?.upstream_mode || 
                      proxyConfig.upstream?.upstream_mode || 
                      'openai-completions';
  const defaultBaseUrl = defaultCategoryConfig?.base_url || 
                        proxyConfig.upstream?.default_base_url || 
                        'https://api.qnaigc.com';

  // 1. /v1/messages → multiple upstream modes
  if (path === '/v1/messages' || path.startsWith('/v1/messages?')) {
    if (defaultMode === 'anthropic-messages') {
      // Native Claude API
      return {
        targetUrl: `${defaultBaseUrl}/v1/messages`,
        targetEndpoint: 'v1/messages',
        handlerType: 'messages',
        upstreamMode: 'anthropic-messages',
      };
    } else if (defaultMode === 'gemini-generatecontent' || defaultMode === 'gemini-interactions') {
      // Native Gemini API - not typically used for /v1/messages but supported
      return {
        targetUrl: `${defaultBaseUrl}/v1beta/models`,
        targetEndpoint: 'v1/messages',
        handlerType: 'messages',
        upstreamMode: defaultMode,
      };
    } else {
      // OpenAI-compatible upstream
      return {
        targetUrl: `${defaultBaseUrl}/v1/chat/completions`,
        targetEndpoint: 'v1/messages',
        handlerType: 'messages',
        upstreamMode: 'openai-completions',
      };
    }
  }

  // 2. /v1/interactions → multiple upstream modes
  if (path === '/v1/interactions' || path.startsWith('/v1/interactions?')) {
    if (defaultMode === 'gemini-generatecontent' || defaultMode === 'gemini-interactions') {
      // Native Gemini API
      const apiVersion = env.GEMINI_API_VERSION || 'v1beta';
      return {
        targetUrl: `${defaultBaseUrl}/${apiVersion}`,
        targetEndpoint: 'v1/interactions',
        handlerType: 'interactions',
        upstreamMode: defaultMode,
      };
    } else {
      // OpenAI-compatible upstream
      return {
        targetUrl: `${defaultBaseUrl}/v1/chat/completions`,
        targetEndpoint: 'v1/interactions',
        handlerType: 'interactions',
        upstreamMode: 'openai-completions',
      };
    }
  }

  // 3. /v1beta/models/{model}:generateContent or :streamGenerateContent → multiple upstream modes
  // Also support /v1/models/{model}:generateContent (some Gemini APIs use v1 instead of v1beta)
  if ((path.startsWith('/v1beta/models/') || path.startsWith('/v1/models/')) && (path.includes(':generateContent') || path.includes(':streamGenerateContent'))) {
    const modelMatch = path.match(/\/(v1beta|v1)\/models\/([^:?]+):(stream)?[Gg]enerateContent/);
    const modelId = modelMatch ? decodeURIComponent(modelMatch[2]) : 'gemini-no-id-at-proxy';
    const isStreamEndpoint = path.includes(':streamGenerateContent');
    
    if (defaultMode === 'gemini-generatecontent' || defaultMode === 'gemini-interactions') {
      // Native Gemini - pass through the exact endpoint
      const apiVersion = env.GEMINI_API_VERSION || 'v1beta';
      const endpoint = isStreamEndpoint ? 'streamGenerateContent' : 'generateContent';
      // Preserve query string if present, or add ?alt=sse for streamGenerateContent
      let queryString = path.includes('?') ? path.substring(path.indexOf('?')) : '';
      if (isStreamEndpoint && !queryString.includes('alt=sse')) {
        queryString = queryString ? `${queryString}&alt=sse` : '?alt=sse';
      }
      return {
        targetUrl: `${defaultBaseUrl}/${apiVersion}/models/${modelId}:${endpoint}${queryString}`,
        targetEndpoint: `v1beta/models/${endpoint}`,
        handlerType: 'generateContent',
        upstreamMode: defaultMode,
        modelId,
      };
    } else {
      // OpenAI-compatible upstream
      return {
        targetUrl: `${defaultBaseUrl}/v1/chat/completions`,
        targetEndpoint: 'v1beta/models/generateContent',
        handlerType: 'generateContent',
        upstreamMode: 'openai-completions',
        modelId,
        forceStreaming: isStreamEndpoint,
      };
    }
  }

  // 4. /v1/chat/completions — passthrough (when DEV_PASS_THROUGH is enabled)
  if (path === '/v1/chat/completions' || path.startsWith('/v1/chat/completions?')) {
    if (env.DEV_PASS_THROUGH === 'true' || env.DEV_PASS_THROUGH === '1') {
      return {
        targetUrl: `${defaultBaseUrl}/v1/chat/completions`,
        targetEndpoint: 'v1/chat/completions',
        handlerType: 'chat-completions' as const,
        upstreamMode: 'openai-completions',
      };
    }
    throw new Error('Direct access to /v1/chat/completions is not allowed. Use /v1/messages instead.');
  }

  // Token counting endpoint
  if (path === '/v1/messages/count_tokens' || path.startsWith('/v1/messages/count_tokens?')) {
    return {
      targetUrl: `${defaultBaseUrl}/v1/messages/count_tokens`,
      targetEndpoint: 'v1/messages/count_tokens',
      handlerType: 'token-counting',
    };
  }

  // 5. /v1/responses/input_tokens → count input tokens
  if (path === '/v1/responses/input_tokens' || path.startsWith('/v1/responses/input_tokens?')) {
    if (defaultMode === 'openai-responses') {
      return {
        targetUrl: `${defaultBaseUrl}/responses/input_tokens`,
        targetEndpoint: 'v1/responses/input_tokens',
        handlerType: 'responses-input-tokens',
        upstreamMode: 'openai-responses',
      };
    } else {
      return {
        targetUrl: `${defaultBaseUrl}/v1/chat/completions`,
        targetEndpoint: 'v1/responses/input_tokens',
        handlerType: 'responses-input-tokens',
        upstreamMode: 'openai-completions',
      };
    }
  }

  // 6. /v1/responses/compact → compact a conversation
  if (path === '/v1/responses/compact' || path.startsWith('/v1/responses/compact?')) {
    if (defaultMode === 'openai-responses') {
      return {
        targetUrl: `${defaultBaseUrl}/responses/compact`,
        targetEndpoint: 'v1/responses/compact',
        handlerType: 'responses-compact',
        upstreamMode: 'openai-responses',
      };
    } else {
      return {
        targetUrl: `${defaultBaseUrl}/v1/chat/completions`,
        targetEndpoint: 'v1/responses/compact',
        handlerType: 'responses-compact',
        upstreamMode: 'openai-completions',
      };
    }
  }

  // 6. /v1/responses → multiple upstream modes
  if (path === '/v1/responses' || path.startsWith('/v1/responses?')) {
    if (defaultMode === 'openai-responses') {
      // Pass through to OpenAI Responses API
      return {
        targetUrl: `${defaultBaseUrl}/responses`,
        targetEndpoint: 'v1/responses',
        handlerType: 'responses',
        upstreamMode: 'openai-responses',
      };
    } else {
      // Convert to OpenAI Chat Completions
      return {
        targetUrl: `${defaultBaseUrl}/v1/chat/completions`,
        targetEndpoint: 'v1/responses',
        handlerType: 'responses',
        upstreamMode: 'openai-completions',
      };
    }
  }

  // Models endpoint
  if (path === '/v1/models' || path.startsWith('/v1/models?')) {
    return {
      targetUrl: `${defaultBaseUrl}/v1/models`,
      targetEndpoint: 'v1/models',
      handlerType: 'models',
    };
  }

  // Embeddings endpoint — uses [models.embedding] config with priority over defaults
  if (path === '/v1/embeddings' || path.startsWith('/v1/embeddings?')) {
    const embeddingCategory = proxyConfig.models?.embedding;
    const embeddingConfig = embeddingCategory && !Array.isArray(embeddingCategory) ? embeddingCategory : undefined;
    const embeddingBaseUrl = embeddingConfig?.base_url || defaultBaseUrl;
    return {
      targetUrl: `${embeddingBaseUrl}/v1/embeddings`,
      targetEndpoint: 'v1/embeddings',
      handlerType: 'embeddings',
      upstreamMode: 'openai-completions',
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
    const url = new URL(request.url);
    const path = url.pathname;

    // Load proxy config on first request
    const configPath = env.PROXY_CONFIG_PATH;
    const configUrl = env.PROXY_CONFIG_URL;

    if (path === '/config-reload') {
      logger.debug(requestId, `${path} Config path: ${configPath}, Config URL: ${configUrl}`);
      try {
        if (!env.PROXY_CONFIG_URL) {
          throw new Error('proxy config url is not set.');
        }

        clearProxyConfigCache();
        const proxyConfig = await loadProxyConfig(env);
        dumpProxyConfigToml(proxyConfig);

        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        return new Response(JSON.stringify({
          status: 'failed',
          error: (error as Error).message,
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const proxyConfig = await loadProxyConfig(env);
    const configuredModelIds = getConfiguredModelIds(proxyConfig);
    let failedModelId: string | undefined;
    let modelFailureRecorded = false;
    let requestStartTime = 0;

    if (!hasLoggedUpstreamConfig && proxyConfig.upstream) {
      logger.debug(requestId, `Upstream config: \n\tbudget_to_effort_low=${proxyConfig.upstream.budget_to_effort_low}, \n\tbudget_to_effort_medium=${proxyConfig.upstream.budget_to_effort_medium}, \n\tbudget_to_effort_high=${proxyConfig.upstream.budget_to_effort_high}`);
      hasLoggedUpstreamConfig = true;
    }

    try {
      // Handle CORS preflight
      if (request.method === 'OPTIONS') {
        return handleOptionsRequest(request, env);
      }

      if (path === '/dashboard' && request.method === 'GET') {
        return applyCorsHeaders(handleDashboardPage(), request, env);
      }

      if (path === '/dashboard/api/config' && request.method === 'GET') {
        return applyCorsHeaders(handleDashboardGetConfig(proxyConfig, env), request, env);
      }

      if (path === '/dashboard/api/config' && request.method === 'PUT') {
        const response = await handleDashboardPutConfig(request, env, proxyConfig);
        return applyCorsHeaders(response, request, env);
      }

      if (path === '/dashboard/api/stats/models' && request.method === 'GET') {
        return applyCorsHeaders(handleDashboardModelStats(), request, env);
      }

      if (path === '/dashboard/api/stats/agents' && request.method === 'GET') {
        return applyCorsHeaders(handleDashboardAgentStats(), request, env);
      }

      if (path === '/dashboard/api/stats/requests' && request.method === 'GET') {
        return applyCorsHeaders(handleDashboardRequestStats(), request, env);
      }

      // Skip favicon requests
      if (path === '/favicon.ico') {
        return new Response(null, { status: 204 });
      }

      // Health check endpoint (also for root path)
      if (path === '/health' || path === '/') {
        const defaultCategory = proxyConfig.models?.default;
        const defaultCategoryConfig = defaultCategory && !Array.isArray(defaultCategory) ? defaultCategory : undefined;
        const healthBaseUrl = defaultCategoryConfig?.base_url ||
                             proxyConfig.upstream?.default_base_url ||
                             'https://api.qnaigc.com';
        const healthUrl = `${healthBaseUrl}/v1/models`;
        const healthAuth = extractAuthHeaders(request);

        try {
          const { count, cached } = await getModelCount(healthUrl, healthAuth, requestId, logger, env as unknown as Record<string, unknown>);
          if (count > 0) {
            return new Response(JSON.stringify({
              status: 'ok',
              models: count,
              cached,
              version: env.VERSION || 'unknown'
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        } catch {
          // Fall through to error
        }
        return new Response(JSON.stringify({
          error: 'No models Found.',
          version: env.VERSION || 'unknown'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      recordRequestEndpoint(path);
      requestStartTime = Date.now();

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

      let targetUrl: string = '';
      let handlerType: 'models' | 'token-counting' | 'messages' | 'interactions' | 'generateContent' | 'responses' | 'responses-compact' | 'responses-input-tokens' | 'embeddings' | 'chat-completions' = 'messages';
      let modelId: string | undefined;
      let upstreamMode: string | undefined;
      let forceStreaming: boolean = false;
      let isGeminiBypass = false;
      const userAgentPrefix = extractUserAgentPrefix(request.headers.get('user-agent'));
      let requestToolNames: string[] = ['none'];

      // Collect tool names from request body for all JSON endpoints (without consuming request body).
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
        try {
          const contentType = request.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            const bodyForToolStats = await request.clone().json() as Record<string, unknown>;
            requestToolNames = extractToolNamesFromBody(bodyForToolStats);
            recordToolRequestChars(extractToolRequestCharLengthsFromBody(bodyForToolStats));
          }
        } catch {
          // ignore parse failures for stats collection
        }
      }

      // Count Agent/Tool for all incoming requests (including failures later in routing/upstream).
      recordAgentStat(userAgentPrefix, requestToolNames);

      type RouteAttemptHandlerType = 'models' | 'token-counting' | 'messages' | 'interactions' | 'generateContent' | 'responses' | 'responses-compact' | 'responses-input-tokens' | 'embeddings' | 'chat-completions';
      type RouteAttempt = {
        request: Request;
        targetUrl: string;
        handlerType: RouteAttemptHandlerType;
        modelId?: string;
        upstreamMode?: string;
        forceStreaming: boolean;
        authHeaders: Record<string, string>;
      };
      let compositeAttempts: RouteAttempt[] | undefined;

      // Extract authentication headers early
      const authHeaders = extractAuthHeaders(request);
      let modelAuthHeaders = authHeaders;

      // For endpoints that need model-specific routing, extract model from request body
      if (path === '/v1/messages' || path.startsWith('/v1/messages?') ||
          path === '/v1/interactions' || path.startsWith('/v1/interactions?') ||
          path === '/v1/responses' || path.startsWith('/v1/responses?') ||
          path === '/v1/responses/compact' || path.startsWith('/v1/responses/compact?') ||
          path === '/v1/responses/input_tokens' || path.startsWith('/v1/responses/input_tokens?') ||
          ((path === '/v1/chat/completions' || path.startsWith('/v1/chat/completions?')) &&
           (env.DEV_PASS_THROUGH === 'true' || env.DEV_PASS_THROUGH === '1')) ||
          ((path.startsWith('/v1beta/models/') || path.startsWith('/v1/models/')) && (path.includes(':generateContent') || path.includes(':streamGenerateContent')))) {
        try {
          const bodyText = await request.text();
          const body = JSON.parse(bodyText);
          let modelName = body.model;
          
          // For generateContent endpoint, extract model from URL if not in body
          if (!modelName && (path.startsWith('/v1beta/models/') || path.startsWith('/v1/models/')) && (path.includes(':generateContent') || path.includes(':streamGenerateContent'))) {
            const modelMatch = path.match(/\/(v1beta|v1)\/models\/([^:?]+):(stream)?[Gg]enerateContent/);
            if (modelMatch) {
              modelName = decodeURIComponent(modelMatch[2]);
            }
          }

          // Passthrough for /v1/chat/completions: use fixed routing but extract model name for stats.
          // When passthrough is NOT enabled, skip routing vars entirely — the outer "else" block
          // (fixed routing) calls parseFixedRoute() which throws the block error.
          if (path === '/v1/chat/completions' || path.startsWith('/v1/chat/completions?')) {
            if (env.DEV_PASS_THROUGH === 'true' || env.DEV_PASS_THROUGH === '1') {
              const fixedRoute = parseFixedRoute(path, proxyConfig, env);
              targetUrl = fixedRoute.targetUrl;
              handlerType = fixedRoute.handlerType;
              upstreamMode = fixedRoute.upstreamMode;
              modelId = modelName; // Use extracted model name for dashboard stats
              forceStreaming = fixedRoute.forceStreaming || false;

              // Recreate request with original body (forwarded as-is, no conversion)
              request = new Request(request.url, {
                method: request.method,
                headers: request.headers,
                body: bodyText,
              });

              // Transform auth headers for openai-completions upstream
              modelAuthHeaders = transformAuthHeadersForUpstream(request, upstreamMode || 'openai-completions', path, requestId, env as Record<string, unknown>);
            }
            // passthrough disabled: don't set routing vars — falls through to outer fixed-routing block
          } else if (modelName && proxyConfig.models) {
            const compositeCandidates = getCompositeRouteCandidates(modelName, proxyConfig);

            // Token-limit enforcement: check accumulated total_tokens across all
            // alias targets against the alias-level total_token_limit.
            if (compositeCandidates.length > 0 && proxyConfig.composite?.[modelName]?.total_token_limit !== undefined) {
              const aliasLimit = proxyConfig.composite[modelName].total_token_limit!;
              const totalUsed = compositeCandidates.reduce(
                (sum, c) => sum + getModelTotalTokens(c.route.modelAlias || c.modelName),
                0,
              );
              logger.debug(requestId, `Composite alias ${modelName}: accumulated ${totalUsed} tokens across ${compositeCandidates.length} targets, limit ${aliasLimit}`);
              if (totalUsed >= aliasLimit) {
                logger.info(requestId, `Rejecting request for ${modelName}: ${totalUsed} accumulated tokens >= limit ${aliasLimit}`);
                throw new OverLimitError(
                  `Composite alias '${modelName}' token limit (${aliasLimit}) reached (${totalUsed}). No further requests will be routed through this alias.`
                );
              }
            }

            const routeCandidates: Array<{ modelName: string; route: ModelRouteConfig }> = compositeCandidates.length > 0
              ? compositeCandidates
              : [{ modelName, route: getModelRouteConfig(modelName, proxyConfig) }];

            // Get client connection info from headers (added by Node.js server adapter)
            const clientAddress = request.headers.get('x-client-address') || 'unknown';
            const clientPort = request.headers.get('x-client-port') || 'unknown';

            compositeAttempts = routeCandidates.map(({ modelName: candidateName, route }) => {
              logger.info(requestId, `${url.pathname} for ${modelName} (${candidateName}) to ${route.targetUrl} (${route.upstreamMode}) from ${clientAddress}:${clientPort}`);

              const upstreamModelName = route.modelAlias || candidateName;
              const forwardedBodyText = JSON.stringify({
                ...body,
                model: upstreamModelName,
              });

              const candidateRequest = new Request(request.url, {
                method: request.method,
                headers: request.headers,
                body: forwardedBodyText,
              });

              let candidateAuthHeaders = transformAuthHeadersForUpstream(candidateRequest, route.upstreamMode, path, requestId, env as Record<string, unknown>);

              if (route.upstreamMode === 'openai-completions') {
                if (route.modelAlias && route.apiKey) {
                  const configHeaders = formatApiKeyForUpstream(route.apiKey, route.upstreamMode);
                  candidateAuthHeaders = { ...candidateAuthHeaders, ...configHeaders };
                }
              } else if (route.apiKey) {
                const configHeaders = formatApiKeyForUpstream(route.apiKey, route.upstreamMode);
                candidateAuthHeaders = { ...candidateAuthHeaders, ...configHeaders };
              }

              const isNativeMode = route.upstreamMode === 'anthropic-messages' ||
                                  route.upstreamMode === 'gemini-generatecontent' ||
                                  route.upstreamMode === 'gemini-interactions';

              let candidateTargetUrl = '';
              let candidateHandlerType: RouteAttempt['handlerType'] = 'messages';
              let candidateUpstreamMode: string | undefined;
              let candidateForceStreaming = false;

              if (path === '/v1/messages' || path.startsWith('/v1/messages?')) {
                candidateHandlerType = 'messages';
                if (isNativeMode) {
                  const requestBody = JSON.parse(forwardedBodyText) as Record<string, unknown>;
                  const isStreaming = requestBody.stream === true;

                  if (route.upstreamMode === 'gemini-generatecontent' || route.upstreamMode === 'gemini-interactions') {
                    candidateTargetUrl = isStreaming
                      ? `${route.targetUrl}/v1beta/models/${upstreamModelName}:streamGenerateContent?alt=sse`
                      : `${route.targetUrl}/v1beta/models/${upstreamModelName}:generateContent`;
                  } else {
                    candidateTargetUrl = `${route.targetUrl}/v1/messages`;
                  }
                  candidateUpstreamMode = route.upstreamMode;
                } else {
                  candidateTargetUrl = `${route.targetUrl}/v1/chat/completions`;
                  candidateUpstreamMode = 'openai-completions';
                }
              } else if (path === '/v1/interactions' || path.startsWith('/v1/interactions?')) {
                candidateHandlerType = 'interactions';
                if (isNativeMode) {
                  if (route.upstreamMode === 'gemini-generatecontent' || route.upstreamMode === 'gemini-interactions') {
                    const requestBody = JSON.parse(forwardedBodyText) as Record<string, unknown>;
                    const isStreaming = requestBody.stream === true;
                    candidateTargetUrl = isStreaming
                      ? `${route.targetUrl}/v1beta/models/${upstreamModelName}:streamGenerateContent?alt=sse`
                      : `${route.targetUrl}/v1beta/models/${upstreamModelName}:generateContent`;
                    candidateUpstreamMode = route.upstreamMode;
                  } else {
                    candidateTargetUrl = `${route.targetUrl}/v1/chat/completions`;
                    candidateUpstreamMode = 'openai-completions';
                  }
                } else {
                  candidateTargetUrl = `${route.targetUrl}/v1/chat/completions`;
                  candidateUpstreamMode = 'openai-completions';
                }
              } else if ((path.startsWith('/v1beta/models/') || path.startsWith('/v1/models/')) && (path.includes(':generateContent') || path.includes(':streamGenerateContent'))) {
                candidateHandlerType = 'generateContent';
                const isStreamEndpoint = path.includes(':streamGenerateContent');
                if (isNativeMode) {
                  if (route.upstreamMode === 'gemini-generatecontent' || route.upstreamMode === 'gemini-interactions') {
                    const endpoint = isStreamEndpoint ? 'streamGenerateContent' : 'generateContent';
                    let queryString = path.includes('?') ? path.substring(path.indexOf('?')) : '';
                    if (isStreamEndpoint && !queryString.includes('alt=sse')) {
                      queryString = queryString ? `${queryString}&alt=sse` : '?alt=sse';
                    }
                    candidateTargetUrl = `${route.targetUrl}/v1beta/models/${upstreamModelName}:${endpoint}${queryString}`;
                    candidateUpstreamMode = route.upstreamMode;
                  } else {
                    candidateTargetUrl = `${route.targetUrl}/v1/chat/completions`;
                    candidateUpstreamMode = 'openai-completions';
                    candidateForceStreaming = isStreamEndpoint;
                  }
                } else {
                  candidateTargetUrl = `${route.targetUrl}/v1/chat/completions`;
                  candidateUpstreamMode = 'openai-completions';
                  candidateForceStreaming = isStreamEndpoint;
                }
              } else if (path === '/v1/responses' || path.startsWith('/v1/responses?')) {
                candidateHandlerType = 'responses';
                if (route.upstreamMode === 'openai-responses') {
                  candidateTargetUrl = `${route.targetUrl}/v1/responses`;
                  candidateUpstreamMode = 'openai-responses';
                } else {
                  candidateTargetUrl = `${route.targetUrl}/v1/chat/completions`;
                  candidateUpstreamMode = 'openai-completions';
                }
              } else if (path === '/v1/responses/input_tokens' || path.startsWith('/v1/responses/input_tokens?')) {
                candidateHandlerType = 'responses-input-tokens';
                if (route.upstreamMode === 'openai-responses') {
                  candidateTargetUrl = `${route.targetUrl}/v1/responses/input_tokens`;
                  candidateUpstreamMode = 'openai-responses';
                } else {
                  candidateTargetUrl = `${route.targetUrl}/v1/chat/completions`;
                  candidateUpstreamMode = 'openai-completions';
                }
              } else if (path === '/v1/responses/compact' || path.startsWith('/v1/responses/compact?')) {
                candidateHandlerType = 'responses-compact';
                if (route.upstreamMode === 'openai-responses') {
                  candidateTargetUrl = `${route.targetUrl}/v1/responses/compact`;
                  candidateUpstreamMode = 'openai-responses';
                } else {
                  candidateTargetUrl = `${route.targetUrl}/v1/chat/completions`;
                  candidateUpstreamMode = 'openai-completions';
                }
              }

              return {
                request: candidateRequest,
                targetUrl: candidateTargetUrl,
                handlerType: candidateHandlerType,
                modelId: upstreamModelName,
                upstreamMode: candidateUpstreamMode,
                forceStreaming: candidateForceStreaming,
                authHeaders: candidateAuthHeaders,
              };
            });

            const firstAttempt = compositeAttempts[0];
            targetUrl = firstAttempt.targetUrl;
            handlerType = firstAttempt.handlerType;
            modelId = firstAttempt.modelId;
            upstreamMode = firstAttempt.upstreamMode;
            forceStreaming = firstAttempt.forceStreaming;
            modelAuthHeaders = firstAttempt.authHeaders;
            request = firstAttempt.request;

            logger.debug(requestId, `Model-specific routing: ${modelName} -> ${targetUrl} (${upstreamMode}) [${handlerType}]`);
          } else {
            // No model-specific config, use default routing
            const fixedRoute = parseFixedRoute(path, proxyConfig, env);
            targetUrl = fixedRoute.targetUrl;
            handlerType = fixedRoute.handlerType;
            upstreamMode = fixedRoute.upstreamMode;
            modelId = fixedRoute.modelId;
            forceStreaming = fixedRoute.forceStreaming || false;
            
            // Recreate request with body
            request = new Request(request.url, {
              method: request.method,
              headers: request.headers,
              body: bodyText,
            });
          }
        } catch (error) {
          logger.error(requestId, `Failed to parse request body for model routing ${path}: ${(error as Error).message}`);
          return createErrorResponse(new Error('Invalid request body'), requestId, 400);
        }
      } else if (isDynamicRoute(path)) {
        logger.error(requestId, `No dynamic routing: ${path}`);
        return createErrorResponse(new Error('No Routing.'), requestId, 400);
      } else {
        // Fixed routing: /v1/messages -> /v1/chat/completions
        const fixedRoute = parseFixedRoute(path, proxyConfig, env);
        targetUrl = fixedRoute.targetUrl;
        handlerType = fixedRoute.handlerType;
        upstreamMode = fixedRoute.upstreamMode;
        modelId = fixedRoute.modelId;
        
        // Transform auth headers for fixed route based on upstream mode and endpoint
        if (upstreamMode) {
          modelAuthHeaders = transformAuthHeadersForUpstream(request, upstreamMode, path, requestId, env as Record<string, unknown>);

          // Debug log: show auth header keys and partial values for fixed routing
          const authKeys = Object.keys(modelAuthHeaders);
          if (authKeys.length > 0) {
            authKeys.forEach(key => {
              const value = modelAuthHeaders[key];
              const partialValue = value.length > 8 ? `${value.substring(0, 4)}...${value.substring(value.length - 4)}` : '***';
              logger.debug(requestId, `Auth header for fixed routing ${upstreamMode}: ${key}=${partialValue}`);
            });
          } else {
            logger.debug(requestId, `No auth headers found for fixed routing ${upstreamMode}`);
          }

          // For openai-completions upstream in fixed routing, always use client headers
          // Config API keys should NOT override client headers for openai-completions upstream
          if (upstreamMode === 'openai-completions') {
            // Always use transformed client headers for openai-completions upstream
            // Do NOT use config API key even if present
            logger.debug(requestId, `Using client API key for openai-completions upstream in fixed routing`);
          }
        }

        // Embeddings endpoint: apply [models.embedding] api_key if configured
        if (path === '/v1/embeddings' || path.startsWith('/v1/embeddings?')) {
          const embeddingCategory = proxyConfig.models?.embedding;
          const embeddingConfig = embeddingCategory && !Array.isArray(embeddingCategory) ? embeddingCategory : undefined;
          const embeddingApiKey = embeddingConfig?.api_key;
          if (embeddingApiKey) {
            modelAuthHeaders = {
              ...modelAuthHeaders,
              ...formatApiKeyForUpstream(embeddingApiKey, upstreamMode || 'openai-completions'),
            };
            logger.debug(requestId, `Applied [models.embedding] api_key for embeddings request`);
          }
        }
      }

      const runAttempt = async (attempt: RouteAttempt): Promise<Response> => {
        const attemptRequest = attempt.request;
        const attemptTargetUrl = attempt.targetUrl;
        const attemptHandlerType = attempt.handlerType;
        const attemptModelId = attempt.modelId;
        const attemptUpstreamMode = attempt.upstreamMode;
        const attemptForceStreaming = attempt.forceStreaming;
        const attemptAuthHeaders = attempt.authHeaders;

        // Route to appropriate handler
        let response: Response;
        switch (attemptHandlerType) {
          case 'models':
            response = await handleModelsRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, logger, env as unknown as Record<string, unknown>, configuredModelIds);
            break;

          case 'token-counting':
            response = await handleTokenCountingRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, env, logger);
            break;

          case 'messages':
            if (attemptUpstreamMode === 'anthropic-messages') {
              response = await handleClaudeRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, attemptModelId, env, logger);
            } else if (attemptUpstreamMode === 'gemini-generatecontent' || attemptUpstreamMode === 'gemini-interactions') {
              response = await handleGeminiRequestForMessages(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, attemptModelId, env, logger);
            } else {
              const conversionOptions: ThinkingConversionOptions = {};
              const upstream = proxyConfig.upstream;
              const low = upstream?.budget_to_effort_low;
              if (low !== undefined && low !== '') {
                const val = parseInt(String(low));
                if (!isNaN(val)) conversionOptions.budget_to_effort_low = val;
              }
              const medium = upstream?.budget_to_effort_medium;
              if (medium !== undefined && medium !== '') {
                const val = parseInt(String(medium));
                if (!isNaN(val)) conversionOptions.budget_to_effort_medium = val;
              }
              const high = upstream?.budget_to_effort_high;
              if (high !== undefined && high !== '') {
                const val = parseInt(String(high));
                if (!isNaN(val)) conversionOptions.budget_to_effort_high = val;
              }
              response = await handleMessagesRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, attemptModelId, env, logger, conversionOptions, attemptUpstreamMode);
            }
            break;

          case 'interactions':
            if (attemptUpstreamMode === 'gemini-generatecontent' || attemptUpstreamMode === 'gemini-interactions') {
              response = await handleGeminiRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, attemptModelId, env, logger);
            } else {
              response = await handleOpenAIRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, attemptModelId, env, logger, attemptForceStreaming);
            }
            break;

          case 'generateContent':
            if (attemptUpstreamMode === 'gemini-generatecontent' || attemptUpstreamMode === 'gemini-interactions') {
              response = await handleGeminiRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, attemptModelId, env, logger);
            } else {
              response = await handleOpenAIRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, attemptModelId, env, logger, attemptForceStreaming);
            }
            break;

          case 'responses':
            response = await handleResponsesRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, attemptModelId, env, logger, attemptUpstreamMode);
            break;

          case 'responses-input-tokens':
            response = await handleResponsesInputTokensRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, attemptModelId, env, logger, attemptUpstreamMode);
            break;

          case 'responses-compact':
            response = await handleResponsesCompactRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, attemptModelId, env, logger, attemptUpstreamMode);
            break;

          case 'chat-completions':
            response = await handleChatCompletionsPassthrough(
              attemptRequest, attemptTargetUrl, attemptAuthHeaders,
              requestId, logger, env, attemptModelId
            );
            break;

          case 'embeddings':
            response = await handleEmbeddingsRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, logger, env);
            break;

          default:
            throw new Error(`Unsupported handler type: ${attemptHandlerType}`);
        }

        if (attemptModelId) {
          if (response.status >= 400) {
            recordModelFailedRequest(attemptModelId);
          } else {
            recordModelStat(attemptModelId);
          }
        }
        recordResponseUpstream(attemptTargetUrl);
        recordResponseStatusCodeToEndpoint(response.status);

        if (response.ok && attemptModelId) {
          const contentType = response.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            try {
              const responseForStats = response.clone();
              const payload = await responseForStats.json();
              const usage = extractUsageFromResponsePayload(payload);
              if (usage) {
                recordModelUsage(attemptModelId, usage);
              }
              const toolNames = extractToolNamesFromResponsePayload(payload);
              recordUpstreamResponseToolNames(toolNames);
            } catch {
              // ignore stats extraction failures
            }
          } else if (contentType.includes('text/event-stream')) {
            // For streaming responses, intercept the SSE stream to capture token usage
            // from Claude SSE events (message_start.usage.input_tokens,
            // message_delta.usage.output_tokens)
            const usageStream = createUsageTrackingTransformStream(attemptModelId);
            const toolStream = createResponseToolTrackingTransformStream(recordUpstreamResponseToolNames);
            response = new Response(response.body!.pipeThrough(usageStream).pipeThrough(toolStream), response);
          }
        }

        return response;
      };

      if (compositeAttempts && compositeAttempts.length > 0) {
        let lastError: unknown;
        for (let i = 0; i < compositeAttempts.length; i++) {
          const attempt = compositeAttempts[i];
          try {
            const response = await runAttempt(attempt);
            recordRequestTiming(path, Date.now() - requestStartTime);
            return applyCorsHeaders(response, attempt.request, env);
          } catch (error) {
            lastError = error;
            if (attempt.modelId) {
              failedModelId = attempt.modelId;
              recordModelFailedRequest(attempt.modelId);
              modelFailureRecorded = true;
            }
            if (i < compositeAttempts.length - 1) {
              logger.warn(requestId, `Composite attempt ${i + 1}/${compositeAttempts.length} failed for model=${attempt.modelId}: ${(error as Error).message}; retrying next candidate`);
            }
          }
        }
        throw (lastError as Error);
      }

      failedModelId = modelId;
      const response = await runAttempt({
        request,
        targetUrl,
        handlerType,
        modelId,
        upstreamMode,
        forceStreaming,
        authHeaders: modelAuthHeaders,
      });

      // Apply CORS headers
      recordRequestTiming(path, Date.now() - requestStartTime);
      return applyCorsHeaders(response, request, env);

    } catch (error) {
      // Handle errors with Claude API format (without exposing sensitive info)
      if (!modelFailureRecorded && failedModelId) {
        recordModelFailedRequest(failedModelId);
      }
      logger.error(requestId, `Error: ${(error as Error).message}`);
      recordRequestTiming(path, Date.now() - requestStartTime);
      return createErrorResponse(error as Error, requestId);
    }
  },
};
