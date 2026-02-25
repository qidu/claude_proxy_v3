# Routing Refactoring

**Date**: 2026-02-25  
**Status**: ✅ Complete

## Implementation

### Main Router (src/index.ts)

```typescript
case 'messages':
  // /v1/messages routes based on upstream mode
  if (upstreamMode === 'native') {
    response = await handleClaudeRequest(...); // pass through to Claude API
  } else { // upstreamMode === 'openai-completions'
    response = await handleMessagesRequest(...); // convert to OpenAI format
  }
  break;

case 'interactions':
  // /v1/interactions routes based on upstream mode
  if (upstreamMode === 'native') {
    response = await handleGeminiRequest(...); // pass through to Gemini API
  } else { // upstreamMode === 'openai-completions'
    response = await handleOpenAIRequest(...); // convert to OpenAI format
  }
  break;

case 'generateContent':
  // /v1beta/models/{model}:generateContent routes based on upstream mode
  if (upstreamMode === 'native') {
    response = await handleGeminiRequest(...); // pass through to Gemini API
  } else { // upstreamMode === 'openai-completions'
    response = await handleOpenAIRequest(...); // convert to OpenAI format
  }
  break;
```

### Configuration (wrangler.toml)

```toml
# Upstream routing modes
MESSAGES_UPSTREAM_MODE = "openai-completions"  # or "native"
INTERACTIONS_UPSTREAM_MODE = "native"          # or "openai-completions"
GENERATE_CONTENT_UPSTREAM_MODE = "native"      # or "openai-completions"

# OpenAI-compatible upstream (for openai-completions mode)
FIXED_ROUTE_TARGET_URL = "https://api.qnaigc.com"
FIXED_ROUTE_PATH_PREFIX = ""

# Native API endpoints
CLAUDE_BASE_URL = "https://api.anthropic.com"
GEMINI_BASE_URL = "https://generativelanguage.googleapis.com"
GEMINI_API_VERSION = "v1beta"
```

## Routing Flow

```
┌────────────────────────────────────────────────────────────────────────────┐
│                       Users Requests                                       │
│  /v1/messages | /v1/interactions | /v1beta/models/{model}:contentGenerate  │
└────────────────────────────┬───────────────────────────────────────────────┘
                             │
                             ▼
                    parseFixedRoute()
                             │
                             ▼
              { handlerType, upstreamMode, targetUrl }
                             │
                             ▼
                    switch(handlerType)
                             │
        ┌────────────────────┼────────────────────┬────────────────┐
        │                    │                    │                │
        ▼                    ▼                    ▼                ▼
   'messages'          'interactions'      'generateContent'  'openai-completions'
        │                    │                    │                │
   check mode           check mode           check mode            ▼
        │                    │                    │           ❌ BLOCKED
   ┌────┴────┐          ┌────┴────┐          ┌────┴────┐
   ▼         ▼          ▼         ▼          ▼         ▼
'native' 'openai-   'native' 'openai-   'native' 'openai-
          completions'        completions'        completions'
   │         │          │         │          │         │
   ▼         ▼          ▼         ▼          ▼         ▼
handleClaude handleOpenAI handleGemini handleOpenAI handleGemini handleOpenAI
Request()   Request()   Request()   Request()   Request()   Request()
   │         │          │         │          │         │
   │         │          │         │          │         │
   ▼         ▼          ▼         ▼          ▼         ▼
AWS/Vertex  OpenAI    Gemini API  OpenAI    Gemini API  OpenAI
Claude API  Compatible            Compatible            Compatible
            upstream              upstream              upstream
            /v1/chat/             /v1/chat/             /v1/chat/
            completions           completions           completions
```

### Model-based Upstream Selection Examples
```toml
# Route specific models to different upstreams
MODELS_UPSTREAM_MAPPING = '{
  "claude-4": [
    {"https://api..com": 30, "api-schema": "claude-messages"}, 
    {"https://aws.com": 40, "api-schema": "openai-completions"}, 
    {"https://googlecloud.com": 40, "api-schema": "openai-completions"}
  ],
  "gemini-2.5-pro": [
    {"https://generativelanguage.googleapis.com":100, "gemini-contentgenerate"}
  ],
  "deepseek-v3.1": [
    {"https://api.deepseek.com": 50, "api-schema": "openai-completions"},
    {"https://api.qnaigc.com": 50, "api-schema": "openai-completions"}
  ],
  "defaults": [
    {"https://api.qnaigc.com": 100, "api-schema": "openai-completions"}
  ]
}'
# 'defaults` means all other models

NATIVE_UPSTREAM_MODES = '[
  "claude-messages", "gemini-contentgenerate"
]
# 'openai-completions' is 'compatible', not 'native'
'

```

### Other Requirements
- Gemini '/v1/interactions' spec refer to docs/interactions.md
- Claude '/v1/messages' spec refer to files in docs/claude_api_docs/* , espetially the 'messages-api.md' and  'token-counting-api.md'


## Summary

✅ **Refactoring Complete**

### Changes Made

1. **New Handler**: Created `src/handlers/claude.ts` for native Claude API pass-through
2. **Updated Router**: Modified `src/index.ts` to support `native` and `openai-completions` modes
3. **Updated Types**: Added new config variables to `src/types/shared.ts`
4. **Updated Config**: Modified `wrangler.toml` and `src/server.ts` with new variables
5. **Simplified Gemini**: Removed dual-mode logic from `gemini.ts` (now native-only)

### New Config Variables

```toml
MESSAGES_UPSTREAM_MODE = "openai-completions"  # /v1/messages routing
INTERACTIONS_UPSTREAM_MODE = "native"          # /v1/interactions routing
GENERATE_CONTENT_UPSTREAM_MODE = "native"      # /v1beta/models/{model}:generateContent routing
CLAUDE_BASE_URL = "https://api.anthropic.com"  # Native Claude API
```

### Handler Matrix

| Endpoint | Mode | Handler | Target |
|----------|------|---------|--------|
| `/v1/messages` | native | claude.ts | Claude API |
| `/v1/messages` | openai-completions | messages.ts | OpenAI upstream |
| `/v1/interactions` | native | gemini.ts | Gemini API |
| `/v1/interactions` | openai-completions | openai.ts | OpenAI upstream |
| `/v1beta/models/{model}:generateContent` | native | gemini.ts | Gemini API |
| `/v1beta/models/{model}:generateContent` | openai-completions | openai.ts | OpenAI upstream |

### Type Safety

✅ All code passes TypeScript type checking (only pre-existing messages.ts errors remain)
