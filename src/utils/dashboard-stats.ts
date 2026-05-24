type UsageStats = {
  input_tokens?: number;
  cached_tokens?: number;
  cache_writen_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

type ModelStatsEntry = {
  model: string;
  requests: number;
  input_tokens: number;
  cached_tokens: number;
  cache_writen_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

type AgentStatsEntry = {
  key: string;
  requests: number;
};

type RequestEndpointStatsEntry = {
  endpoint: string;
  requests: number;
};

type RequestUpstreamStatsEntry = {
  upstream_base_url: string;
  responses: number;
};

type RequestStatusCodeStatsEntry = {
  status_code: number;
  responses: number;
};

const modelStats = new Map<string, ModelStatsEntry>();
const agentStats = new Map<string, AgentStatsEntry>();
const requestEndpointStats = new Map<string, RequestEndpointStatsEntry>();
const requestUpstreamStats = new Map<string, RequestUpstreamStatsEntry>();
const requestStatusCodeToEndpointStats = new Map<number, RequestStatusCodeStatsEntry>();
const requestStatusCodeFromUpstreamStats = new Map<number, RequestStatusCodeStatsEntry>();

function toSafeNumber(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0;
  }
  return value;
}

export function extractUserAgentPrefix(userAgent: string | null): string {
  if (!userAgent) {
    return 'unknown';
  }

  const firstToken = userAgent.trim().split(/\s+/)[0] || '';
  if (!firstToken) {
    return 'unknown';
  }

  const slashIndex = firstToken.indexOf('/');
  if (slashIndex <= 0) {
    return firstToken.toLowerCase();
  }

  return firstToken.slice(0, slashIndex).toLowerCase();
}

export function extractToolNamesFromBody(body: Record<string, unknown> | undefined): string[] {
  if (!body) {
    return ['none'];
  }

  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    return ['none'];
  }

  const names = new Set<string>();
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') {
      continue;
    }

    const claudeToolName = (tool as Record<string, unknown>).name;
    if (typeof claudeToolName === 'string' && claudeToolName.trim()) {
      names.add(claudeToolName.trim());
      continue;
    }

    const openAiFunction = (tool as Record<string, unknown>).function;
    if (openAiFunction && typeof openAiFunction === 'object') {
      const openAiName = (openAiFunction as Record<string, unknown>).name;
      if (typeof openAiName === 'string' && openAiName.trim()) {
        names.add(openAiName.trim());
      }
    }
  }

  return names.size > 0 ? [...names] : ['none'];
}

export function extractUsageFromResponsePayload(payload: unknown): UsageStats | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const root = payload as Record<string, unknown>;

  // Claude / OpenAI / Interactions usage object
  const usage = root.usage;
  if (usage && typeof usage === 'object') {
    const usageRecord = usage as Record<string, unknown>;

    const input_tokens = toSafeNumber(
      usageRecord.input_tokens ?? usageRecord.total_input_tokens ?? usageRecord.prompt_tokens
    );

    const cached_tokens = toSafeNumber(
      usageRecord.cache_read_input_tokens ??
      (usageRecord.input_tokens_details && typeof usageRecord.input_tokens_details === 'object'
        ? (usageRecord.input_tokens_details as Record<string, unknown>).cached_tokens
        : 0)
    );

    const cache_writen_tokens = toSafeNumber(
      usageRecord.cache_creation_input_tokens
    );

    const output_tokens = toSafeNumber(
      usageRecord.output_tokens ?? usageRecord.total_output_tokens ?? usageRecord.completion_tokens
    );

    const total_tokens = toSafeNumber(
      usageRecord.total_tokens ?? (input_tokens + cached_tokens + cache_writen_tokens + output_tokens)
    );

    if (input_tokens === 0 && cached_tokens === 0 && cache_writen_tokens === 0 && output_tokens === 0 && total_tokens === 0) {
      return undefined;
    }

    return { input_tokens, cached_tokens, cache_writen_tokens, output_tokens, total_tokens };
  }

  // Gemini usageMetadata object
  const usageMetadata = root.usageMetadata;
  if (usageMetadata && typeof usageMetadata === 'object') {
    const metadata = usageMetadata as Record<string, unknown>;
    const input_tokens = toSafeNumber(metadata.promptTokenCount);
    const output_tokens = toSafeNumber(metadata.candidatesTokenCount ?? metadata.responseTokenCount);
    const total_tokens = toSafeNumber(metadata.totalTokenCount ?? (input_tokens + output_tokens));

    if (input_tokens === 0 && output_tokens === 0 && total_tokens === 0) {
      return undefined;
    }

    return {
      input_tokens,
      cached_tokens: 0,
      cache_writen_tokens: 0,
      output_tokens,
      total_tokens,
    };
  }

  return undefined;
}

function getOrCreateModelStat(model: string): ModelStatsEntry {
  return modelStats.get(model) || {
    model,
    requests: 0,
    input_tokens: 0,
    cached_tokens: 0,
    cache_writen_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };
}

export function recordModelStat(model: string | undefined, usage?: UsageStats): void {
  if (!model) {
    return;
  }

  const current = getOrCreateModelStat(model);
  current.requests += 1;
  current.input_tokens += toSafeNumber(usage?.input_tokens);
  current.cached_tokens += toSafeNumber(usage?.cached_tokens);
  current.cache_writen_tokens += toSafeNumber(usage?.cache_writen_tokens);
  current.output_tokens += toSafeNumber(usage?.output_tokens);
  current.total_tokens += toSafeNumber(usage?.total_tokens);
  modelStats.set(model, current);
}

export function recordModelUsage(model: string | undefined, usage?: UsageStats): void {
  if (!model || !usage) {
    return;
  }

  const current = getOrCreateModelStat(model);
  current.input_tokens += toSafeNumber(usage.input_tokens);
  current.cached_tokens += toSafeNumber(usage.cached_tokens);
  current.cache_writen_tokens += toSafeNumber(usage.cache_writen_tokens);
  current.output_tokens += toSafeNumber(usage.output_tokens);
  current.total_tokens += toSafeNumber(usage.total_tokens);
  modelStats.set(model, current);
}

export function recordAgentStat(userAgentPrefix: string, toolNames: string[]): void {
  const ua = userAgentPrefix || 'unknown';
  const effectiveTools = toolNames.length > 0 ? toolNames : ['none'];

  for (const toolName of effectiveTools) {
    const key = `${ua} / ${toolName}`;
    const current = agentStats.get(key) || { key, requests: 0 };
    current.requests += 1;
    agentStats.set(key, current);
  }
}

export function getModelStatsDesc(): ModelStatsEntry[] {
  return [...modelStats.values()].sort((a, b) => {
    if (b.requests !== a.requests) {
      return b.requests - a.requests;
    }

    const aTokens = a.total_tokens;
    const bTokens = b.total_tokens;
    if (bTokens !== aTokens) {
      return bTokens - aTokens;
    }

    return a.model.localeCompare(b.model);
  });
}

export function recordRequestEndpoint(endpoint: string): void {
  if (!endpoint) {
    return;
  }

  const current = requestEndpointStats.get(endpoint) || { endpoint, requests: 0 };
  current.requests += 1;
  requestEndpointStats.set(endpoint, current);
}

function normalizeUpstreamBaseUrl(urlLike: string): string {
  try {
    const parsed = new URL(urlLike);
    return parsed.origin;
  } catch {
    return urlLike;
  }
}

export function recordResponseUpstream(upstreamBaseUrl: string): void {
  if (!upstreamBaseUrl) {
    return;
  }

  const normalized = normalizeUpstreamBaseUrl(upstreamBaseUrl);
  const current = requestUpstreamStats.get(normalized) || { upstream_base_url: normalized, responses: 0 };
  current.responses += 1;
  requestUpstreamStats.set(normalized, current);
}

export function recordResponseStatusCodeToEndpoint(statusCode: number): void {
  if (!Number.isInteger(statusCode)) {
    return;
  }

  const current = requestStatusCodeToEndpointStats.get(statusCode) || { status_code: statusCode, responses: 0 };
  current.responses += 1;
  requestStatusCodeToEndpointStats.set(statusCode, current);
}

export function recordResponseStatusCodeFromUpstream(statusCode: number): void {
  if (!Number.isInteger(statusCode)) {
    return;
  }

  const current = requestStatusCodeFromUpstreamStats.get(statusCode) || { status_code: statusCode, responses: 0 };
  current.responses += 1;
  requestStatusCodeFromUpstreamStats.set(statusCode, current);
}

export function getAgentStatsDesc(): AgentStatsEntry[] {
  return [...agentStats.values()].sort((a, b) => {
    if (b.requests !== a.requests) {
      return b.requests - a.requests;
    }
    return a.key.localeCompare(b.key);
  });
}

export function getRequestEndpointStatsDesc(): RequestEndpointStatsEntry[] {
  return [...requestEndpointStats.values()].sort((a, b) => {
    if (b.requests !== a.requests) {
      return b.requests - a.requests;
    }
    return a.endpoint.localeCompare(b.endpoint);
  });
}

export function getRequestUpstreamStatsDesc(): RequestUpstreamStatsEntry[] {
  return [...requestUpstreamStats.values()].sort((a, b) => {
    if (b.responses !== a.responses) {
      return b.responses - a.responses;
    }
    return a.upstream_base_url.localeCompare(b.upstream_base_url);
  });
}

function sortStatusCodeStatsDesc(entries: RequestStatusCodeStatsEntry[]): RequestStatusCodeStatsEntry[] {
  return [...entries].sort((a, b) => {
    if (b.responses !== a.responses) {
      return b.responses - a.responses;
    }
    return a.status_code - b.status_code;
  });
}

export function getRequestStatusCodeToEndpointStatsDesc(): RequestStatusCodeStatsEntry[] {
  return sortStatusCodeStatsDesc([...requestStatusCodeToEndpointStats.values()]);
}

export function getRequestStatusCodeFromUpstreamStatsDesc(): RequestStatusCodeStatsEntry[] {
  return sortStatusCodeStatsDesc([...requestStatusCodeFromUpstreamStats.values()]);
}
