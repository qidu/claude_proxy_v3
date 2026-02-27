# Routing Logic and Config Revision

**Date**: 2026-02-27  
**Status**: ✅ Complete

## Overview

Revised routing logic and configuration to align implementation with documentation and config template. Fixed critical mismatches between config structure, parser, and routing logic.

## Issues Fixed

### 1. Config Structure Mismatch
**Problem**: Template used category-based structure but loader expected flat structure.

**Before**:
- Template: `[models.gemini]` with array format `["alias", "url", "key"]`
- Loader: Expected `[models.model-name]` with individual fields

**After**:
- Unified category-based structure throughout
- Parser now correctly handles `[models.category]` sections
- Models inherit from category defaults

### 2. Field Naming Inconsistency
**Problem**: Template used `upstream_mode`, loader used `mode`.

**Before**:
```toml
[models.gemini]
mode = "native"  # Wrong field name
```

**After**:
```toml
[models.gemini]
upstream_mode = "gemini-generatecontent"  # Correct field name
```

### 3. Array Format Not Parsed
**Problem**: Parser only handled simple key-value pairs, not arrays.

**Before**: Parser couldn't read `"model-id" = ["alias", "url", "key"]`

**After**: Full array parsing with proper element extraction and inheritance

### 4. Native Mode Detection
**Problem**: Code checked `mode === 'native'` but config used specific upstream modes.

**Before**:
```typescript
if (modelRoute.mode === 'native') { ... }
```

**After**:
```typescript
const isNativeMode = modelRoute.upstreamMode === 'anthropic-messages' || 
                    modelRoute.upstreamMode === 'gemini-generatecontent' || 
                    modelRoute.upstreamMode === 'gemini-interactions';
```

### 5. Category Inheritance Not Implemented
**Problem**: Models couldn't inherit settings from category.

**After**: Full inheritance chain implemented:
```
Model array value → Category default → [upstream] default → Error
```

## Changes Made

### 1. Type Definitions (`src/utils/config-loader.ts`)

**Updated interfaces**:
```typescript
export interface ProxyConfig {
  upstream?: {
    upstream_mode?: string;
    default_base_url?: string;
    default_api_key?: string;
  };
  models?: Record<string, ModelCategoryConfig | ModelArrayConfig>;
  defaults?: {
    upstream_mode?: string;
  };
}

export interface ModelCategoryConfig {
  upstream_mode?: string;
  base_url?: string;
  api_key?: string;
  [modelId: string]: string | string[] | undefined;
}

export type ModelArrayConfig = [string, string, string]; // [model_alias, base_url, api_key]

export interface ModelRouteConfig {
  targetUrl: string;
  apiKey?: string;
  upstreamMode: string;  // Changed from 'mode'
  modelAlias?: string;
}
```

### 2. Config Parser (`src/utils/config-loader.ts`)

**Rewrote `parseSimpleToml()`**:
- Handles category sections: `[models.gemini]`, `[models.claude]`, `[models.default]`
- Parses array format: `"model-id" = ["alias", "url", "key"]`
- Parses simple strings: `upstream_mode = "gemini-generatecontent"`
- Supports quoted and unquoted keys

**Array parsing logic**:
```typescript
// Parse array elements with proper quote handling
const elements: string[] = [];
let current = '';
let inQuotes = false;

for (let j = 0; j < arrayContent.length; j++) {
  const char = arrayContent[j];
  if (char === '"') {
    inQuotes = !inQuotes;
  } else if (char === ',' && !inQuotes) {
    elements.push(current.trim().replace(/^"|"$/g, ''));
    current = '';
  } else {
    current += char;
  }
}
```

### 3. Model Route Resolution (`src/utils/config-loader.ts`)

**Rewrote `getModelRouteConfig()`**:
- Searches for model across all categories
- Implements inheritance chain
- Handles array format with empty string inheritance
- Parses API keys (removes header prefix if present)

**Inheritance logic**:
```typescript
// Search for model in all categories
for (const [categoryName, categoryConfig] of Object.entries(proxyConfig.models)) {
  const modelEntry = categoryConfig[modelName];
  
  if (modelEntry !== undefined) {
    if (Array.isArray(modelEntry)) {
      const [modelAlias, modelBaseUrl, modelApiKey] = modelEntry;
      
      return {
        targetUrl: modelBaseUrl || categoryBaseUrl,
        apiKey: parseApiKey(modelApiKey || categoryApiKey),
        upstreamMode: categoryUpstreamMode,
        modelAlias: modelAlias || undefined,
      };
    }
  }
}
```

### 4. Routing Logic (`src/index.ts`)

**Updated mode detection**:
```typescript
// Determine if native mode based on upstream_mode value
const isNativeMode = modelRoute.upstreamMode === 'anthropic-messages' || 
                    modelRoute.upstreamMode === 'gemini-generatecontent' || 
                    modelRoute.upstreamMode === 'gemini-interactions';

if (path === '/v1/messages' || path.startsWith('/v1/messages?')) {
  handlerType = 'messages';
  if (isNativeMode) {
    if (modelRoute.upstreamMode === 'gemini-generatecontent' || 
        modelRoute.upstreamMode === 'gemini-interactions') {
      // Route to Gemini generateContent
      targetUrl = `${modelRoute.targetUrl}/v1beta/models/${upstreamModelName}:generateContent`;
    } else {
      // Route to Claude /v1/messages
      targetUrl = `${modelRoute.targetUrl}/v1/messages`;
    }
    upstreamMode = 'native';
  } else {
    // OpenAI-compatible mode
    targetUrl = `${modelRoute.targetUrl}/v1/chat/completions`;
    upstreamMode = 'openai-completions';
  }
}
```

**Changed all references**:
- `modelRoute.mode` → `modelRoute.upstreamMode`
- Removed model name prefix detection (gemini-, claude-)
- Use explicit upstream_mode values for routing decisions

### 5. Config Template (`proxy_config.toml_template`)

**Simplified comments**:
- Clearer category structure explanation
- Better array format documentation
- Removed redundant examples
- Added inheritance chain documentation

**Example structure**:
```toml
[upstream]
upstream_mode = "openai-completions"
default_base_url = "https://api.qnaigc.com"
default_api_key = "sk-..."

[models.gemini]
upstream_mode = "gemini-generatecontent"
base_url = "https://api.example.com"
api_key = "sk-gemini-key"
"gemini-3.1-pro-preview" = ["", "", ""]  # Inherits all
"gemini-3.0-flash-preview" = ["gemini-3-flash-preview", "https://custom.com", "sk-custom"]  # Overrides all

[models.claude]
upstream_mode = "anthropic-messages"
base_url = "https://api.anthropic.com"
api_key = "sk-claude-key"
"claude-4.6-sonnet" = ["claude-opus-4-1-20250805-thinking", "", ""]  # Override alias only

[models.default]
upstream_mode = "openai-completions"
# Inherits base_url and api_key from [upstream]
"deepseek/deepseek-v3.2" = ["", "", ""]
"gpt-oss-120b" = ["", "", ""]
```

## Upstream Mode Mapping

| upstream_mode | Handler Type | Target Endpoint |
|---------------|--------------|-----------------|
| `anthropic-messages` | native | `/v1/messages` |
| `gemini-generatecontent` | native | `/v1beta/models/{model}:generateContent` |
| `gemini-interactions` | native | `/v1/interactions` |
| `openai-completions` | openai-completions | `/v1/chat/completions` |

## Category Inheritance Rules

1. **Model array value** takes precedence
2. **Category defaults** used if array element is empty string `""`
3. **[upstream] defaults** used if category doesn't define value
4. **Error** if no value found in entire chain

**Example**:
```toml
[upstream]
default_base_url = "https://default.com"
default_api_key = "sk-default"

[models.gemini]
upstream_mode = "gemini-generatecontent"
base_url = "https://gemini.com"
api_key = "sk-gemini"
"gemini-3.1-pro-preview" = ["", "", ""]  # Uses gemini.com and sk-gemini
"gemini-custom" = ["", "https://custom.com", ""]  # Uses custom.com and sk-gemini
```

## Testing

### Type Checking
```bash
npm run typecheck
```
✅ **Result**: No type errors

### Config Parsing Test
Create test config and verify parsing:
```bash
PROXY_CONFIG_PATH=./proxy_config.toml_template npm run dev
```

Expected log output:
```
Loaded proxy config with 3 model configs
Model: gemini-3.1-pro-preview, Mode: gemini-generatecontent, TargetURL: https://api.example1.com
```

## Migration Guide

### For Existing Configs

**Old format** (flat structure):
```toml
[models.gemini-2-5-flash]
mode = "native"
base_url = "https://api.example.com"
api_key = "sk-key"
```

**New format** (category-based):
```toml
[models.gemini]
upstream_mode = "gemini-generatecontent"
base_url = "https://api.example.com"
api_key = "sk-key"
"gemini-2.5-flash" = ["", "", ""]
```

### Key Changes
1. Replace `mode` with `upstream_mode`
2. Use specific mode values: `anthropic-messages`, `gemini-generatecontent`, `gemini-interactions`, `openai-completions`
3. Group models into categories: `[models.gemini]`, `[models.claude]`, `[models.default]`
4. Use array format for model entries: `["alias", "url", "key"]`
5. Use empty strings `""` to inherit from category

## Benefits

1. **Consistency**: Config template, parser, and routing logic now aligned
2. **Clarity**: Explicit upstream_mode values instead of generic "native"
3. **Flexibility**: Category inheritance reduces duplication
4. **Maintainability**: Single source of truth for model routing
5. **Type Safety**: Full TypeScript type checking passes

## Future Enhancements

1. **Model List Configuration**: Add support for `[models.list]` section
2. **Multiple Upstreams**: Load balancing and failover per model
3. **Hot Reload**: Watch config file for changes
4. **Validation**: Stricter config validation with error messages
5. **TOML Library**: Replace simple parser with full TOML library

## Related Documentation

- `docs/routing_refactor.md` - Original routing architecture
- `docs/config_loader.md` - Configuration loading guide
- `proxy_config.toml_template` - Configuration template with examples
- `README.md` - Updated with new config structure
