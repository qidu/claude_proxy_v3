/**
 * Shared types and interfaces for Claude Proxy v3
 */

/**
 * Logger interface
 */
export interface Logger {
    trace(requestId: string, message: string): void;
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
     * Enable local token counting via tiktoken (no API call).
     * Set to "true" or "1" to enable.
     */
    LOCAL_TIKTOKEN?: string;

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
     * Gemini API version.
     * Default: v1beta
     */
    GEMINI_API_VERSION?: string;

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
     * Proxy config file path (local TOML).
     * Path: "./proxy_config.toml"
     */
    PROXY_CONFIG_PATH?: string;
    /**
     * Consul meta URL for remote KV config (read-only dashboard when set).
     * e.g. "http://127.0.0.1:8500" — host must be loopback or private/LAN.
     */
    PROXY_CONFIG_CONSUL?: string;
    /**
     * Path to an Apollo connection file describing { app_id, cluster,
     * namespace, meta, access_key_secret }. The named Apollo namespace holds
     * the full proxy_config.toml content. Read-only dashboard when set.
     * Node-only (not available in the Cloudflare Workers build).
     */
    PROXY_CONFIG_APOLLO?: string;

    /**
     * Node server port used for local TUI test requests.
     */
    PORT?: string;

    /**
     * Cache TTL in seconds for the /v1/models endpoint.
     * Default: 300 (5 minutes)
     * Set to 0 to disable caching.
     */
    MODELS_CACHE_TTL?: string;

    /**
     * Timeout in milliseconds for upstream body fetches.
     * Default: 30000 (30 seconds)
     */
    UPSTREAM_BODY_TIMEOUT_MS?: string;

    /**
     * Default max_tokens value when the request doesn't include it.
     * Some upstreams (e.g., DeepSeek Anthropic-compatible API) require max_tokens.
     * Default: "8192"
     */
    DEFAULT_MAX_TOKENS?: string;

    /**
     * Enable stateful conversation caching for /v1/responses with openai-completions upstream.
     * When "true", the proxy stores each response's output items in memory and
     * automatically prepends prior conversation history for requests that carry
     * `previous_response_id`. TTL: 3600 seconds. In-memory only (no cross-process sharing).
     * Set to "true" or "1" to enable.
     */
    CONVERSATION?: string;

    /**
     * When "true", /v1/chat/completions is forwarded as-is to the default upstream
     * without format conversion. Set to "true" or "1" to enable.
     */
    DEV_PASS_THROUGH?: string;

    /**
     * Development-only: skip the requirement that model requests include an
     * Authorization, x-api-key, or x-goog-api-key header. Set to "true" or "1".
     * Configured auth_server validation still applies.
     */
    DEV_NO_KEY?: string;

    /**
     * Base URL of the OPF privacy-filter sidecar, e.g. "http://127.0.0.1:8799".
     * When unset, the privacy filter plugin is disabled (no behavior change).
     */
    PRIVACY_FILTER_URL?: string;

    /**
     * Base URL of the image-encode sidecar, e.g. "http://localhost:34567".
     * When set, OpenAI image_url -> Gemini inline_data conversion delegates
     * the URL fetch + base64 encode to this sidecar instead of doing it
     * in-process. Equivalent to the toml `[fetch] image_encode` key; env var
     * wins. The sidecar must be reachable on localhost / a private/LAN host.
     */
    IMAGE_ENCODE_URL?: string;

    /**
     * Per-call timeout in milliseconds for the image-encode sidecar.
     * Default: 40000.
     */
    IMAGE_ENCODE_TIMEOUT_MS?: string;

    /**
     * Per-call timeout in milliseconds for sidecar requests. Default: 30000.
     */
    PRIVACY_FILTER_TIMEOUT_MS?: string;

    /**
     * Skip redaction when the combined text length exceeds this many characters.
     * Default: 200000.
     */
    PRIVACY_FILTER_MAX_CHARS?: string;

    /**
     * Base URL of the kompress compression sidecar, e.g. "http://127.0.0.1:7777".
     * When unset, the compression plugin is disabled (no behavior change).
     */
    KOMPRESS_URL?: string;

    /**
     * Comma-separated list of proxy request paths to compress.
     * Default: "/v1/messages,/v1/chat/completions,/v1/responses".
     */
    KOMPRESS_ENDPOINTS?: string;

    /**
     * Fail-open behavior. Defaults to TRUE (compression is an optimization, not a
     * correctness boundary): on sidecar error the original text is forwarded.
     * Set to "false"/"0" to fail-closed (error the request instead).
     */
    KOMPRESS_FAIL_OPEN?: string;

    /**
     * Per-call timeout in milliseconds for sidecar requests. Default: 40000.
     */
    KOMPRESS_TIMEOUT_MS?: string;

    /**
     * Skip compression when the combined compressible text length exceeds this
     * many characters. Default: 1024000.
     */
    KOMPRESS_MAX_CHARS?: string;

    /**
     * Fraction of tokens to keep, passed to the sidecar. Default: 0.5.
     */
    KOMPRESS_KEEP_RATIO?: string;

    /**
     * Per-fragment floor: fragments shorter than this many characters are skipped
     * (compression saves nothing meaningful). Default: 200.
     */
    KOMPRESS_MIN_CHARS?: string;
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
