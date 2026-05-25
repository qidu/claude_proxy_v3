/**
 * Proxy configuration loader
 * Loads config from file or URL
 * Compatible with both Node.js and Cloudflare Workers environments
 */

import { Env } from '../types/shared.js';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

// Check if we're running in Node.js environment
const isNodeEnvironment = (typeof process !== 'undefined' && process.versions?.node) ||
                          (typeof globalThis !== 'undefined' && (globalThis as any).process?.versions?.node);

export interface ProxyConfig {
  upstream?: {
    upstream_mode?: string;
    default_base_url?: string;
    default_api_key?: string;
    budget_to_effort_low?: number | string;
    budget_to_effort_medium?: number | string;
    budget_to_effort_high?: number | string;
  };
  models?: Record<string, ModelCategoryConfig | ModelArrayConfig>;
  composite?: Record<string, CompositeModelConfig>;
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

export interface CompositeTargetConfig {
  share?: number;
  primary?: boolean;
  fallback?: number;
}

export type CompositeModelConfig = Record<string, CompositeTargetConfig>;

export interface ModelRouteConfig {
  targetUrl: string;
  apiKey?: string;
  upstreamMode: string;
  modelAlias?: string;
}

export interface CompositeRouteSelection {
  selectedModelName: string;
  route: ModelRouteConfig;
  skippedTargets: string[];
}

interface CompositeResolvedTarget {
  targetModelName: string;
  targetConfig: CompositeTargetConfig;
  route: ModelRouteConfig;
  index: number;
}

function resolveModelRouteFromEntry(
  modelEntry: string | string[],
  categoryConfig: ModelCategoryConfig,
  proxyConfig: ProxyConfig
): ModelRouteConfig {
  const categoryUpstreamMode = categoryConfig.upstream_mode ||
                               proxyConfig.upstream?.upstream_mode ||
                               'openai-completions';
  const categoryBaseUrl = categoryConfig.base_url ||
                          proxyConfig.upstream?.default_base_url ||
                          'https://api.qnaigc.com';
  const categoryApiKey = categoryConfig.api_key ||
                        proxyConfig.upstream?.default_api_key;

  if (Array.isArray(modelEntry)) {
    const [modelAlias, modelBaseUrl, modelApiKey] = modelEntry;
    return {
      targetUrl: modelBaseUrl || categoryBaseUrl,
      apiKey: parseApiKey(modelApiKey || categoryApiKey),
      upstreamMode: categoryUpstreamMode,
      modelAlias: modelAlias || undefined,
    };
  }

  return {
    targetUrl: categoryBaseUrl,
    apiKey: parseApiKey(categoryApiKey),
    upstreamMode: categoryUpstreamMode,
    modelAlias: modelEntry || undefined,
  };
}

function resolveModelRouteFromConfig(
  modelName: string,
  proxyConfig: ProxyConfig
): ModelRouteConfig | undefined {
  const modelConfig = getModelConfig(proxyConfig, modelName);
  if (!modelConfig) {
    return undefined;
  }

  const entry = modelConfig.entry;
  if (entry === undefined) {
    return undefined;
  }

  return resolveModelRouteFromEntry(entry, modelConfig.categoryConfig, proxyConfig);
}

function getOrderedCompositeTargets(
  modelName: string,
  proxyConfig: ProxyConfig
): { orderedTargets: CompositeResolvedTarget[]; skippedTargets: string[] } | undefined {
  const compositeConfig = proxyConfig.composite?.[modelName];
  if (!compositeConfig) {
    return undefined;
  }

  const skippedTargets: string[] = [];
  const resolvedTargets = Object.entries(compositeConfig)
    .map(([targetModelName, targetConfig], index) => {
      const route = resolveModelRouteFromConfig(targetModelName, proxyConfig) || {
        ...getDefaultModelRoute(proxyConfig),
        modelAlias: targetModelName,
      };

      return {
        targetModelName,
        targetConfig: targetConfig || {},
        route,
        index,
      };
    })
    .filter((candidate): candidate is CompositeResolvedTarget => candidate !== undefined);

  if (resolvedTargets.length === 0) {
    return { orderedTargets: [], skippedTargets };
  }

  const primaryCandidate = resolvedTargets.find(candidate => candidate.targetConfig.primary);
  const orderedTargets = primaryCandidate
    ? [primaryCandidate, ...resolvedTargets.filter(candidate => candidate !== primaryCandidate)]
    : resolvedTargets
        .slice()
        .sort((left, right) => {
          const leftFallback = left.targetConfig.fallback;
          const rightFallback = right.targetConfig.fallback;

          if (leftFallback !== undefined || rightFallback !== undefined) {
            const normalizedLeft = leftFallback ?? Number.POSITIVE_INFINITY;
            const normalizedRight = rightFallback ?? Number.POSITIVE_INFINITY;
            if (normalizedLeft !== normalizedRight) {
              return normalizedLeft - normalizedRight;
            }
          }

          return left.index - right.index;
        });

  return { orderedTargets, skippedTargets };
}

function resolveCompositeModelRoute(
  modelName: string,
  proxyConfig: ProxyConfig
): CompositeRouteSelection | undefined {
  const orderedComposite = getOrderedCompositeTargets(modelName, proxyConfig);
  if (!orderedComposite) {
    return undefined;
  }

  const { orderedTargets, skippedTargets } = orderedComposite;
  if (orderedTargets.length === 0) {
    return undefined;
  }

  const selectedCandidate = orderedTargets.some(candidate => candidate.targetConfig.fallback !== undefined || candidate.targetConfig.primary)
    ? orderedTargets[0]
    : selectWeightedCompositeCandidate(orderedTargets);

  if (!selectedCandidate) {
    return undefined;
  }

  return {
    selectedModelName: selectedCandidate.targetModelName,
    route: {
      ...selectedCandidate.route,
      modelAlias: selectedCandidate.route.modelAlias || selectedCandidate.targetModelName,
    },
    skippedTargets,
  };
}

function selectWeightedCompositeCandidate<T extends { targetConfig: CompositeTargetConfig }>(candidates: T[]): T | undefined {
  if (candidates.length === 0) {
    return undefined;
  }

  const weights = candidates.map(candidate => candidate.targetConfig.share ?? 1);
  const totalWeight = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (totalWeight <= 0) {
    return candidates[0];
  }

  let remaining = Math.random() * totalWeight;
  for (let i = 0; i < candidates.length; i++) {
    remaining -= Math.max(0, weights[i]);
    if (remaining <= 0) {
      return candidates[i];
    }
  }

  return candidates[candidates.length - 1];
}

/**
 * Get model-specific routing config with category inheritance
 */
function getDefaultModelRoute(proxyConfig: ProxyConfig): ModelRouteConfig {
  const defaultCategory = proxyConfig.models?.default;
  const defaultCategoryConfig = defaultCategory && !Array.isArray(defaultCategory) ? defaultCategory : undefined;
  const defaultMode = defaultCategoryConfig?.upstream_mode ||
                     proxyConfig.upstream?.upstream_mode ||
                     'openai-completions';
  const defaultBaseUrl = defaultCategoryConfig?.base_url ||
                        proxyConfig.upstream?.default_base_url ||
                        'https://api.qnaigc.com';
  const defaultApiKey = defaultCategoryConfig?.api_key ||
                       proxyConfig.upstream?.default_api_key;

  return {
    targetUrl: defaultBaseUrl,
    apiKey: parseApiKey(defaultApiKey),
    upstreamMode: defaultMode,
  };
}

export function getCompositeRouteCandidates(
  modelName: string,
  proxyConfig: ProxyConfig
): Array<{ modelName: string; route: ModelRouteConfig }> {
  if (!proxyConfig.models) {
    return [];
  }

  const orderedComposite = getOrderedCompositeTargets(modelName, proxyConfig);
  if (!orderedComposite) {
    return [];
  }

  const { orderedTargets } = orderedComposite;
  const hasPriorityOrder = orderedTargets.some(candidate => candidate.targetConfig.primary || candidate.targetConfig.fallback !== undefined);

  let attemptOrder = orderedTargets;
  if (!hasPriorityOrder) {
    const firstCandidate = selectWeightedCompositeCandidate(orderedTargets);
    if (firstCandidate) {
      attemptOrder = [firstCandidate, ...orderedTargets.filter(candidate => candidate !== firstCandidate)];
    }
  }

  return attemptOrder.map(candidate => ({
    modelName: candidate.targetModelName,
    route: {
      ...candidate.route,
      modelAlias: candidate.route.modelAlias || candidate.targetModelName,
    },
  }));
}

export function getModelRouteConfig(
  modelName: string,
  proxyConfig: ProxyConfig
): ModelRouteConfig {
  if (!proxyConfig.models) {
    return getDefaultModelRoute(proxyConfig);
  }

  const compositeRoute = resolveCompositeModelRoute(modelName, proxyConfig);
  if (compositeRoute) {
    return compositeRoute.route;
  }

  const directRoute = resolveModelRouteFromConfig(modelName, proxyConfig);
  if (directRoute) {
    return directRoute;
  }

  return getDefaultModelRoute(proxyConfig);
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

type ConsulKvEntry = {
  Key: string;
  Value?: string | null;
};

const CONSUL_CONFIG_PREFIX = 'model-proxy-v3';

function normalizeUpstreamThresholdValue(key: string, rawValue: string | number): string | number {
  if (key !== 'budget_to_effort_low' && key !== 'budget_to_effort_medium' && key !== 'budget_to_effort_high') {
    return rawValue;
  }

  if (typeof rawValue === 'number') {
    return rawValue;
  }

  const numericMatch = rawValue.match(/-?\d+/);
  if (!numericMatch) {
    return rawValue;
  }

  const parsed = Number(numericMatch[0]);
  return Number.isNaN(parsed) ? rawValue : parsed;
}

function decodeBase64(value: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'base64').toString('utf-8');
  }

  const binary = atob(value);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function parseConsulArrayValue(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return [value];
  }

  const inner = trimmed.slice(1, -1);
  const elements: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
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

  return elements;
}

function parseConsulScalarValue(value: string): string | number {
  if (value === '') {
    return '';
  }

  const numeric = Number(value);
  if (!Number.isNaN(numeric) && value.trim() !== '') {
    return numeric;
  }

  return value;
}

function buildConsulKvUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/kv/${CONSUL_CONFIG_PREFIX}?recurse=true`;
}

function applyConsulKvEntry(config: ProxyConfig, entry: ConsulKvEntry): void {
  if (!entry.Value) {
    return;
  }

  const relativeKey = entry.Key.startsWith(`${CONSUL_CONFIG_PREFIX}/`)
    ? entry.Key.slice(CONSUL_CONFIG_PREFIX.length + 1)
    : entry.Key;
  const parts = relativeKey.split('/').filter(Boolean);
  if (parts.length === 0) {
    return;
  }

  const rawValue = decodeBase64(entry.Value).trim();
  const section = parts[0];

  if (section === 'upstream' && parts.length >= 2) {
    config.upstream ??= {};
    const key = parts.slice(1).join('/');
    (config.upstream as any)[key] = parseConsulScalarValue(rawValue);
    return;
  }

  if (section === 'defaults' && parts.length >= 2) {
    config.defaults ??= {};
    const key = parts.slice(1).join('/');
    (config.defaults as any)[key] = rawValue;
    return;
  }

  if (section === 'models' && parts.length >= 3) {
    config.models ??= {};
    const categoryName = parts[1];
    const key = parts.slice(2).join('/');
    const category = (config.models[categoryName] ??= {});

    if (Array.isArray(category)) {
      return;
    }

    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      category[key] = parseConsulArrayValue(rawValue);
      return;
    }

    category[key] = rawValue;
  }
}

function parseConsulConfig(entries: ConsulKvEntry[]): ProxyConfig {
  const config: ProxyConfig = {};
  for (const entry of entries) {
    applyConsulKvEntry(config, entry);
  }
  return config;
}

function parseCompositeTargetConfig(value: string): CompositeTargetConfig {
  const config: CompositeTargetConfig = {};
  const cleaned = value.replace(/[{}]/g, '');
  const fields = cleaned.split(',');

  for (const field of fields) {
    const trimmed = field.trim();
    if (!trimmed) {
      continue;
    }

    const match = trimmed.match(/^"?([^"=]+)"?\s*:\s*(.+)$/);
    if (!match) {
      continue;
    }

    const key = match[1].trim().replace(/^"|"$/g, '');
    const rawValue = match[2].trim().replace(/,$/, '');

    if (key === 'share' || key === 'fallback') {
      const numeric = Number(rawValue);
      if (!Number.isNaN(numeric)) {
        config[key] = numeric;
      }
      continue;
    }

    if (key === 'primary') {
      config.primary = rawValue === 'true';
    }
  }

  return config;
}

function parseCompositeModelConfig(rawValue: string): CompositeModelConfig {
  const config: CompositeModelConfig = {};
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return config;
  }

  const inner = trimmed.slice(1, -1);
  const entries: string[] = [];
  let current = '';
  let depth = 0;
  let inQuotes = false;

  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }

    if (!inQuotes) {
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
      } else if (char === ',' && depth === 0) {
        if (current.trim()) {
          entries.push(current.trim());
        }
        current = '';
        continue;
      }
    }

    current += char;
  }

  if (current.trim()) {
    entries.push(current.trim());
  }

  for (const entry of entries) {
    const match = entry.match(/^"([^"]+)"\s*:\s*(\{.*\})$/);
    if (!match) {
      continue;
    }

    config[match[1]] = parseCompositeTargetConfig(match[2]);
  }

  return config;
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

function serializeTomlValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeTomlValue(item)).join(', ')}]`;
  }

  if (typeof value === 'string') {
    return quoteTomlString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return quoteTomlString(String(value));
}

function serializeTomlSection(section: Record<string, unknown>): string[] {
  return Object.entries(section).map(([key, value]) => `${key} = ${serializeTomlValue(value)}`);
}

function serializeCompositeTargetConfig(config: CompositeTargetConfig): string {
  const fields: string[] = [];
  if (config.share !== undefined) {
    fields.push(`"share": ${config.share}`);
  }
  if (config.primary !== undefined) {
    fields.push(`"primary": ${config.primary}`);
  }
  if (config.fallback !== undefined) {
    fields.push(`"fallback": ${config.fallback}`);
  }
  return `{${fields.join(', ')}}`;
}

function serializeCompositeModelConfig(config: CompositeModelConfig): string {
  const entries = Object.entries(config).map(([modelName, targetConfig]) => {
    const serializedTarget = serializeCompositeTargetConfig(targetConfig || {});
    return `${JSON.stringify(modelName)}: ${serializedTarget}`;
  });
  return `{${entries.join(', ')}}`;
}

export function serializeProxyConfigToml(config: ProxyConfig): string {
  const lines: string[] = [];

  if (config.upstream) {
    lines.push('[upstream]');
    lines.push(...serializeTomlSection(config.upstream as Record<string, unknown>));
    lines.push('');
  }

  if (config.models) {
    for (const [categoryName, categoryConfig] of Object.entries(config.models)) {
      if (Array.isArray(categoryConfig)) {
        continue;
      }

      lines.push(`[models.${categoryName}]`);
      const { composite, ...categoryRest } = categoryConfig as Record<string, unknown>;
      lines.push(...serializeTomlSection(categoryRest));
      if (composite && typeof composite === 'object' && !Array.isArray(composite)) {
        lines.push(`composite = ${serializeCompositeModelConfig(composite as CompositeModelConfig)}`);
      }
      lines.push('');
    }
  }

  if (config.composite) {
    lines.push('[composite]');
    lines.push(...Object.entries(config.composite).map(([modelName, targetConfig]) => `${JSON.stringify(modelName)} = ${serializeCompositeModelConfig(targetConfig)}`));
    lines.push('');
  }

  if (config.defaults) {
    lines.push('[defaults]');
    lines.push(...serializeTomlSection(config.defaults as Record<string, unknown>));
    lines.push('');
  }

  return lines.join('\n').replace(/\n$/, '');
}

export function getConfiguredModelIds(config: ProxyConfig): string[] {
  const ids = new Set<string>();
  const reservedKeys = new Set(['upstream_mode', 'base_url', 'api_key']);

  if (!config.models) {
    return [];
  }

  for (const [categoryName, categoryConfig] of Object.entries(config.models)) {
    if (categoryName === 'list' || Array.isArray(categoryConfig)) {
      continue;
    }

    for (const [key, value] of Object.entries(categoryConfig)) {
      if (reservedKeys.has(key) || key.endsWith('_list')) {
        continue;
      }

      if (value !== undefined) {
        ids.add(key);
      }
    }
  }

  return [...ids];
}

export function dumpProxyConfigToml(config: ProxyConfig, directory = './config-dumps'): string | null {
  if (!isNodeEnvironment) {
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = join(directory, `proxy_config_${timestamp}.toml`);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, serializeProxyConfigToml(config), 'utf-8');
  return filePath;
}

let cachedConfig: ProxyConfig | null = null;

export function clearProxyConfigCache(): void {
  cachedConfig = null;
}

/**
 * Load proxy config from file or URL
 */
export async function loadProxyConfig(env: Env): Promise<ProxyConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = env.PROXY_CONFIG_PATH;
  const configUrl = env.PROXY_CONFIG_URL;

  console.log(`[INFO] Config path: ${configPath}, Config URL: ${configUrl}`);

  try {
    let config: ProxyConfig;

    if (configUrl) {
      const response = await fetch(buildConsulKvUrl(configUrl));
      if (!response.ok) {
        throw new Error(`Failed to fetch config from Consul at ${configUrl}: ${response.status}`);
      }

      const kvEntries = (await response.json()) as ConsulKvEntry[];
      if (!Array.isArray(kvEntries)) {
        throw new Error(`Invalid Consul KV response from ${configUrl}`);
      }
      config = parseConsulConfig(kvEntries);
    } else if (configPath) {
      // Load from file - handle both Node.js and Cloudflare Workers environments
      let configContent: string;
      if (isNodeEnvironment) {
        // Node.js environment - use fs module
        const fs = await import('fs');
        configContent = fs.readFileSync(configPath, 'utf-8');
      } else {
        // Cloudflare Workers environment - fetch from relative URL
        // In Workers, configPath should be a relative path that can be fetched
        const response = await fetch(configPath);
        if (!response.ok) {
          throw new Error(`Failed to fetch config from ${configPath}: ${response.status}`);
        }
        configContent = await response.text();
      }
      config = parseSimpleToml(configContent);
    } else {
      // No config specified, return empty config
      return {};
    }

    cachedConfig = config;
    return cachedConfig;
  } catch (error) {
    console.warn(`Failed to load proxy config: ${(error as Error).message}`);
    return {};
  }
}

/**
 * Simple TOML parser for category-based structure
 */
export function parseSimpleToml(content: string): ProxyConfig {
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
      } else if (parts[0] === 'composite') {
        currentSection = 'composite';
        currentCategory = null;
        config.composite = {};
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
        (config.upstream as any)[cleanKey] = normalizeUpstreamThresholdValue(cleanKey, value);
      } else if (currentSection === 'models' && currentCategory && config.models) {
        const category = config.models[currentCategory] as ModelCategoryConfig;
        if (cleanKey === 'upstream_mode' || cleanKey === 'base_url' || cleanKey === 'api_key') {
          category[cleanKey] = value;
        }
      } else if (currentSection === 'composite' && config.composite) {
        config.composite[cleanKey] = parseCompositeModelConfig(value);
      } else if (currentSection === 'defaults' && config.defaults) {
        (config.defaults as any)[cleanKey] = value;
      }
      continue;
    }

    // Handle composite inline object values: "alias" = {"m1": {...}, "m2": {...}}
    const compositeObjectMatch = trimmed.match(/^"?([^"=]+)"?\s*=\s*(\{.+\})$/);
    if (compositeObjectMatch && currentSection === 'composite' && config.composite) {
      const [, key, value] = compositeObjectMatch;
      const cleanKey = key.trim().replace(/^"|"$/g, '');
      config.composite[cleanKey] = parseCompositeModelConfig(value.trim());
      continue;
    }

    // Handle arrays: "model-id" = ["alias", "url", "key"]
    // Must be checked before unquotedMatch to avoid greedy (.+) capture stealing array values.
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

    // Handle unquoted numbers and other values: key = value
    const unquotedMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*(.+)$/);
    if (unquotedMatch) {
      const [, key, value] = unquotedMatch;
      const cleanKey = key.trim();
      let cleanValue: string | number = value.trim();

      // Try to parse as number
      if (!isNaN(Number(cleanValue)) && cleanValue !== '') {
        cleanValue = Number(cleanValue);
      }

      if (currentSection === 'upstream' && config.upstream) {
        (config.upstream as any)[cleanKey] = normalizeUpstreamThresholdValue(cleanKey, cleanValue);
      } else if (currentSection === 'defaults' && config.defaults) {
        (config.defaults as any)[cleanKey] = cleanValue;
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

export type DashboardModelArrayConfig = [string, string];

export interface DashboardModelCategoryConfig {
  upstream_mode?: string;
  base_url?: string;
  [modelId: string]: string | DashboardModelArrayConfig | undefined;
}

export interface DashboardConfigPayload {
  models: Record<string, DashboardModelCategoryConfig>;
  composite: Record<string, CompositeModelConfig>;
}

function sanitizeDashboardCategoryConfig(categoryConfig: ModelCategoryConfig): DashboardModelCategoryConfig {
  const sanitized: DashboardModelCategoryConfig = {};

  for (const [key, value] of Object.entries(categoryConfig)) {
    if (key === 'api_key') {
      continue;
    }

    if (Array.isArray(value)) {
      sanitized[key] = [value[0] || '', value[1] || ''];
    } else if (typeof value === 'string') {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

function sanitizeCompositeConfig(composite: ProxyConfig['composite']): Record<string, CompositeModelConfig> {
  if (!composite) {
    return {};
  }

  const result: Record<string, CompositeModelConfig> = {};
  for (const [alias, targets] of Object.entries(composite)) {
    const safeTargets: CompositeModelConfig = {};
    for (const [targetModel, config] of Object.entries(targets || {})) {
      const safeTarget: CompositeTargetConfig = {};
      if (typeof config.share === 'number' && Number.isFinite(config.share)) {
        safeTarget.share = config.share;
      }
      if (typeof config.primary === 'boolean') {
        safeTarget.primary = config.primary;
      }
      if (typeof config.fallback === 'number' && Number.isFinite(config.fallback)) {
        safeTarget.fallback = config.fallback;
      }
      safeTargets[targetModel] = safeTarget;
    }
    result[alias] = safeTargets;
  }
  return result;
}

export function toDashboardConfigPayload(config: ProxyConfig): DashboardConfigPayload {
  const models: Record<string, DashboardModelCategoryConfig> = {};

  if (config.models) {
    for (const [categoryName, categoryConfig] of Object.entries(config.models)) {
      if (Array.isArray(categoryConfig)) {
        continue;
      }
      models[categoryName] = sanitizeDashboardCategoryConfig(categoryConfig);
    }
  }

  return {
    models,
    composite: sanitizeCompositeConfig(config.composite),
  };
}

function isSafeModelArray(value: unknown): value is DashboardModelArrayConfig {
  if (!Array.isArray(value) || value.length < 2) {
    return false;
  }
  return typeof value[0] === 'string' && typeof value[1] === 'string';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateAndNormalizeComposite(payload: unknown): Record<string, CompositeModelConfig> {
  if (!isPlainObject(payload)) {
    throw new Error('Invalid composite payload');
  }

  const result: Record<string, CompositeModelConfig> = {};
  for (const [alias, targetValue] of Object.entries(payload)) {
    if (!isPlainObject(targetValue)) {
      throw new Error(`Invalid composite targets for alias: ${alias}`);
    }

    const targetConfig: CompositeModelConfig = {};
    for (const [targetModel, rawConfig] of Object.entries(targetValue)) {
      if (!isPlainObject(rawConfig)) {
        throw new Error(`Invalid composite target config for: ${alias}.${targetModel}`);
      }

      const entry: CompositeTargetConfig = {};
      if ('share' in rawConfig) {
        if (typeof rawConfig.share !== 'number' || !Number.isFinite(rawConfig.share)) {
          throw new Error(`Invalid share for: ${alias}.${targetModel}`);
        }
        entry.share = rawConfig.share;
      }
      if ('primary' in rawConfig) {
        if (typeof rawConfig.primary !== 'boolean') {
          throw new Error(`Invalid primary for: ${alias}.${targetModel}`);
        }
        entry.primary = rawConfig.primary;
      }
      if ('fallback' in rawConfig) {
        if (typeof rawConfig.fallback !== 'number' || !Number.isFinite(rawConfig.fallback)) {
          throw new Error(`Invalid fallback for: ${alias}.${targetModel}`);
        }
        entry.fallback = rawConfig.fallback;
      }

      targetConfig[targetModel] = entry;
    }

    result[alias] = targetConfig;
  }

  return result;
}

function validateAndNormalizeDashboardModels(payload: unknown): Record<string, DashboardModelCategoryConfig> {
  if (!isPlainObject(payload)) {
    throw new Error('Invalid models payload');
  }

  const result: Record<string, DashboardModelCategoryConfig> = {};

  for (const [categoryName, rawCategory] of Object.entries(payload)) {
    if (!isPlainObject(rawCategory)) {
      throw new Error(`Invalid models category: ${categoryName}`);
    }

    const category: DashboardModelCategoryConfig = {};
    for (const [key, value] of Object.entries(rawCategory)) {
      if (key === 'api_key') {
        throw new Error(`api_key is not editable in dashboard (${categoryName})`);
      }

      if (key === 'upstream_mode' || key === 'base_url') {
        if (typeof value !== 'string') {
          throw new Error(`Invalid value for ${categoryName}.${key}`);
        }
        category[key] = value;
        continue;
      }

      if (typeof value === 'string') {
        category[key] = value;
        continue;
      }

      if (isSafeModelArray(value)) {
        category[key] = [value[0], value[1]];
        continue;
      }

      throw new Error(`Invalid model entry for ${categoryName}.${key}`);
    }

    result[categoryName] = category;
  }

  return result;
}

export function applyDashboardConfigUpdate(baseConfig: ProxyConfig, payload: unknown): ProxyConfig {
  if (!isPlainObject(payload)) {
    throw new Error('Invalid dashboard config payload');
  }

  const modelsPayload = validateAndNormalizeDashboardModels(payload.models);
  const compositePayload = validateAndNormalizeComposite(payload.composite ?? {});

  const nextConfig: ProxyConfig = {
    ...baseConfig,
    models: { ...(baseConfig.models || {}) },
    composite: compositePayload,
  };

  for (const [categoryName, dashboardCategory] of Object.entries(modelsPayload)) {
    const existingCategory = nextConfig.models?.[categoryName];
    const preservedApiKey = !existingCategory || Array.isArray(existingCategory)
      ? undefined
      : existingCategory.api_key;

    const rebuiltCategory: ModelCategoryConfig = {};
    if (dashboardCategory.upstream_mode !== undefined) {
      rebuiltCategory.upstream_mode = dashboardCategory.upstream_mode;
    }
    if (dashboardCategory.base_url !== undefined) {
      rebuiltCategory.base_url = dashboardCategory.base_url;
    }
    if (preservedApiKey !== undefined) {
      rebuiltCategory.api_key = preservedApiKey;
    }

    for (const [key, value] of Object.entries(dashboardCategory)) {
      if (key === 'upstream_mode' || key === 'base_url') {
        continue;
      }

      if (typeof value === 'string') {
        rebuiltCategory[key] = value;
      } else if (Array.isArray(value)) {
        const existingEntry = !existingCategory || Array.isArray(existingCategory)
          ? undefined
          : existingCategory[key];
        const preservedModelApiKey = Array.isArray(existingEntry) ? (existingEntry[2] || '') : '';
        rebuiltCategory[key] = [value[0] || '', value[1] || '', preservedModelApiKey];
      }
    }

    if (!nextConfig.models) {
      nextConfig.models = {};
    }
    nextConfig.models[categoryName] = rebuiltCategory;
  }

  return nextConfig;
}

export function persistProxyConfigToPath(configPath: string, config: ProxyConfig): void {
  const serialized = serializeProxyConfigToml(config);
  writeFileSync(configPath, serialized, 'utf-8');
}

export function loadProxyConfigFromPath(configPath: string): ProxyConfig {
  const content = readFileSync(configPath, 'utf-8');
  return parseSimpleToml(content);
}
