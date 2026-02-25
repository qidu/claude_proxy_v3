# Routing Refactoring

## Requirements

### 1. `/v1/messages` → OpenAI-compatible upstream
- Handler: `messages.ts`
- Converts: Claude → OpenAI
- Target: `/v1/chat/completions`

### 2. `/v1/interactions` → 2 upstream modes
- Mode 1 (openai): Handler `openai.ts` → `/v1/chat/completions`
- Mode 2 (gemini): Handler `gemini.ts` → Gemini generateContent

### 3. `/v1beta/models/{model}:generateContent` → 2 upstream modes
- Mode 1 (openai): Handler `openai.ts` → `/v1/chat/completions`
- Mode 2 (gemini): Handler `gemini.ts` → Gemini generateContent

### 4. `/v1/chat/completions` → BLOCKED
- Returns error: "Direct access to /v1/chat/completions is not allowed. Use /v1/messages instead."

## Implementation

### Main Router (src/index.ts)

```typescript
case 'messages':
  // /v1/messages routes based on upstream mode
  if (upstreamMode === 'native') {
    response = await handleClaudeRequest(...); // pass through to claude models providers: aws or google vertex.
  } else { // upstreamMode === 'openai-completions'
    response = await handleOpenAIRequest(...); // pass to openai-compatible models providers
  }
  break;

case 'interactions':
  // /v1/interactions routes based on upstream mode
  if (upstreamMode === 'native') {
    response = await handleGeminiRequest(...); // pass through to google vertex or google gemini (google ai studio)
  } else { // upstreamMode === 'openai-completions'
    response = await handleOpenAIRequest(...); // pass to openai-compatible models providers
  }
  break;

case 'generateContent':
  // /v1beta/models/{model}:generateContent routes based on upstream mode
  if (upstreamMode === 'native') {
    response = await handleGeminiRequest(...); // pass through to google vertex
  } else { // upstreamMode === 'openai-completions'
    response = await handleOpenAIRequest(...); // pass to openai-compatible models providers
  }
  break;

case 'openai-completions':
  // block it, advices use /v1/messages
  break;
```

## Routing Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         User Request                             │
│  /v1/messages | /v1/interactions | /v1beta/models/{model}:...   │
└────────────────────────────┬────────────────────────────────────┘
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
Claude API  upstream               upstream               upstream
            /v1/chat/              /v1/chat/              /v1/chat/
            completions            completions            completions
```

### Model-based Upstream Selection Examples
```toml
# Route specific models to different upstreams
MODELS_UPSTREAM_MAPPING = '{
  "claude-4": [
    {"https://api.anthropic.com": 30, "api-schema": "anthropic-messages"}, 
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
```
