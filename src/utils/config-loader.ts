/**
 * Proxy configuration loader
 * Loads config from file or URL
 */

import { readFileSync } from 'fs';
import { Env } from '../types/shared.js';

export interface ProxyConfig {
  upstream?: {
    default_url?: string;
    default_api_key?: string;
  };
  models?: Record<string, {
    endpoint?: string;
    mode?: 'native' | 'openai-completions';
    base_url?: string;
    api_key?: string;
  }>;
  defaults?: {
    mode?: 'native' | 'openai-completions';
  };
}

export interface ModelRouteConfig {
  targetUrl: string;
  apiKey?: string;
  mode: 'native' | 'openai-completions';
}

/**
 * Get model-specific routing config
 */
export function getModelRouteConfig(
  modelName: string,
  proxyConfig: ProxyConfig,
  env: Env
): ModelRouteConfig {
  // Normalize model name (replace / and . with -)
  const normalizedModel = modelName.replace(/[/.]/g, '-');
  
  const modelConfig = proxyConfig.models?.[normalizedModel];
  const defaultMode = proxyConfig.defaults?.mode || 'openai-completions';
  
  if (modelConfig) {
    // Model-specific config exists
    const mode = modelConfig.mode || defaultMode;
    const baseUrl = modelConfig.base_url || proxyConfig.upstream?.default_url || env.FIXED_ROUTE_TARGET_URL || 'https://api.qnaigc.com';
    const apiKey = modelConfig.api_key || proxyConfig.upstream?.default_api_key;
    
    return {
      targetUrl: baseUrl,
      apiKey,
      mode,
    };
  }
  
  // Use default upstream
  return {
    targetUrl: proxyConfig.upstream?.default_url || env.FIXED_ROUTE_TARGET_URL || 'https://api.qnaigc.com',
    apiKey: proxyConfig.upstream?.default_api_key,
    mode: defaultMode,
  };
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
 * Simple TOML parser for basic structure
 */
function parseSimpleToml(content: string): ProxyConfig {
  const config: ProxyConfig = {};
  const lines = content.split('\n');
  let currentSection: string | null = null;
  let currentSubsection: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Section headers
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const section = trimmed.slice(1, -1);
      const parts = section.split('.');
      
      if (parts.length === 1) {
        currentSection = parts[0];
        currentSubsection = null;
        if (currentSection === 'upstream') {
          config.upstream = {};
        } else if (currentSection === 'models') {
          config.models = {};
        } else if (currentSection === 'defaults') {
          config.defaults = {};
        }
      } else if (parts.length === 2 && parts[0] === 'models') {
        currentSection = 'models';
        currentSubsection = parts[1];
        if (!config.models) config.models = {};
        config.models[currentSubsection] = {};
      }
      continue;
    }

    // Key-value pairs
    const match = trimmed.match(/^(\w+)\s*=\s*"([^"]+)"$/);
    if (match) {
      const [, key, value] = match;
      
      if (currentSection === 'upstream' && config.upstream) {
        (config.upstream as any)[key] = value;
      } else if (currentSection === 'models' && currentSubsection && config.models) {
        (config.models[currentSubsection] as any)[key] = value;
      } else if (currentSection === 'defaults' && config.defaults) {
        (config.defaults as any)[key] = value;
      }
    }
  }

  return config;
}

/**
 * Get model config
 */
export function getModelConfig(config: ProxyConfig, modelName: string) {
  const normalizedName = modelName.replace(/\//g, '-').replace(/\./g, '-');
  return config.models?.[normalizedName] || config.models?.[modelName];
}
