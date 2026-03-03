/**
 * Dynamic routing utility for Claude Proxy v3
 *
 * Handles URL patterns like:
 * - /v1/models (Models API)
 * - /https/api.qnaigc.com/v1/models (Models API)
 * - /https/api.qnaigc.com/openai/v1/models/deepseek-v3.1/v1/messages/count_tokens (Token Counting API)
 * - /https/api.qnaigc.com/openai/v1/models/deepseek-v3.1/v1/messages (Messages API)
 */

import { validateBetaFeatures } from './beta-features.js';

import { validateBetaFeatures as validateBetaFeaturesUtil } from './beta-features.js';
import { createLogger } from './logger.js';

export { parseDynamicRoute, getHandlerType, buildTargetUrl, extractAuthHeaders, transformAuthHeadersForUpstream, isHostAllowed, getAllowedHosts, formatApiKeyForUpstream };

// Default allowed hosts for SSRF protection
const DEFAULT_ALLOWED_HOSTS = ['127.0.0.1', 'localhost'];

export interface TargetConfig {
  targetUrl: string;
  targetPathPrefix: string;
}

export interface ParsedRoute {
  targetConfig: TargetConfig;
  claudeEndpoint: string;
  modelId?: string;
}

/**
 * Validate if a host is allowed based on the ALLOWED_HOSTS environment variable
 */
function isHostAllowed(host: string, allowedHostsEnv?: string): boolean {
  const allowedHosts = allowedHostsEnv
    ? allowedHostsEnv.split(',').map(h => h.trim().toLowerCase()).filter(h => h.length > 0)
    : DEFAULT_ALLOWED_HOSTS;

  const normalizedHost = host.toLowerCase();

  return allowedHosts.some(allowed => {
    // Exact match
    if (allowed === normalizedHost) {
      return true;
    }
    // Handle wildcard domain (e.g., "*.example.com")
    if (allowed.startsWith('*.')) {
      const domain = allowed.slice(2);
      return normalizedHost.endsWith(domain);
    }
    return false;
  });
}

/**
 * Get list of allowed hosts from environment or defaults
 */
function getAllowedHosts(allowedHostsEnv?: string): string[] {
  if (!allowedHostsEnv) {
    return DEFAULT_ALLOWED_HOSTS;
  }
  return allowedHostsEnv.split(',').map(h => h.trim()).filter(h => h.length > 0);
}

/**
 * Parse dynamic routing URL
 *
 * Expected format: /{claude_endpoint}
 * Expected format: /{protocol}{host}{path_prefix}/{model_id?}/{claude_endpoint}
 *
 * Examples:
 * - /v1/models
 * - /https/api.qnaigc.com/openai/v1/models
 * - /https/api.qnaigc.com/openai/v1/models/deepseek-v3.1/v1/messages
 * - /https/api.qnaigc.com/openai/v1/models/deepseek-v3.1/v1/messages/count_tokens
 */
function parseDynamicRoute(url: string): ParsedRoute {
  // Remove leading slash if present
  let path = url.startsWith('/') ? url.slice(1) : url;

  // Split by forward slashes
  const parts = path.split('/');

  if (parts.length < 4) {
    throw new Error(`Invalid URL format: ${url}. Expected format: /{protocol}{host}{path_prefix}/{model_id?}/{claude_endpoint}`);
  }

  // First part is the protocol (http or https)
  const protocol = parts[0];
  if (protocol !== 'http' && protocol !== 'https') {
    throw new Error(`Invalid protocol: ${protocol}. Must be 'http' or 'https'`);
  }

  // Second part is the host (e.g., api.qnaigc.com)
  let host = parts[1];

  // Find where the target API path ends and Claude endpoint begins
  // We look for known Claude endpoints: v1/models, v1/messages, v1/messages/count_tokens
  let targetPathEndIndex = -1;
  let claudeEndpointStartIndex = -1;

  // Look for Claude endpoint patterns from the end
  for (let i = parts.length - 1; i >= 2; i--) {
    if (parts[i] === 'v1' || parts[i] === 'v1beta') {
      // Check if this is a Claude endpoint
      const nextPart = i + 1 < parts.length ? parts[i + 1] : null;
      const twoPartsAhead = i + 2 < parts.length ? parts[i + 2] : null;

      if (nextPart === 'models' || nextPart === 'messages' || nextPart === 'interactions') {
        // Found a potential Claude endpoint
        targetPathEndIndex = i - 1;
        claudeEndpointStartIndex = i;
        break;
      }

      if (nextPart === 'messages' && twoPartsAhead === 'count_tokens') {
        // Found token counting endpoint
        targetPathEndIndex = i - 1;
        claudeEndpointStartIndex = i;
        break;
      }
    }
  }

  if (targetPathEndIndex === -1 || claudeEndpointStartIndex === -1) {
    throw new Error(`Could not locate Claude endpoint in URL: ${url}`);
  }

  // Extract Claude endpoint path
  const claudeEndpointPath = parts.slice(claudeEndpointStartIndex).join('/');

  // Determine if there's a model ID between target path and Claude endpoint
  let modelId: string | undefined;
  const betweenParts = parts.slice(targetPathEndIndex + 1, claudeEndpointStartIndex);
  if (betweenParts.length === 1) {
    // Likely a model ID
    modelId = betweenParts[0];
  } else if (betweenParts.length > 1) {
    // This might be part of the target path, adjust accordingly
    targetPathEndIndex = claudeEndpointStartIndex - 1;
    modelId = undefined;

    // Recalculate
    const newTargetPathPrefix = parts.slice(2, targetPathEndIndex + 1).join('/');
    throw new Error(`Unclear URL structure. Between target path '${newTargetPathPrefix}' and Claude endpoint '${claudeEndpointPath}' found: ${betweenParts.join('/')}`);
  } else if (betweenParts.length === 0) {
    // Check if the last element of target path prefix might be a model ID
    // Model IDs typically don't contain slashes and aren't common API path segments
    const targetPathParts = parts.slice(2, targetPathEndIndex + 1);
    if (targetPathParts.length > 0) {
      const lastPart = targetPathParts[targetPathParts.length - 1];
      // Check if last part looks like a model ID (not a common API path segment)
      const commonPathSegments = ['v1', 'v2', 'models', 'messages', 'completions', 'chat', 'openai', 'api'];
      if (!commonPathSegments.includes(lastPart) &&
          !lastPart.includes('/') &&
          lastPart.length > 0) {
        // This might be a model ID, extract it
        modelId = lastPart;
        // Adjust target path prefix to exclude the model ID
        targetPathEndIndex = targetPathEndIndex - 1;
      }
    }
  }

  // Recalculate target path prefix in case we adjusted for model ID
  const targetPathPrefix = parts.slice(2, targetPathEndIndex + 1).join('/');

  const targetConfig: TargetConfig = {
    targetUrl: `${protocol}://${host}`,
    targetPathPrefix: targetPathPrefix ? `/${targetPathPrefix}` : '',
  };

  return {
    targetConfig,
    claudeEndpoint: claudeEndpointPath,
    modelId,
  };
}

/**
 * Build target URL for API request
 */
function buildTargetUrl(targetConfig: TargetConfig, endpoint: string, modelId?: string): string {
  let url = `${targetConfig.targetUrl}${targetConfig.targetPathPrefix}`;

  if (modelId) {
    url += `/${modelId}`;
  }

  url += `/${endpoint}`;
  return url;
}

/**
 * Extract authentication headers from request
 *
 * Supports both Authorization and X-Api-Key headers.
 * If X-Api-Key is provided but Authorization is missing,
 * converts X-Api-Key to Authorization: Bearer format.
 */
function extractAuthHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};

  // Extract Authorization header
  let authHeader = request.headers.get('Authorization');

  // Extract API key headers
  const apiKeyHeader = request.headers.get('x-api-key');
  const googApiKeyHeader = request.headers.get('x-goog-api-key');

  // If X-Api-Key is provided but Authorization is missing, convert it
  if (apiKeyHeader && !authHeader) {
    // Check if X-Api-Key already has Bearer prefix
    if (apiKeyHeader.startsWith('Bearer ')) {
      headers['Authorization'] = apiKeyHeader;
    } else {
      headers['Authorization'] = `Bearer ${apiKeyHeader}`;
    }
  } else if (authHeader) {
    headers['Authorization'] = authHeader;
  }

  // If x-goog-api-key is provided, preserve it for Gemini native API
  if (googApiKeyHeader) {
    headers['x-goog-api-key'] = googApiKeyHeader;
  }

  // Forward beta feature headers
  const betaVersionHeader = request.headers.get('anthropic-beta');
  if (betaVersionHeader) {
    // Validate beta features
    const validatedFeatures = validateBetaFeaturesUtil(betaVersionHeader);
    if (validatedFeatures) {
      headers['anthropic-beta'] = JSON.stringify(validatedFeatures);
    } else {
      // Forward as-is if validation fails (should still work)
      headers['anthropic-beta'] = betaVersionHeader;
    }
  }

  return headers;
}

/**
 * Transform auth headers to match upstream mode requirements
 * Extracts API key from request headers and formats it correctly for the target upstream
 * Respects endpoint-specific header preferences
 */
function transformAuthHeadersForUpstream(
  request: Request,
  upstreamMode: string,
  endpointPath?: string,
  requestId?: string
): Record<string, string> {
  const headers: Record<string, string> = {};

  // Extract raw API key from headers with endpoint-specific priority
  let apiKey: string | null = null;

  const googApiKey = request.headers.get('x-goog-api-key');
  const xApiKey = request.headers.get('x-api-key');
  const authHeader = request.headers.get('Authorization');

  // Debug logging for header extraction
  if (requestId) {
    const logger = createLogger({ LOG_LEVEL: 'debug' });
    if (googApiKey) {
      const partialGoogKey = googApiKey.length > 8 ? `${googApiKey.substring(0, 4)}...${googApiKey.substring(googApiKey.length - 4)}` : '***';
      logger.debug(requestId, `Found x-goog-api-key header: ${partialGoogKey}`);
    }
    if (xApiKey) {
      const partialXApiKey = xApiKey.length > 8 ? `${xApiKey.substring(0, 4)}...${xApiKey.substring(xApiKey.length - 4)}` : '***';
      logger.debug(requestId, `Found x-api-key header: ${partialXApiKey}`);
    }
    if (authHeader) {
      const partialAuth = authHeader.length > 8 ? `${authHeader.substring(0, 4)}...${authHeader.substring(authHeader.length - 4)}` : '***';
      logger.debug(requestId, `Found Authorization header: ${partialAuth}`);
    }
    logger.debug(requestId, `Endpoint path: ${endpointPath}, Upstream mode: ${upstreamMode}`);
  }
  
  // Determine priority based on endpoint
  const isMessagesEndpoint = endpointPath?.startsWith('/v1/messages');
  const isGeminiEndpoint = endpointPath?.startsWith('/v1/interactions') ||
                          endpointPath?.startsWith('/v1beta/models/') ||
                          endpointPath?.startsWith('/v1/models/');
  
  if (isMessagesEndpoint) {
    // /v1/messages prefers x-api-key
    if (xApiKey) {
      apiKey = xApiKey.startsWith('Bearer ') ? xApiKey.substring(7) : xApiKey;
    } else if (googApiKey) {
      apiKey = googApiKey.startsWith('Bearer ') ? googApiKey.substring(7) : googApiKey;
    } else if (authHeader) {
      apiKey = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    }
  } else if (isGeminiEndpoint) {
    // Gemini endpoints prefer x-goog-api-key
    if (googApiKey) {
      apiKey = googApiKey.startsWith('Bearer ') ? googApiKey.substring(7) : googApiKey;
    } else if (xApiKey) {
      apiKey = xApiKey.startsWith('Bearer ') ? xApiKey.substring(7) : xApiKey;
    } else if (authHeader) {
      apiKey = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    }
  } else {
    // Default priority: x-goog-api-key > x-api-key > Authorization
    if (googApiKey) {
      apiKey = googApiKey.startsWith('Bearer ') ? googApiKey.substring(7) : googApiKey;
    } else if (xApiKey) {
      apiKey = xApiKey.startsWith('Bearer ') ? xApiKey.substring(7) : xApiKey;
    } else if (authHeader) {
      apiKey = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    }
  }
  
  // If no API key found, return empty headers
  if (!apiKey) {
    return headers;
  }
  
  // Format header based on upstream mode
  switch (upstreamMode) {
    case 'anthropic-messages':
      // Claude API uses x-api-key header
      headers['x-api-key'] = apiKey;
      break;
      
    case 'gemini-generatecontent':
    case 'gemini-interactions':
      // Gemini native API uses x-goog-api-key header
      headers['x-goog-api-key'] = apiKey;
      break;
      
    case 'openai-completions':
      // OpenAI-compatible uses Authorization Bearer
      headers['Authorization'] = `Bearer ${apiKey}`;
      break;
      
    default:
      // Default to Authorization Bearer for unknown modes
      headers['Authorization'] = `Bearer ${apiKey}`;
  }
  
  // Forward beta feature headers for Claude
  if (upstreamMode === 'anthropic-messages') {
    const betaVersionHeader = request.headers.get('anthropic-beta');
    if (betaVersionHeader) {
      const validatedFeatures = validateBetaFeaturesUtil(betaVersionHeader);
      if (validatedFeatures) {
        headers['anthropic-beta'] = JSON.stringify(validatedFeatures);
      } else {
        headers['anthropic-beta'] = betaVersionHeader;
      }
    }
  }
  
  return headers;
}



/**
 * Determine handler type based on Claude endpoint
 */
function getHandlerType(claudeEndpoint: string): 'models' | 'token-counting' | 'messages' | 'interactions' | 'generateContent' {
  if (claudeEndpoint === 'v1/models') {
    return 'models';
  }

  if (claudeEndpoint === 'v1/messages/count_tokens') {
    return 'token-counting';
  }

  if (claudeEndpoint.startsWith('v1/messages')) {
    return 'messages';
  }

  // Gemini Interactions API endpoints
  if (claudeEndpoint.startsWith('v1/interactions') || claudeEndpoint.startsWith('v1beta/interactions')) {
    return 'interactions';
  }

  // Gemini generateContent endpoints
  if ((claudeEndpoint.startsWith('v1beta/models/') || claudeEndpoint.startsWith('v1/models/')) && claudeEndpoint.includes(':generateContent')) {
    return 'generateContent';
  }

  throw new Error(`Unknown Claude endpoint: ${claudeEndpoint}`);
}

/**
 * Format a raw API key for the target upstream mode
 */
function formatApiKeyForUpstream(apiKey: string, upstreamMode: string): Record<string, string> {
  const headers: Record<string, string> = {};

  // Format header based on upstream mode
  switch (upstreamMode) {
    case 'anthropic-messages':
      // Claude API uses x-api-key header
      headers['x-api-key'] = apiKey;
      break;

    case 'gemini-generatecontent':
    case 'gemini-interactions':
      // Gemini native API uses x-goog-api-key header
      headers['x-goog-api-key'] = apiKey;
      break;

    case 'openai-completions':
      // OpenAI-compatible uses Authorization Bearer
      headers['Authorization'] = `Bearer ${apiKey}`;
      break;

    default:
      // Default to Authorization Bearer for unknown modes
      headers['Authorization'] = `Bearer ${apiKey}`;
  }

  return headers;
}


