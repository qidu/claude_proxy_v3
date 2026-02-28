/**
 * Shared types and interfaces for Claude Proxy v3
 */

/**
 * Logger interface
 */
export interface Logger {
    debug(requestId: string, message: string): void;
    info(requestId: string, message: string): void;
    warn(requestId: string, message: string): void;
    error(requestId: string, message: string): void;
}

export interface Env {
    /**
     * Version identifier (commit id, tag, or branch name).
     * Example: "v1.0.0", "main", "abc123def"
     */
    VERSION?: string;

    /**
     * Enable local token counting (no API call).
     * Set to "true" or "1" to enable.
     */
    LOCAL_TOKEN_COUNTING?: string;

    /**
     * Comma-separated list of allowed CORS origins.
     * If empty or not set, defaults to '*' (allow all).
     * For production, set to your domain(s).
     * Example: "https://example.com,https://app.example.com"
     */
    ALLOWED_ORIGINS?: string;

    /**
     * Development mode - allows all origins regardless of ALLOWED_ORIGINS.
     * Set to "true" to enable dev mode with open CORS.
     */
    DEV_MODE?: string;

    /**
     * Comma-separated list of allowed target hosts for dynamic routing.
     * Only hosts in this list will be allowed for SSRF protection.
     * Defaults to "127.0.0.1" if not set.
     * Example: "127.0.0.1,localhost,api.example.com"
     */
    ALLOWED_HOSTS?: string;

    /**
     * Maximum size for image block base64 data in bytes.
     * Defaults to 10485760 (10MB).
     * Example: "10485760" for 10MB
     */
    IMAGE_BLOCK_DATA_MAX_SIZE?: string;

    /**
     * Log level for the logger.
     * Options: debug, info, warn, error
     * Default: info
     */
    LOG_LEVEL?: string;

    /**
     * Gemini API key for direct Gemini API access.
     * Used when routing requests to Gemini Generative Language API.
     */
    GEMINI_API_KEY?: string;

    /**
     * Gemini API base URL.
     * Default: https://generativelanguage.googleapis.com
     */
    GEMINI_BASE_URL?: string;

    /**
     * Gemini API version.
     * Default: v1beta
     */
    GEMINI_API_VERSION?: string;

    /**
     * Claude API base URL for native mode.
     * Default: https://api.anthropic.com
     */
    CLAUDE_BASE_URL?: string;

    /**
     * /v1/messages upstream mode.
     * 'native' = pass through to Claude API (Anthropic/AWS/Vertex)
     * 'openai-completions' = convert to OpenAI format
     * Default: 'openai-completions'
     */
    MESSAGES_UPSTREAM_MODE?: 'native' | 'openai-completions';

    /**
     * /v1/interactions upstream mode.
     * 'native' = pass through to Gemini API
     * 'openai-completions' = convert to OpenAI format
     * Default: 'native'
     */
    INTERACTIONS_UPSTREAM_MODE?: 'native' | 'openai-completions';

    /**
     * /v1beta/models/{model}:generateContent upstream mode.
     * 'native' = pass through to Gemini API
     * 'openai-completions' = convert to OpenAI format
     * Default: 'native'
     */
    GENERATE_CONTENT_UPSTREAM_MODE?: 'native' | 'openai-completions';

    /**
     * Proxy config file path or URL.
     * Path: "./proxy_config.toml"
     * URL: "http://eureka-server/config/proxy_config.toml"
     */
    PROXY_CONFIG_PATH?: string;
    PROXY_CONFIG_URL?: string;
}


/**
 * Error response type for Claude API
 */
export interface ClaudeErrorResponse {
    type: "error" | "invalid_request_error" | "authentication_error" | "permission_error" | 
          "rate_limit_error" | "processing_error" | "over_limit_error";
    error: {
        type: string;
        message: string;
    };
}

/**
 * Target configuration extracted from dynamic path
 */
export interface TargetConfig {
    targetUrl: string;
    targetPathPrefix: string;
}

/**
 * HTTP response with Claude headers
 */
export interface ClaudeResponse {
    status: number;
    headers: Record<string, string>;
    body: any;
}

/**
 * Router context passed through middleware
 */
export interface RouterContext {
    request: Request;
    config: TargetConfig;
    clientParams: any;
    organizationId?: string;
    requestId?: string;
}
