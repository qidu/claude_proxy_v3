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
  handleDashboardGlobalTokenLimit,
  handleDashboardModelStats,
  handleDashboardPage,
  handleDashboardPutConfig,
  handleDashboardRequestStats,
  handleDashboardTestModel,
} from './handlers/dashboard.js';
import { loadProxyConfig, clearProxyConfigCache, dumpProxyConfigToml, getConfiguredModelIds, getModelRouteConfig, getCompositeRouteCandidates, getCompositeAliasMode, resolveFusionPlan, FusionPlan, ModelRouteConfig, ProxyConfig, parseHumanTokenLimit } from './utils/config-loader.js';
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
  recordRequestEndpoint,
  recordRequestTiming,
  recordModelTiming,
  recordResponseStatusCodeFromUpstream,
  recordResponseStatusCodeToEndpoint,
  recordResponseUpstream,
  createUsageTrackingTransformStream,
  getCompositeAliasTokenUsage,
  recordCompositeTokenUsage,
  compositeLimitWindows,
  updateCompositeAliasReverseMap,
  setCompositeLimit,
  clearCompositeLimit,
  getWindowMs,
  incrementActiveRequests,
  decrementActiveRequests,
  getTokensInWindow,
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
    'Access-Control-Max-Age': '0',
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

  // 3a. /v1beta/models/{model}:countTokens → forward to Gemini upstream
  if ((path.startsWith('/v1beta/models/') || path.startsWith('/v1/models/')) && path.includes(':countTokens')) {
    const modelMatch = path.match(/\/(v1beta|v1)\/models\/([^:?]+):countTokens/);
    const modelId = modelMatch ? decodeURIComponent(modelMatch[2]) : 'gemini-no-id-at-proxy';
    const apiVersion = env.GEMINI_API_VERSION || 'v1beta';
    if (defaultMode === 'gemini-generatecontent' || defaultMode === 'gemini-interactions') {
      return {
        targetUrl: `${defaultBaseUrl}/${apiVersion}/models/${modelId}:countTokens`,
        targetEndpoint: 'v1beta/models/countTokens',
        handlerType: 'generateContent',
        upstreamMode: defaultMode,
        modelId,
      };
    } else {
      // countTokens has no OpenAI equivalent — proxy the request upstream as-is and return the raw JSON.
      // The handler will fall through to handleOpenAIRequest which passes the body through.
      return {
        targetUrl: `${defaultBaseUrl}/v1/messages/count_tokens`,
        targetEndpoint: 'v1beta/models/countTokens',
        handlerType: 'token-counting',
        upstreamMode: 'openai-completions',
        modelId,
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

    // Sync composite limit windows from config: update reverse map and init/clear windows
    const composite = proxyConfig.composite || {};
    updateCompositeAliasReverseMap(composite);
    // Add/reset windows for aliases with limits; remove windows for aliases without limits.
    // If a valid (non-expired) window was restored from the JSONL log, keep its accumulator
    // instead of resetting to 0 — this preserves token-limit state across restarts.
    for (const [alias, targets] of Object.entries(composite)) {
      if (targets.token_limit && typeof targets.token_limit === 'object') {
        const cfg = targets.token_limit;
        const existing = compositeLimitWindows.get(alias);
        const windowMs = getWindowMs(cfg.duration);
        if (existing && existing.windowStartMs + windowMs > Date.now()) {
          // Valid window restored from log — update limit/duration from config, keep accumulator
          existing.limit = cfg.num;
          existing.duration = cfg.duration;
        } else {
          setCompositeLimit(alias, cfg.num, cfg.duration);
        }
      } else {
        clearCompositeLimit(alias);
      }
    }
    // Clear windows for aliases that no longer exist in config
    for (const alias of compositeLimitWindows.keys()) {
      if (!(alias in composite)) {
        clearCompositeLimit(alias);
      }
    }

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
        let configForDashboard = proxyConfig;
        if (url.searchParams.get('reload') === '1') {
          clearProxyConfigCache();
          configForDashboard = await loadProxyConfig(env);
        }
        return applyCorsHeaders(handleDashboardGetConfig(configForDashboard, env), request, env);
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

      if (path === '/dashboard/api/test-model' && request.method === 'POST') {
        const response = await handleDashboardTestModel(request, env, proxyConfig);
        return applyCorsHeaders(response, request, env);
      }

      if (path === '/dashboard/api/global-token-limit' && request.method === 'POST') {
        const response = await handleDashboardGlobalTokenLimit(request, env);
        return applyCorsHeaders(response, request, env);
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

      // Global token limit check: only applies to model API requests, not dashboard/health
      const globalTokenLimitRaw = proxyConfig.upstream?.global_token_limit;
      if (globalTokenLimitRaw) {
        const parsedGlobal = parseHumanTokenLimit(globalTokenLimitRaw.trim());
        if (parsedGlobal && parsedGlobal.num > 0) {
          const windowMs = getWindowMs(parsedGlobal.duration);
          const windowTotal = getTokensInWindow(windowMs);
          if (windowTotal >= parsedGlobal.num) {
            throw new OverLimitError(
              `Global token limit (${parsedGlobal.num} ${parsedGlobal.duration}) reached (${windowTotal}). No further requests will be routed.`
            );
          }
        }
      }

      recordRequestEndpoint(path);
      requestStartTime = Date.now();
      incrementActiveRequests();

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
      let compositeAliasName: string | undefined;

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
          ((path.startsWith('/v1beta/models/') || path.startsWith('/v1/models/')) && (path.includes(':generateContent') || path.includes(':streamGenerateContent') || path.includes(':countTokens')))) {
        try {
          const bodyText = await request.text();
          const body = JSON.parse(bodyText);
          let modelName = body.model;

          // For generateContent/countTokens endpoint, extract model from URL if not in body
          if (!modelName && (path.startsWith('/v1beta/models/') || path.startsWith('/v1/models/')) && (path.includes(':generateContent') || path.includes(':streamGenerateContent') || path.includes(':countTokens'))) {
            const modelMatch = path.match(/\/(v1beta|v1)\/models\/([^:?]+):(stream)?(?:generateContent|streamGenerateContent|countTokens)/);
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
            // ---- Fusion mode: parallel fan-out → judge → synthesis ----
            if (getCompositeAliasMode(modelName, proxyConfig) === 'fusion') {
              const fusionPlan = resolveFusionPlan(modelName, proxyConfig);
              if (fusionPlan) {
                // token_limit check (covers all panel+judge+synth targets under the alias)
                if (proxyConfig.composite?.[modelName]?.token_limit !== undefined) {
                  const limitCfg = proxyConfig.composite[modelName].token_limit!;
                  const allTargets = [
                    ...fusionPlan.panel.map(p => p.route.modelAlias || p.modelName),
                    ...(fusionPlan.judge ? [fusionPlan.judge.route.modelAlias || fusionPlan.judge.modelName] : []),
                    fusionPlan.synth.route.modelAlias || fusionPlan.synth.modelName,
                  ];
                  const totalUsed = getCompositeAliasTokenUsage(modelName, allTargets);
                  if (totalUsed >= limitCfg.num) {
                    throw new OverLimitError(
                      `Composite alias '${modelName}' token limit (${limitCfg.num} ${limitCfg.duration}) reached (${totalUsed}).`
                    );
                  }
                }
                logger.info(requestId, `Fusion routing: ${modelName} → ${fusionPlan.panel.length} panel(s) + judge(${fusionPlan.judge?.modelName ?? 'none'}) + synth(${fusionPlan.synth.modelName})`);
                compositeAliasName = modelName;
                // runFusion is defined lower in this closure; call it after runAttempt is defined.
                // We set a sentinel so the compositeAttempts path is skipped.
                (request as any)._fusionPlan = fusionPlan;
                (request as any)._fusionBody = body;
                // Fall through with empty compositeAttempts — fusion is handled at dispatch time below
                compositeAttempts = [];
              }
            }

            if (!((request as any)._fusionPlan)) {
            const compositeCandidates = getCompositeRouteCandidates(modelName, proxyConfig);
            compositeAliasName = compositeCandidates.length > 0 ? modelName : undefined;

            // Token-limit enforcement: check tokens in the current duration window against the alias-level limit.
            if (compositeCandidates.length > 0 && proxyConfig.composite?.[modelName]?.token_limit !== undefined) {
              const limitCfg = proxyConfig.composite[modelName].token_limit!;
              const targetModels = compositeCandidates.map((c) => c.route.modelAlias || c.modelName);
              const totalUsed = getCompositeAliasTokenUsage(modelName, targetModels);
              logger.debug(requestId, `Composite alias ${modelName}: window tokens ${totalUsed} across ${compositeCandidates.length} targets, limit ${limitCfg.num} (${limitCfg.duration})`);
              if (totalUsed >= limitCfg.num) {
                logger.info(requestId, `Rejecting request for ${modelName}: ${totalUsed} window tokens >= limit ${limitCfg.num}`);
                throw new OverLimitError(
                  `Composite alias '${modelName}' token limit (${limitCfg.num} ${limitCfg.duration}) reached (${totalUsed}). No further requests will be routed through this alias.`
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
              logger.debug(requestId, `Composite candidate ${modelName} -> ${candidateName} via ${route.targetUrl} (${route.upstreamMode}) [client ${clientAddress}:${clientPort}]`);

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
              } else if ((path.startsWith('/v1beta/models/') || path.startsWith('/v1/models/')) && path.includes(':countTokens')) {
                candidateHandlerType = 'generateContent';
                if (route.upstreamMode === 'gemini-generatecontent' || route.upstreamMode === 'gemini-interactions') {
                  candidateTargetUrl = `${route.targetUrl}/v1beta/models/${upstreamModelName}:countTokens`;
                  candidateUpstreamMode = route.upstreamMode;
                } else {
                  candidateTargetUrl = `${route.targetUrl}/v1/messages/count_tokens`;
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
            } // end if (!fusionPlan)
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

      // Build a RouteAttempt for a given {modelName, route} pair and a body object.
      // Mirrors the inline logic in the compositeAttempts.map() block above.
      const buildRouteAttempt = (
        candidateName: string,
        route: ModelRouteConfig,
        bodyObj: Record<string, unknown>,
        forceStreamOverride?: boolean,
      ): RouteAttempt => {
        const upstreamModelName = route.modelAlias || candidateName;
        const forwardedBodyText = JSON.stringify({ ...bodyObj, model: upstreamModelName });
        const candidateRequest = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: forwardedBodyText,
        });

        let candidateAuthHeaders = transformAuthHeadersForUpstream(candidateRequest, route.upstreamMode, path, requestId, env as Record<string, unknown>);
        if (route.upstreamMode === 'openai-completions') {
          if (route.modelAlias && route.apiKey) {
            candidateAuthHeaders = { ...candidateAuthHeaders, ...formatApiKeyForUpstream(route.apiKey, route.upstreamMode) };
          }
        } else if (route.apiKey) {
          candidateAuthHeaders = { ...candidateAuthHeaders, ...formatApiKeyForUpstream(route.apiKey, route.upstreamMode) };
        }

        const isNativeMode = route.upstreamMode === 'anthropic-messages' ||
                             route.upstreamMode === 'gemini-generatecontent' ||
                             route.upstreamMode === 'gemini-interactions';

        let candidateTargetUrl = '';
        let candidateHandlerType: RouteAttempt['handlerType'] = 'messages';
        let candidateUpstreamMode: string | undefined;
        let candidateForceStreaming = forceStreamOverride ?? false;

        const bodyStream = (bodyObj.stream === true);

        if (path === '/v1/messages' || path.startsWith('/v1/messages?')) {
          candidateHandlerType = 'messages';
          if (isNativeMode) {
            if (route.upstreamMode === 'gemini-generatecontent' || route.upstreamMode === 'gemini-interactions') {
              candidateTargetUrl = bodyStream
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
          if (isNativeMode && (route.upstreamMode === 'gemini-generatecontent' || route.upstreamMode === 'gemini-interactions')) {
            candidateTargetUrl = bodyStream
              ? `${route.targetUrl}/v1beta/models/${upstreamModelName}:streamGenerateContent?alt=sse`
              : `${route.targetUrl}/v1beta/models/${upstreamModelName}:generateContent`;
            candidateUpstreamMode = route.upstreamMode;
          } else {
            candidateTargetUrl = `${route.targetUrl}/v1/chat/completions`;
            candidateUpstreamMode = 'openai-completions';
          }
        } else if ((path.startsWith('/v1beta/models/') || path.startsWith('/v1/models/')) && path.includes(':countTokens')) {
          candidateHandlerType = 'generateContent';
          if (route.upstreamMode === 'gemini-generatecontent' || route.upstreamMode === 'gemini-interactions') {
            candidateTargetUrl = `${route.targetUrl}/v1beta/models/${upstreamModelName}:countTokens`;
            candidateUpstreamMode = route.upstreamMode;
          } else {
            candidateTargetUrl = `${route.targetUrl}/v1/messages/count_tokens`;
            candidateUpstreamMode = 'openai-completions';
          }
        } else if ((path.startsWith('/v1beta/models/') || path.startsWith('/v1/models/')) && (path.includes(':generateContent') || path.includes(':streamGenerateContent'))) {
          candidateHandlerType = 'generateContent';
          const isStreamEndpoint = path.includes(':streamGenerateContent');
          if (isNativeMode && (route.upstreamMode === 'gemini-generatecontent' || route.upstreamMode === 'gemini-interactions')) {
            const endpoint = isStreamEndpoint ? 'streamGenerateContent' : 'generateContent';
            let queryString = path.includes('?') ? path.substring(path.indexOf('?')) : '';
            if (isStreamEndpoint && !queryString.includes('alt=sse')) { queryString = queryString ? `${queryString}&alt=sse` : '?alt=sse'; }
            candidateTargetUrl = `${route.targetUrl}/v1beta/models/${upstreamModelName}:${endpoint}${queryString}`;
            candidateUpstreamMode = route.upstreamMode;
          } else {
            candidateTargetUrl = `${route.targetUrl}/v1/chat/completions`;
            candidateUpstreamMode = 'openai-completions';
            candidateForceStreaming = forceStreamOverride ?? isStreamEndpoint;
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
      };

      // Extract the last user-turn text from the inbound body (Anthropic Messages format).
      // Used by runFusion to build judge/synthesis prompts.
      const extractUserPrompt = (bodyObj: Record<string, unknown>): string => {
        const msgs = bodyObj.messages;
        if (!Array.isArray(msgs) || msgs.length === 0) return '';
        // Walk backwards to find the last user message
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i] as Record<string, unknown>;
          if (m.role === 'user') {
            if (typeof m.content === 'string') return m.content;
            if (Array.isArray(m.content)) {
              return (m.content as Array<Record<string, unknown>>)
                .filter(b => b.type === 'text')
                .map(b => String(b.text ?? ''))
                .join('\n');
            }
          }
        }
        return '';
      };

      // Attempt to read the full JSON body from a (non-streaming) Response.
      const readResponseJson = async (resp: Response): Promise<Record<string, unknown> | null> => {
        try {
          const ct = resp.headers.get('content-type') || '';
          if (!ct.includes('application/json')) return null;
          return await resp.clone().json() as Record<string, unknown>;
        } catch { return null; }
      };

      // Extract text content from a Claude-format or OpenAI-format response payload.
      const extractResponseText = (payload: Record<string, unknown>): string => {
        // Anthropic Messages format
        if (Array.isArray(payload.content)) {
          return (payload.content as Array<Record<string, unknown>>)
            .filter(b => b.type === 'text')
            .map(b => String(b.text ?? ''))
            .join('\n');
        }
        // OpenAI completions format
        const choices = payload.choices as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(choices) && choices.length > 0) {
          const msg = choices[0].message as Record<string, unknown> | undefined;
          if (msg && typeof msg.content === 'string') return msg.content;
        }
        return '';
      };

      // ---- Fusion orchestrator ----
      const runFusion = async (plan: FusionPlan, bodyObj: Record<string, unknown>): Promise<Response> => {
        const { options } = plan;
        const fusionDepth = parseInt(request.headers.get('x-fusion-depth') || '0', 10);
        if (fusionDepth >= 1) {
          throw new Error(`fusion_invocation_capped: alias '${plan.alias}' cannot recursively invoke fusion`);
        }

        const userPrompt = extractUserPrompt(bodyObj);
        const panelErrors: Array<{ model: string; error: string }> = [];
        const panelTexts: Array<{ model: string; text: string }> = [];

        // ---- Stage 1: Panel fan-out (parallel, windowed by max_concurrent) ----
        const panelTargets = plan.panel;
        const batchSize = Math.max(1, Math.min(options.max_concurrent, panelTargets.length));

        for (let batchStart = 0; batchStart < panelTargets.length; batchStart += batchSize) {
          const batch = panelTargets.slice(batchStart, batchStart + batchSize);
          // Panel calls are always non-streaming so bodies can be buffered for aggregation
          const batchBodies = batch.map(t =>
            buildRouteAttempt(t.modelName, t.route, { ...bodyObj, stream: false })
          );
          // Attach fusion depth header to prevent recursive expansion.
          // Re-serialize body text (not stream) so Node.js fetch doesn't require duplex: 'half'.
          const batchTexts = await Promise.all(batchBodies.map(a => a.request.text()));
          const batchAttempts = batchBodies.map((a, i) => ({
            ...a,
            request: new Request(a.request.url, {
              method: a.request.method,
              headers: new Headers({ ...Object.fromEntries(a.request.headers.entries()), 'x-fusion-depth': '1' }),
              body: batchTexts[i],
            }),
          }));

          const timeoutMs = options.panel_timeout_ms;
          const settled = await Promise.allSettled(
            batchAttempts.map(a =>
              Promise.race([
                runAttempt(a),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error(`panel timeout after ${timeoutMs}ms`)), timeoutMs)
                ),
              ])
            )
          );

          for (let i = 0; i < batch.length; i++) {
            const result = settled[i];
            const modelName = batch[i].modelName;
            if (result.status === 'fulfilled') {
              const json = await readResponseJson(result.value);
              if (json) {
                const text = extractResponseText(json);
                if (text) {
                  panelTexts.push({ model: modelName, text });
                } else {
                  panelErrors.push({ model: modelName, error: 'empty response' });
                }
              } else {
                panelErrors.push({ model: modelName, error: 'non-JSON response' });
              }
            } else {
              panelErrors.push({ model: modelName, error: (result.reason as Error).message });
              logger.warn(requestId, `Fusion panel ${modelName} failed: ${(result.reason as Error).message}`);
            }
          }
        }

        if (panelTexts.length < options.min_panel) {
          const errorMsg = panelTexts.length === 0
            ? `all_panels_failed: no panel model returned a usable response (errors: ${panelErrors.map(e => `${e.model}: ${e.error}`).join('; ')})`
            : `insufficient_panels: only ${panelTexts.length}/${options.min_panel} required panels succeeded`;
          throw new Error(errorMsg);
        }

        logger.info(requestId, `Fusion panel complete: ${panelTexts.length} succeeded, ${panelErrors.length} failed`);

        // ---- Stage 2: Judge ----
        let analysis: Record<string, unknown> | null = null;
        if (plan.judge) {
          const panelSection = panelTexts
            .map(p => `--- MODEL: ${p.model} ---\n${p.text}`)
            .join('\n\n');
          const judgePromptText =
            `You are a meta-analyst comparing responses from multiple expert models.\n\n` +
            `ORIGINAL PROMPT:\n${userPrompt}\n\n` +
            `PANEL RESPONSES:\n${panelSection}\n\n` +
            `Produce ONLY valid JSON with these fields:\n` +
            `- consensus: string[] — points most/all models agree on\n` +
            `- contradictions: {topic:string, stances:{model:string,stance:string}[]}[]\n` +
            `- partial_coverage: {models:string[], point:string}[]\n` +
            `- unique_insights: {model:string, insight:string}[]\n` +
            `- blind_spots: string[] — angles no model addressed\n\n` +
            `Output ONLY the JSON object, no markdown fences.`;

          // Build judge body: replace messages with the judge prompt, always non-streaming
          const judgeMessages = [
            ...((bodyObj.messages as unknown[]) || []).slice(0, -1), // prior history minus last user turn
            { role: 'user', content: judgePromptText },
          ];
          const judgeBodyObj = { ...bodyObj, messages: judgeMessages, stream: false };

          const judgeAttempt = buildRouteAttempt(plan.judge.modelName, plan.judge.route, judgeBodyObj);
          const judgeBodyText = await judgeAttempt.request.text();
          const judgeAttemptWithDepth = {
            ...judgeAttempt,
            request: new Request(judgeAttempt.request.url, {
              method: judgeAttempt.request.method,
              headers: new Headers({ ...Object.fromEntries(judgeAttempt.request.headers.entries()), 'x-fusion-depth': '1' }),
              body: judgeBodyText,
            }),
          };

          try {
            const judgeResp = await runAttempt(judgeAttemptWithDepth);
            const judgeJson = await readResponseJson(judgeResp);
            if (judgeJson) {
              const judgeText = extractResponseText(judgeJson);
              // Strip optional markdown code fences
              const stripped = judgeText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
              analysis = JSON.parse(stripped) as Record<string, unknown>;
              logger.info(requestId, `Fusion judge complete for alias ${plan.alias}`);
            }
          } catch (e) {
            logger.warn(requestId, `Fusion judge failed: ${(e as Error).message}`);
            if (options.judge_required) {
              throw new Error(`judge_failed: ${(e as Error).message}`);
            }
            // degrade: analysis stays null, synthesis will use raw panel
          }
        }

        // ---- Stage 3: Synthesis ----
        let synthPromptText: string;
        if (analysis) {
          synthPromptText =
            `You are writing the final answer for the user.\n\n` +
            `ORIGINAL PROMPT: ${userPrompt}\n\n` +
            `STRUCTURED ANALYSIS FROM EXPERT PANEL:\n${JSON.stringify(analysis, null, 2)}\n\n` +
            `Instructions: Lead with consensus as the confident baseline. Present contradictions ` +
            `as nuanced disagreement with attribution. Include partial_coverage points with caveats. ` +
            `Highlight unique_insights as minority/expert perspectives. Explicitly address blind_spots. ` +
            `Write naturally — do not list the JSON fields.`;
        } else {
          // Degraded: no judge analysis; synthesise from raw panel responses
          const panelSection = panelTexts
            .map(p => `--- MODEL: ${p.model} ---\n${p.text}`)
            .join('\n\n');
          synthPromptText =
            `You are writing the final answer for the user.\n\n` +
            `ORIGINAL PROMPT: ${userPrompt}\n\n` +
            `PANEL RESPONSES (no structured analysis available):\n${panelSection}\n\n` +
            `Synthesise the above into a single coherent answer for the user.`;
        }

        const synthMessages = [
          ...((bodyObj.messages as unknown[]) || []).slice(0, -1),
          { role: 'user', content: synthPromptText },
        ];
        const synthBodyObj = { ...bodyObj, messages: synthMessages };
        // stream: pass through from the original request for the synth (client-visible) stage
        const synthAttempt = buildRouteAttempt(plan.synth.modelName, plan.synth.route, synthBodyObj);
        const synthBodyText = await synthAttempt.request.text();
        const synthAttemptWithDepth = {
          ...synthAttempt,
          request: new Request(synthAttempt.request.url, {
            method: synthAttempt.request.method,
            headers: new Headers({ ...Object.fromEntries(synthAttempt.request.headers.entries()), 'x-fusion-depth': '1' }),
            body: synthBodyText,
          }),
        };

        const synthResp = await runAttempt(synthAttemptWithDepth);

        // Attach fusion_metadata to non-streaming responses when expose_metadata is true
        if (options.expose_metadata && !bodyObj.stream) {
          const synthJson = await readResponseJson(synthResp);
          if (synthJson) {
            const metadata = {
              router: 'fusion',
              fusion_metadata: {
                alias: plan.alias,
                panel_models: plan.panel.map(p => p.modelName),
                judge_model: plan.judge?.modelName ?? null,
                synth_model: plan.synth.modelName,
                panel_errors: panelErrors,
                analysis_present: analysis !== null,
              },
            };
            const enriched = { ...synthJson, ...metadata };
            return new Response(JSON.stringify(enriched), {
              status: synthResp.status,
              headers: synthResp.headers,
            });
          }
        }

        return synthResp;
      };

      const runAttempt = async (attempt: RouteAttempt): Promise<Response> => {
        const attemptRequest = attempt.request;
        const attemptTargetUrl = attempt.targetUrl;
        const attemptHandlerType = attempt.handlerType;
        const attemptModelId = attempt.modelId;
        const attemptUpstreamMode = attempt.upstreamMode;
        const attemptForceStreaming = attempt.forceStreaming;
        const attemptAuthHeaders = attempt.authHeaders;

        // Debug log routing info for test model requests (LOG_LEVEL=debug)
        if (path === '/v1/messages' && env.LOG_LEVEL === 'debug') {
          try {
            const clonedBody = attemptRequest.clone();
            const bodyText = await clonedBody.text();
            const { writeFileSync } = await import('fs');
            writeFileSync('/tmp/test_model.log',
              `[${new Date().toISOString()}] proxy routing\n` +
              `path: ${path}\n` +
              `targetUrl: ${attemptTargetUrl}\n` +
              `upstreamMode: ${attemptUpstreamMode}\n` +
              `modelId: ${attemptModelId}\n` +
              `handlerType: ${attemptHandlerType}\n` +
              `authHeaders: ${JSON.stringify(Object.keys(attemptAuthHeaders))}\n` +
              `request body:\n${JSON.stringify(JSON.parse(bodyText), null, 2)}\n`,
            );
          } catch (_e) {
            try {
              const { writeFileSync } = await import('fs');
              writeFileSync('/tmp/test_model.log', `[${new Date().toISOString()}] proxy routing - failed to log request body: ${(_e as Error).message}\n`);
            } catch {}
          }
        }

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
          recordModelTiming(attemptModelId, Date.now() - requestStartTime);
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
                if (compositeAliasName && usage.total_tokens) {
                  recordCompositeTokenUsage(compositeAliasName, attemptModelId, usage.total_tokens);
                }
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
            const usageStream = createUsageTrackingTransformStream(attemptModelId, compositeAliasName);
            const toolStream = createResponseToolTrackingTransformStream(recordUpstreamResponseToolNames);
            response = new Response(response.body!.pipeThrough(usageStream).pipeThrough(toolStream), response);
          }
        }

        return response;
      };

      // ---- Fusion dispatch ----
      const _fusionPlan = (request as any)._fusionPlan as FusionPlan | undefined;
      const _fusionBody = (request as any)._fusionBody as Record<string, unknown> | undefined;
      if (_fusionPlan && _fusionBody) {
        const fusionResp = await runFusion(_fusionPlan, _fusionBody);
        recordRequestTiming(path, Date.now() - requestStartTime);
        return applyCorsHeaders(fusionResp, request, env);
      }

      if (compositeAttempts && compositeAttempts.length > 0) {
        let lastError: unknown;
        for (let i = 0; i < compositeAttempts.length; i++) {
          const attempt = compositeAttempts[i];
          try {
            logger.info(requestId, `${new URL(attempt.request.url).pathname} for ${compositeAliasName ?? attempt.modelId} to ${attempt.targetUrl} (${attempt.upstreamMode})`);
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
      recordModelTiming(failedModelId, Date.now() - requestStartTime);
      return createErrorResponse(error as Error, requestId);
    } finally {
      decrementActiveRequests();
    }
  },
};
