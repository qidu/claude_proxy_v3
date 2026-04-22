/**
 * Main router and middleware for Claude Proxy v3
 *
 * Handles dynamic routing to target APIs and converts between Claude and OpenAI formats.
 * Also supports Gemini API bypass mode for direct Gemini API access.
 */

import { Env } from './types/shared.js';
import { parseDynamicRoute, getHandlerType, buildTargetUrl, extractAuthHeaders, transformAuthHeadersForUpstream, isHostAllowed, formatApiKeyForUpstream } from './utils/routing.js';
import { createErrorResponse } from './utils/errors.js';
import { createLogger } from './utils/logger.js';
import { handleModelsRequest, getModelCount } from './handlers/models.js';
import { handleTokenCountingRequest } from './handlers/token-counting.js';
import { handleMessagesRequest } from './handlers/messages.js';
import { handleResponsesRequest, handleResponsesCompactRequest, handleResponsesInputTokensRequest } from './handlers/responses.js';
import { handleGeminiRequest, handleGeminiRequestForMessages } from './handlers/gemini.js';
import { handleOpenAIRequest } from './handlers/openai.js';
import { handleClaudeRequest } from './handlers/claude.js';
import { loadProxyConfig, clearProxyConfigCache, dumpProxyConfigToml, getConfiguredModelIds, getModelRouteConfig, ProxyConfig } from './utils/config-loader.js';
import { ThinkingConversionOptions } from './converters/claude-to-openai.js';

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
  const allowedList = (allowedOrigins as string).split(',').map((o: string) => o.trim());

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
 * Uses [models.default] and [upstream] from proxy_config.toml
 */
function parseFixedRoute(path: string, proxyConfig: ProxyConfig, env: Env): {
  targetUrl: string;
  targetEndpoint: string;
  handlerType: 'messages' | 'interactions' | 'generateContent' | 'models' | 'token-counting' | 'responses' | 'responses-compact' | 'responses-input-tokens';
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

  // 4. Block /v1/chat/completions - DO NOT process
  if (path === '/v1/chat/completions' || path.startsWith('/v1/chat/completions?')) {
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
    logger.debug(requestId, `Config path: ${configPath}, Config URL: ${configUrl}`);

    if (path === '/reload') {
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

    if (proxyConfig.upstream) {
      logger.debug(requestId, `Upstream config: budget_to_effort_low=${proxyConfig.upstream.budget_to_effort_low}, \n\tbudget_to_effort_medium=${proxyConfig.upstream.budget_to_effort_medium}, \n\tbudget_to_effort_high=${proxyConfig.upstream.budget_to_effort_high}`);
    }

    try {
      // Handle CORS preflight
      if (request.method === 'OPTIONS') {
        return handleOptionsRequest(request, env);
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
      let handlerType: 'models' | 'token-counting' | 'messages' | 'interactions' | 'generateContent' | 'responses' | 'responses-compact' | 'responses-input-tokens' = 'messages';
      let modelId: string | undefined;
      let upstreamMode: string | undefined;
      let forceStreaming: boolean = false;
      let isGeminiBypass = false;
      
      // Extract authentication headers early
      const authHeaders = extractAuthHeaders(request);
      let modelAuthHeaders = authHeaders;

      // For endpoints that need model-specific routing, extract model from request body
      if (path === '/v1/messages' || path.startsWith('/v1/messages?') ||
          path === '/v1/interactions' || path.startsWith('/v1/interactions?') ||
          path === '/v1/responses' || path.startsWith('/v1/responses?') ||
          path === '/v1/responses/compact' || path.startsWith('/v1/responses/compact?') ||
          path === '/v1/responses/input_tokens' || path.startsWith('/v1/responses/input_tokens?') ||
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
          
          if (modelName && proxyConfig.models) {
            // Get model-specific routing config
            const modelRoute = getModelRouteConfig(modelName, proxyConfig, env);
            
            // Get client connection info from headers (added by Node.js server adapter)
            const clientAddress = request.headers.get('x-client-address') || 'unknown';
            const clientPort = request.headers.get('x-client-port') || 'unknown';
            
            logger.info(requestId, `Model: ${modelName}, Mode: ${modelRoute.upstreamMode}, TargetURL: ${modelRoute.targetUrl}, Endpoint: ${url.pathname}, Client: ${clientAddress}:${clientPort}`);
            
            // Use model alias if configured, otherwise use original model name
            const upstreamModelName = modelRoute.modelAlias || modelName;
            
            // Transform auth headers based on upstream mode and endpoint
            // Extract API key from request headers and format correctly for the target upstream
            modelAuthHeaders = transformAuthHeadersForUpstream(request, modelRoute.upstreamMode, path, requestId, env as Record<string, unknown>);

            // Debug log: show auth header keys and partial values
            const authKeys = Object.keys(modelAuthHeaders);
            if (authKeys.length > 0) {
              authKeys.forEach(key => {
                const value = modelAuthHeaders[key];
                const partialValue = value.length > 8 ? `${value.substring(0, 4)}...${value.substring(value.length - 4)}` : '***';
                logger.debug(requestId, `Auth header for ${modelRoute.upstreamMode}: ${key}=${partialValue}`);
              });
            } else {
              logger.debug(requestId, `No auth headers found for ${modelRoute.upstreamMode}`);
            }

            // For openai-completions upstream:
            // - If model has an alias AND config has api_key, use config api_key first
            // - Otherwise, use client headers (transformed from x-goog-api-key or x-api-key)
            if (modelRoute.upstreamMode === 'openai-completions') {
                if (modelRoute.modelAlias && modelRoute.apiKey) {
                    // Model has alias and config has api_key - use config api_key first
                    const configHeaders = formatApiKeyForUpstream(modelRoute.apiKey, modelRoute.upstreamMode);
                    modelAuthHeaders = { ...modelAuthHeaders, ...configHeaders };
                    logger.debug(requestId, `Using API key from config for model with alias: ${modelName}`);

                    // Debug log: show auth header keys and partial values after config override
                    const authKeysAfterConfig = Object.keys(modelAuthHeaders);
                    if (authKeysAfterConfig.length > 0) {
                      authKeysAfterConfig.forEach(key => {
                        const value = modelAuthHeaders[key];
                        const partialValue = value.length > 8 ? `${value.substring(0, 4)}...${value.substring(value.length - 4)}` : '***';
                        logger.debug(requestId, `Auth header after config override for ${modelRoute.upstreamMode}: ${key}=${partialValue}`);
                      });
                    }
                } else {
                    // Use transformed client headers for openai-completions upstream
                    logger.debug(requestId, `Using client API key for openai-completions upstream: ${modelName}`);
                }
            } else if (modelRoute.apiKey) {
                // For native upstream modes (anthropic-messages, gemini-generatecontent, gemini-interactions),
                // config API key overrides request headers
                const configHeaders = formatApiKeyForUpstream(modelRoute.apiKey, modelRoute.upstreamMode);
                // Merge config headers (overriding any from request)
                modelAuthHeaders = { ...modelAuthHeaders, ...configHeaders };
                logger.debug(requestId, `Using API key from config for model: ${modelName}`);

                // Debug log: show auth header keys and partial values after config override
                const authKeysAfterConfig = Object.keys(modelAuthHeaders);
                if (authKeysAfterConfig.length > 0) {
                  authKeysAfterConfig.forEach(key => {
                    const value = modelAuthHeaders[key];
                    const partialValue = value.length > 8 ? `${value.substring(0, 4)}...${value.substring(value.length - 4)}` : '***';
                    logger.debug(requestId, `Auth header after config override for ${modelRoute.upstreamMode}: ${key}=${partialValue}`);
                  });
                }
            }
            
            // Determine handler type and build target URL based on endpoint and upstream_mode
            const isNativeMode = modelRoute.upstreamMode === 'anthropic-messages' || 
                                modelRoute.upstreamMode === 'gemini-generatecontent' || 
                                modelRoute.upstreamMode === 'gemini-interactions';
            
            if (path === '/v1/messages' || path.startsWith('/v1/messages?')) {
              handlerType = 'messages';
              if (isNativeMode) {
                // Check if streaming is requested
                const requestBody = JSON.parse(bodyText) as Record<string, unknown>;
                const isStreaming = requestBody.stream === true;
                
                if (modelRoute.upstreamMode === 'gemini-generatecontent' || modelRoute.upstreamMode === 'gemini-interactions') {
                  // For Gemini native, route to generateContent endpoints
                  if (isStreaming) {
                    targetUrl = `${modelRoute.targetUrl}/v1beta/models/${upstreamModelName}:streamGenerateContent?alt=sse`;
                  } else {
                    targetUrl = `${modelRoute.targetUrl}/v1beta/models/${upstreamModelName}:generateContent`;
                  }
                } else {
                  // For Claude native (anthropic-messages), route to /v1/messages
                  targetUrl = `${modelRoute.targetUrl}/v1/messages`;
                }
                upstreamMode = modelRoute.upstreamMode;
              } else {
                targetUrl = `${modelRoute.targetUrl}/v1/chat/completions`;
                upstreamMode = 'openai-completions';
              }
              logger.info(requestId, `Final targetUrl for /v1/messages: ${targetUrl}`);
            } else if (path === '/v1/interactions' || path.startsWith('/v1/interactions?')) {
              handlerType = 'interactions';
              if (isNativeMode) {
                // Check if this is a Gemini model (only Gemini supports interactions API natively)
                if (modelRoute.upstreamMode === 'gemini-generatecontent' || modelRoute.upstreamMode === 'gemini-interactions') {
                  // Native Gemini API - check if streaming is requested
                  const requestBody = JSON.parse(bodyText) as Record<string, unknown>;
                  const isStreaming = requestBody.stream === true;
                  
                  // Route to appropriate endpoint based on streaming
                  if (isStreaming) {
                    targetUrl = `${modelRoute.targetUrl}/v1beta/models/${upstreamModelName}:streamGenerateContent?alt=sse`;
                  } else {
                    targetUrl = `${modelRoute.targetUrl}/v1beta/models/${upstreamModelName}:generateContent`;
                  }
                  upstreamMode = modelRoute.upstreamMode;
                } else {
                  // Claude models don't support interactions API in native mode
                  // Fall back to OpenAI-compatible mode
                  targetUrl = `${modelRoute.targetUrl}/v1/chat/completions`;
                  upstreamMode = 'openai-completions';
                }
              } else {
                // OpenAI-compatible mode
                targetUrl = `${modelRoute.targetUrl}/v1/chat/completions`;
                upstreamMode = 'openai-completions';
              }
            } else if ((path.startsWith('/v1beta/models/') || path.startsWith('/v1/models/')) && (path.includes(':generateContent') || path.includes(':streamGenerateContent'))) {
              handlerType = 'generateContent';
              const isStreamEndpoint = path.includes(':streamGenerateContent');
              const modelMatch = path.match(/\/(v1beta|v1)\/models\/([^:?]+):(stream)?[Gg]enerateContent/);
              const pathModelId = modelMatch ? modelMatch[2] : upstreamModelName;

              if (isNativeMode) {
                // Check if this is a Gemini model (only Gemini supports generateContent API natively)
                if (modelRoute.upstreamMode === 'gemini-generatecontent' || modelRoute.upstreamMode === 'gemini-interactions') {
                  const endpoint = isStreamEndpoint ? 'streamGenerateContent' : 'generateContent';
                  // Preserve query string if present, or add ?alt=sse for streamGenerateContent
                  let queryString = path.includes('?') ? path.substring(path.indexOf('?')) : '';
                  if (isStreamEndpoint && !queryString.includes('alt=sse')) {
                    queryString = queryString ? `${queryString}&alt=sse` : '?alt=sse';
                  }
                  // Use upstreamModelName (alias) instead of pathModelId (client name)
                  targetUrl = `${modelRoute.targetUrl}/v1beta/models/${upstreamModelName}:${endpoint}${queryString}`;
                  upstreamMode = modelRoute.upstreamMode;
                } else {
                  // Claude models don't support generateContent API in native mode
                  // Fall back to OpenAI-compatible mode
                  targetUrl = `${modelRoute.targetUrl}/v1/chat/completions`;
                  upstreamMode = 'openai-completions';
                  forceStreaming = isStreamEndpoint;
                }
              } else {
                targetUrl = `${modelRoute.targetUrl}/v1/chat/completions`;
                upstreamMode = 'openai-completions';
                forceStreaming = isStreamEndpoint;
              }
            } else if (path === '/v1/responses' || path.startsWith('/v1/responses?')) {
              handlerType = 'responses';
              if (modelRoute.upstreamMode === 'openai-responses') {
                targetUrl = `${modelRoute.targetUrl}/v1/responses`;
                upstreamMode = 'openai-responses';
              } else {
                targetUrl = `${modelRoute.targetUrl}/v1/chat/completions`;
                upstreamMode = 'openai-completions';
              }
            } else if (path === '/v1/responses/input_tokens' || path.startsWith('/v1/responses/input_tokens?')) {
              handlerType = 'responses-input-tokens';
              if (modelRoute.upstreamMode === 'openai-responses') {
                targetUrl = `${modelRoute.targetUrl}/v1/responses/input_tokens`;
                upstreamMode = 'openai-responses';
              } else {
                targetUrl = `${modelRoute.targetUrl}/v1/chat/completions`;
                upstreamMode = 'openai-completions';
              }
            } else if (path === '/v1/responses/compact' || path.startsWith('/v1/responses/compact?')) {
              handlerType = 'responses-compact';
              if (modelRoute.upstreamMode === 'openai-responses') {
                targetUrl = `${modelRoute.targetUrl}/v1/responses/compact`;
                upstreamMode = 'openai-responses';
              } else {
                targetUrl = `${modelRoute.targetUrl}/v1/chat/completions`;
                upstreamMode = 'openai-completions';
              }
            }

            modelId = upstreamModelName;

            logger.debug(requestId, `Model-specific routing: ${modelName} -> ${targetUrl} (${modelRoute.upstreamMode}) [${handlerType}]`);
            
            // Recreate request with body
            request = new Request(request.url, {
              method: request.method,
              headers: request.headers,
              body: bodyText,
            });
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
        // Dynamic routing: /https/api.qnaigc.com/v1/messages
        const parsedRoute = parseDynamicRoute(path);
        const { targetConfig, claudeEndpoint } = parsedRoute;
        modelId = parsedRoute.modelId;

        // SSRF protection: validate host against whitelist
        const host = targetConfig.targetUrl.replace(/^https?:\/\//, '');
        if (!isHostAllowed(host, env.ALLOWED_HOSTS)) {
          logger.warn(requestId, `Host not allowed: ${host}. Allowed hosts: ${env.ALLOWED_HOSTS || '127.0.0.1, localhost'}`);
          return createErrorResponse(new Error('Host not allowed'), requestId, 403);
        }

        handlerType = getHandlerType(claudeEndpoint) as typeof handlerType;
        targetUrl = buildTargetUrl(targetConfig, claudeEndpoint, modelId);
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
      }

      // Route to appropriate handler
      let response: Response;
      switch (handlerType) {
        case 'models':
          response = await handleModelsRequest(request, targetUrl, modelAuthHeaders, requestId, logger, env as unknown as Record<string, unknown>, configuredModelIds);
          break;

        case 'token-counting':
          response = await handleTokenCountingRequest(request, targetUrl, modelAuthHeaders, requestId, env, logger);
          break;

        case 'messages':
          // /v1/messages routes based on upstream mode
          if (upstreamMode === 'anthropic-messages') {
            // Native Claude API
            response = await handleClaudeRequest(request, targetUrl, modelAuthHeaders, requestId, modelId, env, logger);
          } else if (upstreamMode === 'gemini-generatecontent' || upstreamMode === 'gemini-interactions') {
            // Native Gemini API (routed to generateContent endpoint)
            response = await handleGeminiRequestForMessages(request, targetUrl, modelAuthHeaders, requestId, modelId, env, logger);
          } else {
            // OpenAI-compatible mode
            // Build thinking conversion options from config
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
            response = await handleMessagesRequest(request, targetUrl, modelAuthHeaders, requestId, modelId, env, logger, conversionOptions, upstreamMode);
          }
          break;

        case 'interactions':
          // /v1/interactions routes based on upstream mode
          if (upstreamMode === 'gemini-generatecontent' || upstreamMode === 'gemini-interactions') {
            // Native Gemini API
            response = await handleGeminiRequest(request, targetUrl, modelAuthHeaders, requestId, modelId, env, logger);
          } else {
            // OpenAI-compatible mode
            response = await handleOpenAIRequest(request, targetUrl, modelAuthHeaders, requestId, modelId, env, logger, forceStreaming);
          }
          break;

        case 'generateContent':
          // /v1beta/models/{model}:generateContent or :streamGenerateContent routes based on upstream mode
          if (upstreamMode === 'gemini-generatecontent' || upstreamMode === 'gemini-interactions') {
            // Native Gemini API
            response = await handleGeminiRequest(request, targetUrl, modelAuthHeaders, requestId, modelId, env, logger);
          } else {
            // OpenAI-compatible mode
            response = await handleOpenAIRequest(request, targetUrl, modelAuthHeaders, requestId, modelId, env, logger, forceStreaming);
          }
          break;

        case 'responses':
          response = await handleResponsesRequest(request, targetUrl, modelAuthHeaders, requestId, modelId, env, logger, upstreamMode);
          break;

        case 'responses-input-tokens':
          response = await handleResponsesInputTokensRequest(request, targetUrl, modelAuthHeaders, requestId, modelId, env, logger, upstreamMode);
          break;

        case 'responses-compact':
          response = await handleResponsesCompactRequest(request, targetUrl, modelAuthHeaders, requestId, modelId, env, logger, upstreamMode);
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
