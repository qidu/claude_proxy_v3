/**
 * Shared types and interfaces for Claude Proxy v3
 */

export interface Env {
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
     * Fixed route target URL for routing requests.
     * Example: "https://api.example.com"
     */
    FIXED_ROUTE_TARGET_URL?: string;

    /**
     * Fixed route path prefix for routing requests.
     * Example: "/api"
     */
    FIXED_ROUTE_PATH_PREFIX?: string;

    /**
     * Log level for the logger.
     * Options: debug, info, warn, error
     * Default: info
     */
    LOG_LEVEL?: string;
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
