/**
 * Proxy configuration loader
 * Loads config from file or URL
 */

import { readFileSync } from 'fs';
import { Env } from '../types/shared.js';

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
  upstreamMode: string;
  modelAlias?: string;
}

/**
 * Map upstream_mode to handler type
 */
function getUpstreamModeType(upstreamMode: string): 'native' | 'openai-completions' {
  if (upstreamMode === 'anthropic-messages' || 
      upstreamMode === 'gemini-generatecontent' || 
      upstreamMode === 'gemini-interactions') {
    return 'native';
  }
  return 'openai-completions';
}

/**
 * Get model-specific routing config with category inheritance
 */
export function getModelRouteConfig(
  modelName: string,
  proxyConfig: ProxyConfig,
  env: Env
): ModelRouteConfig {
  if (!proxyConfig.models) {
    // No models config, use defaults
    const defaultMode = proxyConfig.defaults?.upstream_mode || 
                       proxyConfig.upstream?.upstream_mode || 
                       'openai-completions';
    return {
      targetUrl: proxyConfig.upstream?.default_base_url || env.FIXED_ROUTE_TARGET_URL || 'https://api.qnaigc.com',
      apiKey: proxyConfig.upstream?.default_api_key,
      upstreamMode: defaultMode,
    };
  }

  // Search for model in all categories
  for (const [categoryName, categoryConfig] of Object.entries(proxyConfig.models)) {
    if (Array.isArray(categoryConfig)) {
      // Skip array entries (these are model definitions, not categories)
      continue;
    }

    // Check if this category contains the model
    const modelEntry = categoryConfig[modelName];
    
    if (modelEntry !== undefined) {
      // Found the model in this category
      const categoryUpstreamMode = categoryConfig.upstream_mode || 
                                   proxyConfig.defaults?.upstream_mode || 
                                   proxyConfig.upstream?.upstream_mode || 
                                   'openai-completions';
      const categoryBaseUrl = categoryConfig.base_url || 
                             proxyConfig.upstream?.default_base_url || 
                             env.FIXED_ROUTE_TARGET_URL || 
                             'https://api.qnaigc.com';
      const categoryApiKey = categoryConfig.api_key || 
                            proxyConfig.upstream?.default_api_key;

      if (Array.isArray(modelEntry)) {
        // Array format: [model_alias, base_url, api_key]
        const [modelAlias, modelBaseUrl, modelApiKey] = modelEntry;
        
        return {
          targetUrl: modelBaseUrl || categoryBaseUrl,
          apiKey: parseApiKey(modelApiKey || categoryApiKey),
          upstreamMode: categoryUpstreamMode,
          modelAlias: modelAlias || undefined,
        };
      } else if (typeof modelEntry === 'string') {
        // Simple string value (legacy format or shorthand)
        return {
          targetUrl: categoryBaseUrl,
          apiKey: parseApiKey(categoryApiKey),
          upstreamMode: categoryUpstreamMode,
          modelAlias: modelEntry || undefined,
        };
      }
    }
  }

  // Model not found in any category, use defaults
  const defaultMode = proxyConfig.defaults?.upstream_mode || 
                     proxyConfig.upstream?.upstream_mode || 
                     'openai-completions';
  
  return {
    targetUrl: proxyConfig.upstream?.default_base_url || env.FIXED_ROUTE_TARGET_URL || 'https://api.qnaigc.com',
    apiKey: parseApiKey(proxyConfig.upstream?.default_api_key),
    upstreamMode: defaultMode,
  };
}

/**
 * Parse API key from config (handles "x-api-key: sk-..." format)
 */
function parseApiKey(apiKey: string | undefined): string | undefined {
  if (!apiKey) return undefined;
  
  // Parse API key if it contains header format (e.g., "x-api-key: sk-...")
  if (apiKey.includes(':')) {
    const parts = apiKey.split(':');
    if (parts.length >= 2) {
      // Extract the key part after the colon, trim whitespace
      return parts.slice(1).join(':').trim();
    }
  }
  
  return apiKey;
}

let cachedConfig: ProxyConfig | null = null;

/**
 * Load proxy config from file or URL
 */
export async function loadProxyConfig(env: Env): Promise<ProxyConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = env.PROXY_CONFIG_PATH;
  const configUrl = env.PROXY_CONFIG_URL;

  try {
    let configContent: string;

    if (configUrl) {
      // Load from URL (e.g., Eureka)
      const response = await fetch(configUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch config from ${configUrl}: ${response.status}`);
      }
      configContent = await response.text();
    } else if (configPath) {
      // Load from file
      configContent = readFileSync(configPath, 'utf-8');
    } else {
      // No config specified, return empty config
      return {};
    }

    // Parse TOML (simple parser for basic structure)
    cachedConfig = parseSimpleToml(configContent);
    return cachedConfig;
  } catch (error) {
    console.warn(`Failed to load proxy config: ${(error as Error).message}`);
    return {};
  }
}

/**
 * Simple TOML parser for category-based structure
 */
function parseSimpleToml(content: string): ProxyConfig {
  const config: ProxyConfig = {};
  const lines = content.split('\n');
  let currentSection: string | null = null;
  let currentCategory: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Section headers: [upstream], [models.gemini], [defaults]
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const section = trimmed.slice(1, -1);
      const parts = section.split('.');
      
      if (parts[0] === 'upstream') {
        currentSection = 'upstream';
        currentCategory = null;
        config.upstream = {};
      } else if (parts[0] === 'models') {
        currentSection = 'models';
        currentCategory = parts[1] || null;
        if (!config.models) config.models = {};
        if (currentCategory) {
          config.models[currentCategory] = {};
        }
      } else if (parts[0] === 'defaults') {
        currentSection = 'defaults';
        currentCategory = null;
        config.defaults = {};
      }
      continue;
    }

    // Key-value pairs
    // Handle simple strings: key = "value"
    const stringMatch = trimmed.match(/^"?([^"=]+)"?\s*=\s*"([^"]*)"$/);
    if (stringMatch) {
      const [, key, value] = stringMatch;
      const cleanKey = key.trim().replace(/^"|"$/g, '');
      
      if (currentSection === 'upstream' && config.upstream) {
        (config.upstream as any)[cleanKey] = value;
      } else if (currentSection === 'models' && currentCategory && config.models) {
        const category = config.models[currentCategory] as ModelCategoryConfig;
        if (cleanKey === 'upstream_mode' || cleanKey === 'base_url' || cleanKey === 'api_key') {
          category[cleanKey] = value;
        }
      } else if (currentSection === 'defaults' && config.defaults) {
        (config.defaults as any)[cleanKey] = value;
      }
      continue;
    }

    // Handle arrays: "model-id" = ["alias", "url", "key"]
    const arrayMatch = trimmed.match(/^"?([^"=]+)"?\s*=\s*\[([^\]]*)\]/);
    if (arrayMatch) {
      const [, key, arrayContent] = arrayMatch;
      const cleanKey = key.trim().replace(/^"|"$/g, '');
      
      // Parse array elements
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
      if (current.trim()) {
        elements.push(current.trim().replace(/^"|"$/g, ''));
      }
      
      // Ensure we have exactly 3 elements
      while (elements.length < 3) {
        elements.push('');
      }
      
      if (currentSection === 'models' && currentCategory && config.models) {
        const category = config.models[currentCategory] as ModelCategoryConfig;
        category[cleanKey] = [elements[0], elements[1], elements[2]];
      }
      continue;
    }
  }

  return config;
}

/**
 * Get model config
 */
export function getModelConfig(config: ProxyConfig, modelName: string) {
  if (!config.models) return undefined;
  
  // Search for model in all categories
  for (const [categoryName, categoryConfig] of Object.entries(config.models)) {
    if (Array.isArray(categoryConfig)) continue;
    
    const modelEntry = categoryConfig[modelName];
    if (modelEntry !== undefined) {
      return {
        category: categoryName,
        entry: modelEntry,
        categoryConfig,
      };
    }
  }
  
  return undefined;
}
