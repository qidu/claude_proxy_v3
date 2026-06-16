/**
 * Proxy configuration loader
 * Loads config from file or URL
 * Compatible with both Node.js and Cloudflare Workers environments
 */

import { Env } from '../types/shared.js';
import { mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, existsSync } from 'fs';
import { homedir } from 'os';
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
    global_token_limit?: string;
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

export type TokenLimitDuration = '1h' | '1d' | '1w' | '1m';

/**
 * Parse a human-readable token limit string into a number.
 * Supports raw numbers ("50000"), whole-number suffixes ("100k", "1.5m"),
 * and suffix-only with multiplier ("k", "m", "b", "t").
 * Examples: "50k 1d" → {num: 50000, duration: "1d"}, "1.5m 1h" → {num: 1500000, duration: "1h"}
 */
export function parseHumanTokenLimit(raw: string): { num: number; duration: TokenLimitDuration } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^([\d.]+)\s*([kKmMbBtT]?)\s+(1[hHdDwWmM])$/);
  if (!match) return null;
  let num = parseFloat(match[1]);
  if (!Number.isFinite(num) || num < 0) return null;
  const suffix = match[2].toLowerCase();
  if (suffix === 'k') num *= 1_000;
  else if (suffix === 'm') num *= 1_000_000;
  else if (suffix === 'b') num *= 1_000_000_000;
  else if (suffix === 't') num *= 1_000_000_000_000;
  if (num < 0 || !Number.isFinite(num)) return null;
  return { num, duration: match[3].toLowerCase() as TokenLimitDuration };
}

/**
 * Format a token limit as a human-readable string.
 * Examples: 50000 → "50k", 1500000 → "1.5m"
 */
export function formatTokenLimit(num: number): string {
  if (num >= 1_000_000_000_000) return (num / 1_000_000_000_000).toFixed(1).replace(/\.0$/, '') + 't';
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'b';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'm';
  if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(num);
}

export interface TokenLimitConfig {
  num: number;
  duration: TokenLimitDuration;
}

export type FusionRole = 'panel' | 'judge' | 'synth';

export interface FusionOptions {
  min_panel?: number;        // min successful panel responses to proceed (default 1)
  panel_timeout_ms?: number; // per-panel-call wall clock ms (default 60000)
  judge_required?: boolean;  // if false, synth runs on raw panel if judge fails (default false)
  expose_metadata?: boolean; // attach fusion_metadata to response (default true)
  max_concurrent?: number;   // max simultaneous panel calls; default = panel size (full fan-out)
}

export interface CompositeTargetConfig {
  share?: number;
  primary?: boolean;
  fallback?: number;
  fusion?: number;           // > 0 marks target as panel member (weight reserved for future use)
  role?: FusionRole;         // explicit stage: 'panel' | 'judge' | 'synth'
}

export interface CompositeModelConfig {
  token_limit?: TokenLimitConfig;
  fusion_options?: FusionOptions;
  [modelName: string]: CompositeTargetConfig | TokenLimitConfig | FusionOptions | undefined;
}

export interface FusionPlan {
  alias: string;
  panel: Array<{ modelName: string; route: ModelRouteConfig }>;
  judge: { modelName: string; route: ModelRouteConfig } | undefined;
  synth: { modelName: string; route: ModelRouteConfig };
  options: Required<FusionOptions>;
}

const COMPOSITE_META_KEYS = new Set(['token_limit', 'fusion_options']);

function getCompositeTargetEntries(config: CompositeModelConfig | undefined): Array<[string, CompositeTargetConfig]> {
  return Object.entries(config || {}).filter(([key]) => !COMPOSITE_META_KEYS.has(key)) as Array<[string, CompositeTargetConfig]>;
}

function getCompositeTokenLimit(config: CompositeModelConfig | undefined): TokenLimitConfig | undefined {
  const limit = config?.token_limit;
  if (!limit || typeof limit !== 'object' || limit === null) return undefined;
  const l = limit as unknown as Record<string, unknown>;
  if (typeof l.num !== 'number' || !Number.isFinite(l.num)) return undefined;
  if (typeof l.duration !== 'string') return undefined;
  if (!(['1h', '1d', '1w', '1m'] as string[]).includes(l.duration)) return undefined;
  return limit as TokenLimitConfig;
}

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
  const resolvedTargets = getCompositeTargetEntries(compositeConfig)
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

  // Filter out targets with share === 0 (they should not be visited via composite)
  const eligible = resolvedTargets.filter((c) => {
    if (c.targetConfig.share === 0) {
      skippedTargets.push(c.targetModelName);
      return false;
    }
    return true;
  });

  if (eligible.length === 0) {
    return { orderedTargets: [], skippedTargets };
  }

  const primaryCandidate = eligible.find((candidate) => candidate.targetConfig.primary);
  const orderedTargets = primaryCandidate
    ? [primaryCandidate, ...eligible.filter((candidate) => candidate !== primaryCandidate)]
    : eligible
        .slice()
        .sort((left, right) => {
          const leftFallback = left.targetConfig.fallback;
          const rightFallback = right.targetConfig.fallback;

          if ((leftFallback !== undefined && leftFallback > 0) || (rightFallback !== undefined && rightFallback > 0)) {
            const normalizedLeft = leftFallback && leftFallback > 0 ? leftFallback : Number.POSITIVE_INFINITY;
            const normalizedRight = rightFallback && rightFallback > 0 ? rightFallback : Number.POSITIVE_INFINITY;
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

  const selectedCandidate = orderedTargets.some(candidate => candidate.targetConfig.primary || (candidate.targetConfig.fallback !== undefined && candidate.targetConfig.fallback > 0))
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
  const hasPriorityOrder = orderedTargets.some(candidate => candidate.targetConfig.primary || (candidate.targetConfig.fallback !== undefined && candidate.targetConfig.fallback > 0));

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

export function getCompositeAliasMode(
  modelName: string,
  proxyConfig: ProxyConfig
): 'fusion' | 'fallback' | 'share' | undefined {
  const compositeConfig = proxyConfig.composite?.[modelName];
  if (!compositeConfig) return undefined;

  const entries = getCompositeTargetEntries(compositeConfig);
  const isFusion = entries.some(([, cfg]) =>
    cfg.role === 'panel' || cfg.role === 'judge' || cfg.role === 'synth' ||
    (typeof cfg.fusion === 'number' && cfg.fusion > 0)
  );
  if (isFusion) return 'fusion';

  const hasPriority = entries.some(([, cfg]) =>
    cfg.primary === true || (typeof cfg.fallback === 'number' && cfg.fallback > 0)
  );
  if (hasPriority) return 'fallback';

  return 'share';
}

export function resolveFusionPlan(
  modelName: string,
  proxyConfig: ProxyConfig
): FusionPlan | undefined {
  const compositeConfig = proxyConfig.composite?.[modelName];
  if (!compositeConfig) return undefined;

  const entries = getCompositeTargetEntries(compositeConfig);

  const panel: Array<{ modelName: string; route: ModelRouteConfig }> = [];
  let judge: { modelName: string; route: ModelRouteConfig } | undefined;
  let synth: { modelName: string; route: ModelRouteConfig } | undefined;

  for (const [targetName, cfg] of entries) {
    const route = resolveModelRouteFromConfig(targetName, proxyConfig) || {
      ...getDefaultModelRoute(proxyConfig),
      modelAlias: targetName,
    };
    const resolvedRoute = { ...route, modelAlias: route.modelAlias || targetName };

    if (cfg.role === 'judge') {
      judge = { modelName: targetName, route: resolvedRoute };
    } else if (cfg.role === 'synth') {
      synth = { modelName: targetName, route: resolvedRoute };
    } else {
      // role === 'panel', or fusion > 0 with no role, or no role/fusion (treated as panel in fusion mode)
      panel.push({ modelName: targetName, route: resolvedRoute });
    }
  }

  if (panel.length === 0) return undefined;

  // Defaults: synth falls back to judge, then first panel
  if (!synth) {
    synth = judge ?? panel[0];
  }

  const rawOpts = compositeConfig.fusion_options as FusionOptions | undefined;
  const options: Required<FusionOptions> = {
    min_panel: rawOpts?.min_panel ?? 1,
    panel_timeout_ms: rawOpts?.panel_timeout_ms ?? 60000,
    judge_required: rawOpts?.judge_required ?? false,
    expose_metadata: rawOpts?.expose_metadata ?? true,
    max_concurrent: rawOpts?.max_concurrent ?? panel.length,
  };

  return { alias: modelName, panel, judge, synth, options };
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
    const trimmed = field.trim().replace(/^,/, '').replace(/,$/, '');
    if (!trimmed) {
      continue;
    }

    const match = trimmed.match(/^"?([^"=]+)"?\s*:\s*(.+)$/);
    if (!match) {
      continue;
    }

    const key = match[1].trim().replace(/^"|"$/g, '');
    const rawValue = match[2].trim().replace(/,$/, '');

    if (key === 'share') {
      const numeric = Number(rawValue);
      if (!Number.isNaN(numeric) && numeric >= 0) {
        (config as any).share = numeric;
      } else if (rawValue !== '') {
        (config as any)._invalidShare = true;
      }
      continue;
    }

    if (key === 'fallback') {
      const numeric = Number(rawValue);
      if (!Number.isNaN(numeric) && numeric >= 0) {
        (config as any).fallback = numeric;
      } else if (rawValue !== '') {
        (config as any)._invalidFallback = true;
      }
      continue;
    }

    if (key === 'primary') {
      if (rawValue === 'true') {
        config.primary = true;
      } else if (rawValue === 'false') {
        config.primary = false;
      } else {
        (config as any)._invalidPrimary = true;
      }
      continue;
    }

    if (key === 'fusion') {
      const numeric = Number(rawValue);
      if (!Number.isNaN(numeric) && numeric >= 0) {
        (config as any).fusion = numeric;
      } else if (rawValue !== '') {
        (config as any)._invalidFusion = true;
      }
      continue;
    }

    if (key === 'role') {
      const v = rawValue.replace(/^"|"$/g, '');
      if (v === 'panel' || v === 'judge' || v === 'synth') {
        (config as any).role = v;
      } else {
        (config as any)._invalidRole = true;
      }
      continue;
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
    if (match) {
      if (match[1] === 'fusion_options') {
        // Parse fusion_options object: {min_panel, panel_timeout_ms, judge_required, expose_metadata, max_concurrent}
        try {
          const inner = match[2].trim().slice(1, -1);
          const opts: FusionOptions = {};
          const fields: string[] = [];
          let cur = ''; let d = 0; let iq = false;
          for (let i = 0; i < inner.length; i++) {
            const c = inner[i];
            if (c === '"') { iq = !iq; cur += c; continue; }
            if (!iq) { if (c === '{') d++; else if (c === '}') d--; else if (c === ',' && d === 0) { if (cur.trim()) fields.push(cur.trim()); cur = ''; continue; } }
            cur += c;
          }
          if (cur.trim()) fields.push(cur.trim());
          for (const f of fields) {
            const kv = f.match(/^"?(\w+)"?\s*[=:]\s*(.+)$/);
            if (!kv) continue;
            const k = kv[1]; const rv = kv[2].trim().replace(/,$/, '').replace(/^"|"$/g, '');
            if (k === 'min_panel' || k === 'panel_timeout_ms' || k === 'max_concurrent') {
              const n = Number(rv); if (Number.isFinite(n) && n >= 0) (opts as any)[k] = n;
            } else if (k === 'judge_required' || k === 'expose_metadata') {
              if (rv === 'true') (opts as any)[k] = true;
              else if (rv === 'false') (opts as any)[k] = false;
            }
          }
          config.fusion_options = opts;
        } catch { /* ignore malformed fusion_options */ }
      } else if (match[1] === 'token_limit') {
        // Parse the nested token_limit object: {num = ..., duration = "..."} or {"num": ..., "duration": "..."}
        const inner = match[2].trim().slice(1, -1);
        const fields: string[] = [];
        let current = '';
        let depth = 0;
        let inQuotes = false;
        // Quote-aware split by comma (handles both JSON-style {"num": 50000} and TOML-style {num = 50000})
        for (let i = 0; i < inner.length; i++) {
          const char = inner[i];
          if (char === '"') { inQuotes = !inQuotes; current += char; continue; }
          if (!inQuotes) {
            if (char === '{') { depth += 1; } else if (char === '}') { depth -= 1; } else if (char === ',' && depth === 0) {
              if (current.trim()) fields.push(current.trim());
              current = ''; continue;
            }
          }
          current += char;
        }
        if (current.trim()) fields.push(current.trim());
        let num: number | undefined;
        let duration: string | undefined;
        for (const field of fields) {
          // Support both JSON-style "num": 50000 and TOML-style num = 50000
          const numMatch = field.match(/^"?num"?\s*[=:]\s*([\d.]+)/);
          if (numMatch) { const n = Number(numMatch[1]); if (Number.isFinite(n) && n >= 0) num = n; }
          // Support both JSON-style "duration": "1d" and TOML-style duration = "1d"
          const durMatch = field.match(/^"?duration"?\s*[=:]\s*"([^"]+)"/);
          if (durMatch) { duration = durMatch[1]; }
        }
        if (num !== undefined && duration !== undefined && ['1h', '1d', '1w', '1m'].includes(duration)) {
          config.token_limit = { num, duration: duration as TokenLimitDuration };
        } else {
          (config as any)._invalidLimit = true;
        }
      } else {
        config[match[1]] = parseCompositeTargetConfig(match[2]);
      }
      continue;
    }

    // Backwards compatibility: parse old "total_token_limit" as number
    const limitMatch = entry.match(/^"?(total_token_limit)"?\s*:\s*(.+)$/);
    if (limitMatch) {
      const numeric = Number(limitMatch[2].trim().replace(/,$/, ''));
      if (!Number.isNaN(numeric) && numeric >= 0) {
        // Treat as token_limit with a synthetic duration (stored as-is for migration)
        (config as any).token_limit = { num: numeric, duration: '1m' as TokenLimitDuration };
      } else {
        (config as any)._invalidLimit = true;
      }
    }
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
  if (config.fusion !== undefined) {
    fields.push(`"fusion": ${config.fusion}`);
  }
  if (config.role !== undefined) {
    fields.push(`"role": "${config.role}"`);
  }
  return `{${fields.join(', ')}}`;
}

function serializeFusionOptions(opts: FusionOptions): string {
  const fields: string[] = [];
  if (opts.min_panel !== undefined) fields.push(`"min_panel": ${opts.min_panel}`);
  if (opts.panel_timeout_ms !== undefined) fields.push(`"panel_timeout_ms": ${opts.panel_timeout_ms}`);
  if (opts.judge_required !== undefined) fields.push(`"judge_required": ${opts.judge_required}`);
  if (opts.expose_metadata !== undefined) fields.push(`"expose_metadata": ${opts.expose_metadata}`);
  if (opts.max_concurrent !== undefined) fields.push(`"max_concurrent": ${opts.max_concurrent}`);
  return `{${fields.join(', ')}}`;
}

function serializeCompositeModelConfig(config: CompositeModelConfig): string {
  const entries: string[] = [];
  if (config.token_limit && typeof config.token_limit === 'object') {
    entries.push(`"token_limit": {num = ${config.token_limit.num}, duration = ${JSON.stringify(config.token_limit.duration)}}`);
  }
  if (config.fusion_options && typeof config.fusion_options === 'object') {
    entries.push(`"fusion_options": ${serializeFusionOptions(config.fusion_options as FusionOptions)}`);
  }
  for (const [modelName, targetConfig] of getCompositeTargetEntries(config)) {
    const serializedTarget = serializeCompositeTargetConfig((targetConfig || {}) as CompositeTargetConfig);
    entries.push(`${JSON.stringify(modelName)}: ${serializedTarget}`);
  }
  return `{${entries.join(', ')}}`;
}

/**
 * Config validation
 */
export interface ConfigValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  errors: ConfigValidationError[];
  valid: boolean;
}

export function validateProxyConfig(config: ProxyConfig): ValidationResult {
  const errors: ConfigValidationError[] = [];
  const reservedKeys = new Set(['upstream_mode', 'base_url', 'api_key']);

  if (config.models) {
    for (const [categoryName, categoryConfig] of Object.entries(config.models)) {
      if (categoryName === 'list' || Array.isArray(categoryConfig)) {
        continue;
      }
      const typedCategory = categoryConfig as Record<string, unknown>;
      const categoryBaseUrl = typeof typedCategory.base_url === 'string' ? typedCategory.base_url : undefined;
      const categoryApiKey = typeof typedCategory.api_key === 'string' ? typedCategory.api_key : undefined;

      for (const [key, value] of Object.entries(categoryConfig)) {
        if (reservedKeys.has(key)) continue;
        if (value === undefined) continue;

        if (!Array.isArray(value)) {
          errors.push({ path: `models.${categoryName}.${key}`, message: `must be [target, base_url, api_key]` });
          continue;
        }
        if (value.length === 1) {
          // 1 element = target only (base_url/api_key from category)
          const target = value[0] as unknown;
          if (typeof target !== 'string' || target.trim() === '') {
            errors.push({ path: `models.${categoryName}.${key}`, message: `target cannot be empty` });
          }
          if (!categoryBaseUrl && !categoryApiKey) {
            errors.push({ path: `models.${categoryName}.${key}`, message: `base_url and api_key must be set in category when target is the only element` });
          }
        } else if (value.length === 3) {
          // 3 elements = target + optional overrides (empty = use category fallback)
          const target = value[0] as unknown;
          const baseUrl = value[1] as unknown;
          const apiKey = value[2] as unknown;

          if (typeof target !== 'string' || target.trim() === '') {
            errors.push({ path: `models.${categoryName}.${key}`, message: `target cannot be empty` });
          }
          if (typeof baseUrl !== 'string') {
            errors.push({ path: `models.${categoryName}.${key}`, message: `base_url must be a string` });
          } else if (baseUrl.trim() === '' && !categoryBaseUrl) {
            errors.push({ path: `models.${categoryName}.${key}`, message: `base_url is empty and not set in category` });
          }
          if (typeof apiKey !== 'string') {
            errors.push({ path: `models.${categoryName}.${key}`, message: `api_key must be a string` });
          } else if (apiKey.trim() === '' && !categoryApiKey && categoryName !== 'default') {
            errors.push({ path: `models.${categoryName}.${key}`, message: `api_key is empty and not set in category` });
          }
        } else {
          errors.push({ path: `models.${categoryName}.${key}`, message: `must be [target] or [target, base_url, api_key] (got ${value.length} elements)` });
        }
      }
    }
  }

  if (config.composite) {
    for (const [alias, targets] of Object.entries(config.composite)) {
      if (!targets || typeof targets !== 'object') {
        errors.push({ path: `composite.${alias}`, message: `invalid composite config` });
        continue;
      }
      if ('_invalidLimit' in (targets as Record<string, unknown>)) {
        errors.push({ path: `composite.${alias}.token_limit`, message: `token_limit must be {num: <number>, duration: "1h"|"1d"|"1w"|"1m"}` });
      }
      for (const [targetModel, targetValue] of Object.entries(targets)) {
        if (targetModel.startsWith('_')) continue; // skip internal markers
        if (targetModel === 'token_limit') continue; // validated separately above
        if (!targetValue || typeof targetValue !== 'object' || Array.isArray(targetValue)) {
          errors.push({ path: `composite.${alias}.${targetModel}`, message: `invalid target config` });
          continue;
        }
        const typedTarget = targetValue as Record<string, unknown>;
        if ('_invalidShare' in typedTarget) {
          errors.push({ path: `composite.${alias}.${targetModel}`, message: `share must be a number` });
        }
        if ('_invalidPrimary' in typedTarget) {
          errors.push({ path: `composite.${alias}.${targetModel}`, message: `primary must be boolean` });
        }
        if ('_invalidFallback' in typedTarget) {
          errors.push({ path: `composite.${alias}.${targetModel}`, message: `fallback must be a number` });
        }
      }
    }
  }

  return { errors, valid: errors.length === 0 };
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
      const validation = validateProxyConfig(config);
      for (const err of validation.errors) {
        console.error(`[ERROR] ${err.path}: ${err.message}`);
      }
      (config as unknown as { _validationErrors?: ConfigValidationError[] })._validationErrors = validation.errors;
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
    // Note: allow an empty object {} (newly added alias with no targets yet) by
    // using .* instead of .+ so the alias is preserved on round-trip.
    const compositeObjectMatch = trimmed.match(/^"?([^"=]+)"?\s*=\s*(\{.*\})$/);
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
      // Always push the last element (even if empty string like "")
      elements.push(current.trim().replace(/^"|"$/g, ''));

      if (currentSection === 'models' && currentCategory && config.models) {
        const category = config.models[currentCategory] as ModelCategoryConfig;
        // Store raw array (1-3 elements), no padding
        category[cleanKey] = elements as [string, string, string];
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

  // Validate config and log errors
  const validation = validateProxyConfig(config);
  for (const err of validation.errors) {
    console.error(`[ERROR] ${err.path}: ${err.message}`);
  }
  (config as unknown as { _validationErrors?: ConfigValidationError[] })._validationErrors = validation.errors;

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
  config_errors: ConfigValidationError[];
  global_token_limit?: string;
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
    const aliasLimit = getCompositeTokenLimit(targets as CompositeModelConfig);
    if (aliasLimit !== undefined) {
      safeTargets.token_limit = aliasLimit;
    }

    // Preserve fusion_options
    const rawFusionOpts = (targets as CompositeModelConfig).fusion_options;
    if (rawFusionOpts && typeof rawFusionOpts === 'object' && !Array.isArray(rawFusionOpts)) {
      const fo = rawFusionOpts as Record<string, unknown>;
      const opts: FusionOptions = {};
      if (typeof fo.min_panel === 'number') opts.min_panel = fo.min_panel;
      if (typeof fo.panel_timeout_ms === 'number') opts.panel_timeout_ms = fo.panel_timeout_ms;
      if (typeof fo.judge_required === 'boolean') opts.judge_required = fo.judge_required;
      if (typeof fo.expose_metadata === 'boolean') opts.expose_metadata = fo.expose_metadata;
      if (typeof fo.max_concurrent === 'number') opts.max_concurrent = fo.max_concurrent;
      safeTargets.fusion_options = opts;
    }

    for (const [targetModel, config] of Object.entries(targets || {})) {
      if (COMPOSITE_META_KEYS.has(targetModel)) {
        continue;
      }
      if (targetModel.startsWith('_')) {
        continue; // skip internal validation markers
      }

      // Only process CompositeTargetConfig (skip TokenLimitConfig / FusionOptions objects)
      if (typeof config !== 'object' || config === null || Array.isArray(config)) {
        continue;
      }
      const targetCfg = config as Record<string, unknown>;
      if ('num' in targetCfg && 'duration' in targetCfg) {
        // This is a TokenLimitConfig, not a target model — skip
        continue;
      }
      if ('min_panel' in targetCfg || 'panel_timeout_ms' in targetCfg) {
        // This is a FusionOptions block — skip
        continue;
      }

      const safeTarget: CompositeTargetConfig = {};
      if (typeof targetCfg.share === 'number' && Number.isFinite(targetCfg.share)) {
        safeTarget.share = targetCfg.share;
      }
      if (typeof targetCfg.primary === 'boolean') {
        safeTarget.primary = targetCfg.primary;
      }
      if (typeof targetCfg.fallback === 'number' && Number.isFinite(targetCfg.fallback)) {
        safeTarget.fallback = targetCfg.fallback;
      }
      if (typeof targetCfg.fusion === 'number' && Number.isFinite(targetCfg.fusion)) {
        safeTarget.fusion = targetCfg.fusion;
      }
      if (targetCfg.role === 'panel' || targetCfg.role === 'judge' || targetCfg.role === 'synth') {
        safeTarget.role = targetCfg.role as FusionRole;
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
    config_errors: (config as unknown as { _validationErrors?: ConfigValidationError[] })._validationErrors ?? [],
    global_token_limit: config.upstream?.global_token_limit,
  };
}

function isSafeModelArray(value: unknown): value is DashboardModelArrayConfig {
  // Accept 1 or 3 elements only. Dashboard GET returns 2-element arrays (api_key
  // stripped), but PUT callers must normalize to 1 or 3 elements before sending
  // (see TC1214 which does this explicitly). Rejecting 2-element arrays here
  // ensures TC1204 passes and prevents ambiguous round-trips.
  if (!Array.isArray(value) || (value.length !== 1 && value.length !== 3)) {
    return false;
  }
  return typeof value[0] === 'string' && value[0].trim() !== '';
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
    for (const [key, rawValue] of Object.entries(targetValue)) {
      if (key === 'fusion_options') {
        if (!isPlainObject(rawValue)) throw new Error(`Invalid fusion_options for alias: ${alias}`);
        const fo = rawValue as Record<string, unknown>;
        const opts: FusionOptions = {};
        if ('min_panel' in fo) { if (typeof fo.min_panel !== 'number') throw new Error(`Invalid fusion_options.min_panel for: ${alias}`); opts.min_panel = fo.min_panel; }
        if ('panel_timeout_ms' in fo) { if (typeof fo.panel_timeout_ms !== 'number') throw new Error(`Invalid fusion_options.panel_timeout_ms for: ${alias}`); opts.panel_timeout_ms = fo.panel_timeout_ms; }
        if ('judge_required' in fo) { if (typeof fo.judge_required !== 'boolean') throw new Error(`Invalid fusion_options.judge_required for: ${alias}`); opts.judge_required = fo.judge_required; }
        if ('expose_metadata' in fo) { if (typeof fo.expose_metadata !== 'boolean') throw new Error(`Invalid fusion_options.expose_metadata for: ${alias}`); opts.expose_metadata = fo.expose_metadata; }
        if ('max_concurrent' in fo) { if (typeof fo.max_concurrent !== 'number' || fo.max_concurrent < 1) throw new Error(`Invalid fusion_options.max_concurrent for: ${alias} — must be >= 1`); opts.max_concurrent = fo.max_concurrent; }
        targetConfig.fusion_options = opts;
        continue;
      }
      if (key === 'token_limit') {
        // Support both new format {num, duration} and old format (number)
        if (typeof rawValue === 'object' && rawValue !== null && !Array.isArray(rawValue)) {
          const obj = rawValue as Record<string, unknown>;
          if (typeof obj.num !== 'number' || !Number.isFinite(obj.num)) {
            throw new Error(`Invalid token_limit.num for alias: ${alias}`);
          }
          if (typeof obj.duration !== 'string' || !(['1h', '1d', '1w', '1m'] as string[]).includes(obj.duration)) {
            throw new Error(`Invalid token_limit.duration for alias: ${alias} — must be 1h, 1d, 1w, or 1m`);
          }
          targetConfig.token_limit = { num: obj.num, duration: obj.duration as TokenLimitDuration };
        } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
          // Backwards compat: old number-only format → treat as 30d
          targetConfig.token_limit = { num: rawValue, duration: '1m' as TokenLimitDuration };
        } else {
          throw new Error(`Invalid token_limit for alias: ${alias}`);
        }
        continue;
      }
      if (key === 'total_token_limit') {
        // Backwards compat: old format → treat as 30d
        if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
          targetConfig.token_limit = { num: rawValue, duration: '1m' as TokenLimitDuration };
        } else {
          throw new Error(`Invalid total_token_limit for alias: ${alias}`);
        }
        continue;
      }

      if (!isPlainObject(rawValue)) {
        throw new Error(`Invalid composite target config for: ${alias}.${key}`);
      }

      const entry: CompositeTargetConfig = {};
      if ('share' in rawValue) {
        if (typeof rawValue.share !== 'number' || !Number.isFinite(rawValue.share)) {
          throw new Error(`Invalid share for: ${alias}.${key}`);
        }
        entry.share = rawValue.share;
      }
      if ('primary' in rawValue) {
        if (typeof rawValue.primary !== 'boolean') {
          throw new Error(`Invalid primary for: ${alias}.${key}`);
        }
        entry.primary = rawValue.primary;
      }
      if ('fallback' in rawValue) {
        if (typeof rawValue.fallback !== 'number' || !Number.isFinite(rawValue.fallback)) {
          throw new Error(`Invalid fallback for: ${alias}.${key}`);
        }
        entry.fallback = rawValue.fallback;
      }
      if ('fusion' in rawValue) {
        if (typeof rawValue.fusion !== 'number' || !Number.isFinite(rawValue.fusion)) {
          throw new Error(`Invalid fusion for: ${alias}.${key}`);
        }
        entry.fusion = rawValue.fusion;
      }
      if ('role' in rawValue) {
        if (rawValue.role !== 'panel' && rawValue.role !== 'judge' && rawValue.role !== 'synth') {
          throw new Error(`Invalid role for: ${alias}.${key} — must be 'panel', 'judge', or 'synth'`);
        }
        entry.role = rawValue.role as FusionRole;
      }

      targetConfig[key] = entry;
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
        // Pass through raw array (1-3 elements) so it gets re-validated
        // but trimmed to 2 for display since api_key is hidden
        category[key] = value.slice(0, 2) as DashboardModelArrayConfig;
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

export interface CompositeTargetPatch {
  share?: number | null;
  fallback?: number | null;
  primary?: boolean;
  fusion?: number | null;
  role?: FusionRole | null;
}

function cloneCompositeConfig(composite: ProxyConfig['composite']): Record<string, CompositeModelConfig> {
  const nextComposite: Record<string, CompositeModelConfig> = {};

  for (const [alias, targets] of Object.entries(composite || {})) {
    const nextTargets: CompositeModelConfig = {};
    if (targets && typeof targets === 'object' && !Array.isArray(targets)) {
      const aliasLimit = getCompositeTokenLimit(targets as CompositeModelConfig);
      if (aliasLimit !== undefined) {
        nextTargets.token_limit = aliasLimit;
      }
      const fusionOpts = (targets as CompositeModelConfig).fusion_options;
      if (fusionOpts && typeof fusionOpts === 'object') {
        nextTargets.fusion_options = { ...(fusionOpts as FusionOptions) };
      }
      for (const [targetModel, config] of Object.entries(targets as Record<string, unknown>)) {
        if (COMPOSITE_META_KEYS.has(targetModel)) {
          continue;
        }
        if (targetModel.startsWith('_')) {
          continue; // skip internal validation markers
        }
        if (config && typeof config === 'object' && !Array.isArray(config)) {
          nextTargets[targetModel] = { ...(config as Record<string, unknown>) } as CompositeTargetConfig;
        }
      }
    }
    nextComposite[alias] = nextTargets;
  }

  return nextComposite;
}

function assertNonEmptyCompositeName(kind: 'alias' | 'target model', value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${kind} is required`);
  }
  return trimmed;
}

export function addCompositeAlias(baseConfig: ProxyConfig, alias: string): ProxyConfig {
  const aliasName = assertNonEmptyCompositeName('alias', alias);
  const nextConfig: ProxyConfig = {
    ...baseConfig,
    composite: cloneCompositeConfig(baseConfig.composite),
  };

  if (nextConfig.composite?.[aliasName]) {
    throw new Error(`Composite alias already exists: ${aliasName}`);
  }

  nextConfig.composite ??= {};
  nextConfig.composite[aliasName] = {};
  return nextConfig;
}

export function removeCompositeAlias(baseConfig: ProxyConfig, alias: string): ProxyConfig {
  const aliasName = assertNonEmptyCompositeName('alias', alias);
  const nextConfig: ProxyConfig = {
    ...baseConfig,
    composite: cloneCompositeConfig(baseConfig.composite),
  };

  if (!nextConfig.composite?.[aliasName]) {
    throw new Error(`Composite alias not found: ${aliasName}`);
  }

  delete nextConfig.composite[aliasName];
  return nextConfig;
}

export function upsertCompositeAliasLimit(
  baseConfig: ProxyConfig,
  alias: string,
  tokenLimit: { num: number; duration: string } | null
): ProxyConfig {
  const aliasName = assertNonEmptyCompositeName('alias', alias);
  const nextConfig: ProxyConfig = {
    ...baseConfig,
    composite: cloneCompositeConfig(baseConfig.composite),
  };

  const existingTargets = nextConfig.composite?.[aliasName];
  if (!existingTargets) {
    throw new Error(`Composite alias not found: ${aliasName}`);
  }

  if (tokenLimit === null) {
    delete existingTargets.token_limit;
  } else {
    const num = Number(tokenLimit.num);
    const duration = tokenLimit.duration;
    if (!Number.isFinite(num)) {
      throw new Error(`Invalid token limit num for ${aliasName}`);
    }
    if (!(['1h', '1d', '1w', '1m'] as string[]).includes(duration)) {
      throw new Error(`Invalid token limit duration for ${aliasName} — must be 1h, 1d, 1w, or 1m`);
    }
    existingTargets.token_limit = { num, duration: duration as TokenLimitDuration };
  }

  return nextConfig;
}

export function upsertGlobalTokenLimit(
  baseConfig: ProxyConfig,
  rawLimit: string | null,
): ProxyConfig {
  const nextConfig: ProxyConfig = {
    ...baseConfig,
    upstream: { ...baseConfig.upstream },
  };
  if (rawLimit === null || rawLimit.trim() === '') {
    delete nextConfig.upstream!.global_token_limit;
  } else {
    nextConfig.upstream!.global_token_limit = rawLimit.trim();
  }
  return nextConfig;
}

export function upsertFusionOptions(
  baseConfig: ProxyConfig,
  alias: string,
  options: FusionOptions | null,
): ProxyConfig {
  const aliasName = assertNonEmptyCompositeName('alias', alias);
  const nextConfig: ProxyConfig = {
    ...baseConfig,
    composite: cloneCompositeConfig(baseConfig.composite),
  };

  const existingTargets = nextConfig.composite?.[aliasName];
  if (!existingTargets) {
    throw new Error(`Composite alias not found: ${aliasName}`);
  }

  if (options === null) {
    delete existingTargets.fusion_options;
  } else {
    existingTargets.fusion_options = { ...(existingTargets.fusion_options ?? {}), ...options };
  }

  return nextConfig;
}

export function upsertCompositeTarget(
  baseConfig: ProxyConfig,
  alias: string,
  targetModel: string,
  patch: CompositeTargetPatch = {},
  configuredModelIds: string[] = [],
): ProxyConfig {
  const aliasName = assertNonEmptyCompositeName('alias', alias);
  const targetName = assertNonEmptyCompositeName('target model', targetModel);
  const nextConfig: ProxyConfig = {
    ...baseConfig,
    composite: cloneCompositeConfig(baseConfig.composite),
  };

  nextConfig.composite ??= {};
  const existingTargets = nextConfig.composite[aliasName] ?? {};
  const targetExists = !!existingTargets[targetName];
  if (!targetExists && configuredModelIds.length > 0 && !configuredModelIds.includes(targetName)) {
    throw new Error(`Unknown target model: ${targetName}`);
  }

  const nextTargets: CompositeModelConfig = {};
  const existingLimit = getCompositeTokenLimit(existingTargets);
  if (existingLimit !== undefined) {
    nextTargets.token_limit = existingLimit;
  }
  for (const [name, config] of Object.entries(existingTargets)) {
    if (name === 'token_limit') {
      continue;
    }
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      nextTargets[name] = { ...(config as Record<string, unknown>) } as CompositeTargetConfig;
    }
  }

  const currentTarget = nextTargets[targetName];
  const nextTarget: CompositeTargetConfig = (currentTarget && typeof currentTarget === 'object' && !Array.isArray(currentTarget))
    ? { ...(currentTarget as Record<string, unknown>) } as CompositeTargetConfig
    : {};

  if (patch.share !== undefined) {
    if (patch.share === null) {
      delete nextTarget.share;
    } else if (!Number.isFinite(patch.share)) {
      throw new Error(`Invalid share for ${aliasName}.${targetName}`);
    } else {
      nextTarget.share = patch.share;
    }
  }

  if (patch.fallback !== undefined) {
    if (patch.fallback === null || patch.fallback === 0) {
      delete nextTarget.fallback;
    } else if (!Number.isFinite(patch.fallback)) {
      throw new Error(`Invalid fallback for ${aliasName}.${targetName}`);
    } else {
      nextTarget.fallback = patch.fallback;
    }
  }

  if (patch.primary === true) {
    for (const [name, config] of Object.entries(nextTargets)) {
      // Skip token_limit and non-object configs; also skip if it has 'num'/'duration' (TokenLimitConfig)
      if (name === 'token_limit' || !config || typeof config !== 'object' || Array.isArray(config)) {
        continue;
      }
      const cfg = config as Record<string, unknown>;
      if ('num' in cfg || 'duration' in cfg) continue; // TokenLimitConfig
      delete cfg.primary;
    }
    nextTarget.primary = true;
    nextTarget.fallback = 0;
  } else if (patch.primary === false) {
    delete nextTarget.primary;
  }

  if (patch.fusion !== undefined) {
    if (patch.fusion === null || patch.fusion === 0) {
      delete nextTarget.fusion;
    } else if (!Number.isFinite(patch.fusion) || patch.fusion < 0) {
      throw new Error(`Invalid fusion weight for ${aliasName}.${targetName}`);
    } else {
      nextTarget.fusion = patch.fusion;
    }
  }

  if (patch.role !== undefined) {
    if (patch.role === null) {
      delete nextTarget.role;
    } else if (!(['panel', 'judge', 'synth'] as string[]).includes(patch.role)) {
      throw new Error(`Invalid role for ${aliasName}.${targetName} — must be panel, judge, or synth`);
    } else {
      nextTarget.role = patch.role;
    }
  }

  nextTargets[targetName] = nextTarget;
  nextConfig.composite[aliasName] = nextTargets;
  return nextConfig;
}

export function removeCompositeTarget(baseConfig: ProxyConfig, alias: string, targetModel: string): ProxyConfig {
  const aliasName = assertNonEmptyCompositeName('alias', alias);
  const targetName = assertNonEmptyCompositeName('target model', targetModel);
  const nextConfig: ProxyConfig = {
    ...baseConfig,
    composite: cloneCompositeConfig(baseConfig.composite),
  };

  const existingTargets = nextConfig.composite?.[aliasName];
  if (!existingTargets) {
    throw new Error(`Composite alias not found: ${aliasName}`);
  }
  if (!existingTargets[targetName]) {
    throw new Error(`Composite target not found: ${aliasName}.${targetName}`);
  }

  delete existingTargets[targetName];
  return nextConfig;
}

export function persistProxyConfigToPath(configPath: string, config: ProxyConfig): void {
  const serialized = serializeProxyConfigToml(config);

  // Integrity check: the serialized form must round-trip back to the same
  // composite/model structure. A lossy serialize would otherwise silently
  // erase config (e.g. composite aliases) on the next reload.
  const reparsed = parseSimpleToml(serialized);
  const expectedComposite = Object.keys(config.composite || {}).sort();
  const actualComposite = Object.keys(reparsed.composite || {}).sort();
  if (expectedComposite.length !== actualComposite.length ||
      expectedComposite.some((k, i) => k !== actualComposite[i])) {
    throw new Error(
      `Config serialization integrity check failed: composite aliases changed on round-trip ` +
      `(expected [${expectedComposite.join(', ')}], got [${actualComposite.join(', ')}])`
    );
  }

  // Atomic write: write to a temp file, back up the existing config, then rename.
  const tempPath = `${configPath}.tmp`;
  writeFileSync(tempPath, serialized, 'utf-8');
  if (existsSync(configPath)) {
    copyFileSync(configPath, `${configPath}.bak`);
  }
  renameSync(tempPath, configPath);
}

export function loadProxyConfigFromPath(configPath: string): ProxyConfig {
  const content = readFileSync(configPath, 'utf-8');
  return parseSimpleToml(content);
}

export interface OpenClawProviderModelConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  [key: string]: unknown;
}

export interface OpenClawProviderConfig {
  id: string;
  baseUrl?: string;
  apiKey?: string;
  apiSchema?: 'anthropic-messages' | 'openai-completions';
  models?: OpenClawProviderModelConfig[];
  [key: string]: unknown;
}

export interface OpenClawConfig {
  models?: {
    providers?: OpenClawProviderConfig[];
    [key: string]: unknown;
  };
  agents?: {
    defaults?: {
      models?: string[];
      model?: {
        primary?: string;
        fallback?: string;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export const DEFAULT_OPENCLAW_CONFIG_PATH = join(homedir(), '.openclaw', 'openclaw.json');

export function resolveOpenClawConfigPath(configPath?: string | null): string {
  const trimmed = configPath?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_OPENCLAW_CONFIG_PATH;
}

export function loadOpenClawConfigFromPath(configPath = DEFAULT_OPENCLAW_CONFIG_PATH): OpenClawConfig {
  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content);
    return isPlainObject(parsed) ? (parsed as OpenClawConfig) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

export function persistOpenClawConfigToPath(configPath: string, config: OpenClawConfig): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}
