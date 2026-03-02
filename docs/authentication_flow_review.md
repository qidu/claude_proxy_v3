# Authentication and API Key Flow

**Date**: 2026-03-02  
**Status**: ✅ Implemented

## Overview

This document describes the authentication header flow from client requests through the proxy to upstream APIs.

## Header Format Mapping

### From Client to Proxy

| Endpoint | Primary Header | Fallback Header |
|----------|---------------|-----------------|
| `/v1/messages` | `x-api-key` | `Authorization: Bearer` |
| `/v1/interactions` | `x-goog-api-key` | `Authorization: Bearer` |
| `/v1beta/models/{model}:generateContent` | `x-goog-api-key` | `Authorization: Bearer` |
| `/v1beta/models/{model}:streamGenerateContent` | `x-goog-api-key` | `Authorization: Bearer` |

### From Proxy to Upstream

| Upstream Mode | Header Format |
|---------------|---------------|
| `anthropic-messages` | `x-api-key` |
| `gemini-generatecontent` | `x-goog-api-key` |
| `gemini-interactions` | `x-goog-api-key` |
| `openai-completions` | `Authorization: Bearer` |

## Implementation Flow

### 1. Header Extraction (`src/utils/routing.ts`)

```typescript
function extractAuthHeaders(request: Request): Record<string, string> {
  // Converts x-api-key → Authorization: Bearer
  // Preserves x-goog-api-key for Gemini native API
  // Forwards anthropic-beta headers
}
```

**Key behaviors:**
- `x-api-key` → `Authorization: Bearer` (if no Authorization header present)
- `x-goog-api-key` → preserved as-is
- `Authorization: Bearer` → preserved as-is

### 2. Main Router (`src/index.ts`)

**Model-specific API key override logic:**

```typescript
if (modelRoute.apiKey) {
  if (isClaudeModel && modelRoute.upstreamMode === 'anthropic-messages') {
    // Use x-api-key header
    modelAuthHeaders = { ...authHeaders, 'x-api-key': modelRoute.apiKey };
  } else if (isGeminiModel && (modelRoute.upstreamMode === 'gemini-generatecontent' || modelRoute.upstreamMode === 'gemini-interactions')) {
    // Use x-goog-api-key header, remove Authorization if present
    const { Authorization, ...otherHeaders } = authHeaders;
    modelAuthHeaders = { ...otherHeaders, 'x-goog-api-key': modelRoute.apiKey };
  } else {
    // Check upstream mode
    if (modelRoute.upstreamMode === 'gemini-generatecontent' || modelRoute.upstreamMode === 'gemini-interactions') {
      // Gemini native mode: use x-goog-api-key
      const { Authorization, ...otherHeaders } = authHeaders;
      modelAuthHeaders = { ...otherHeaders, 'x-goog-api-key': modelRoute.apiKey };
    } else {
      // OpenAI-compatible mode: use Authorization Bearer
      modelAuthHeaders = { ...authHeaders, 'Authorization': `Bearer ${modelRoute.apiKey}` };
    }
  }
}
```

### 3. Handler Implementations

#### A. Claude Handler (`src/handlers/claude.ts`)
- Passes `authHeaders` directly to fetch
- Expects `x-api-key` for native Claude API

#### B. Messages Handler (`src/handlers/messages.ts`)
- Passes `authHeaders` directly to fetch
- For OpenAI-compatible upstreams, expects `Authorization: Bearer`

#### C. OpenAI Handler (`src/handlers/openai.ts`)
- Passes `authHeaders` directly to fetch
- For OpenAI-compatible upstreams, expects `Authorization: Bearer`

#### D. Gemini Handler (`src/handlers/gemini.ts`)
- **Complex logic**: Uses `extractGeminiApiKey()` function
- For native Gemini API: looks for `x-goog-api-key` → `Authorization: Bearer` → `x-api-key`
- For OpenAI-compatible mode: looks for `Authorization: Bearer` → `x-api-key`
- **Note**: May override headers from main router

#### E. Token Counting Handler (`src/handlers/token-counting.ts`)
- Passes `authHeaders` directly to fetch

## Complete Flow Diagram

```
Client Request
    ↓
[Header Format Based on Endpoint]
    x-api-key | x-goog-api-key | Authorization: Bearer
    ↓
extractAuthHeaders()
    ↓
[Convert x-api-key → Authorization: Bearer]
[Preserve x-goog-api-key]
    ↓
Main Router
    ↓
[Model-specific API Key Override]
    ↓
[Set Correct Header Format Based on Upstream Mode]
    ↓
Handler Execution
    ↓
[Pass authHeaders to fetch()]  # Most handlers
    OR
[extractGeminiApiKey()]  # Gemini handler only
    ↓
Upstream API
```

## Key Features

### 1. Model-specific API Keys
- Configuration in `proxy_config.toml` per model category
- Overrides client-provided authentication headers
- Uses correct header format based on upstream mode

### 2. Header Conversion
- `x-api-key` → `Authorization: Bearer` for OpenAI-compatible upstreams
- `x-goog-api-key` preserved for Gemini native API
- `Authorization: Bearer` converted to `x-goog-api-key` for Gemini native mode

### 3. Fallback Support
- Multiple header formats accepted from clients
- Environment variable support (`GEMINI_API_KEY`)
- Configuration-based API keys

## Example Scenarios

### Scenario 1: Gemini CLI with Authorization: Bearer
```
Client: Authorization: Bearer wrong-key
Config: gemini-2.5-flash has model API key
Result: x-goog-api-key: model-api-key (client key ignored)
```

### Scenario 2: Claude Native API
```
Client: x-api-key: client-key
Config: claude-4.6-sonnet has model API key
Result: x-api-key: model-api-key
```

### Scenario 3: OpenAI-Compatible Mode
```
Client: Authorization: Bearer client-key
Config: deepseek-v3.2 has model API key
Result: Authorization: Bearer model-api-key
```

## Issues and Considerations

1. **Gemini Handler Complexity**: Duplicate authentication logic in `extractGeminiApiKey()`
2. **Header Conflicts**: Potential override conflicts between main router and Gemini handler
3. **Debugging**: Multiple layers make authentication flow complex to trace

## Recent Fixes (2026-03-02)

1. **Preserve x-goog-api-key**: `extractAuthHeaders()` now preserves `x-goog-api-key` instead of converting to `Authorization: Bearer`
2. **Model-specific override**: Gemini models with native mode now correctly use `x-goog-api-key` header format
3. **Header cleanup**: Removes `Authorization` header when using `x-goog-api-key` to avoid conflicts

## Testing

Use test scripts to verify authentication flow:
- `tests/test_gemini_model_key.sh` - Tests model API key override for Gemini
- `tests/test_claude_gemini.sh` - Tests Claude model routing for Gemini endpoints
- `tests/test_api_key_flow.js` - Tests authentication header extraction
