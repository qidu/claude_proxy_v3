type UsageStats = {
  input_tokens?: number;
  cached_tokens?: number;
  cache_written_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

type ModelStatsEntry = {
  model: string;
  requests: number;
  failed_requests: number;
  input_tokens: number;
  cached_tokens: number;
  cache_written_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

type AgentStatsEntry = {
  key: string;
  uses: number;
};

type ToolUsageStatsEntry = {
  tool_name: string;
  in_requests: number;
  in_responses: number;
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

type UpstreamResponseToolStatsEntry = {
  tool_name: string;
  tools: number;
};

type RequestEndpointTimingStatsEntry = {
  endpoint: string;
  max_time_ms: number;
  min_time_ms: number;
  total_time_ms: number;
  count: number;
};

type TokenHeatmapEvent = {
  timestamp: number;
  values: number;
};

const TOKEN_HEATMAP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const modelStats = new Map<string, ModelStatsEntry>();
const agentStats = new Map<string, AgentStatsEntry>();
const requestEndpointStats = new Map<string, RequestEndpointStatsEntry>();
const requestUpstreamStats = new Map<string, RequestUpstreamStatsEntry>();
const requestStatusCodeToEndpointStats = new Map<number, RequestStatusCodeStatsEntry>();
const requestStatusCodeFromUpstreamStats = new Map<number, RequestStatusCodeStatsEntry>();
const upstreamResponseToolStats = new Map<string, UpstreamResponseToolStatsEntry>();
const requestEndpointTimingStats = new Map<string, RequestEndpointTimingStatsEntry>();
const tokenHeatmapEvents: TokenHeatmapEvent[] = [];

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

function addToolName(names: string[], value: unknown): boolean {
  if (typeof value === 'string' && value.trim()) {
    names.push(value.trim());
    return true;
  }

  return false;
}

function collectToolNamesFromResponseNode(node: unknown, names: string[]): void {
  if (!node || typeof node !== 'object') {
    return;
  }

  const record = node as Record<string, unknown>;

  if (Array.isArray(record.tool_calls)) {
    for (const toolCall of record.tool_calls) {
      if (!toolCall || typeof toolCall !== 'object') {
        continue;
      }
      const fn = (toolCall as Record<string, unknown>).function;
      if (fn && typeof fn === 'object') {
        addToolName(names, (fn as Record<string, unknown>).name);
      }
    }
  }

  if (Array.isArray(record.content)) {
    for (const block of record.content) {
      if (!block || typeof block !== 'object') {
        continue;
      }
      if ((block as Record<string, unknown>).type === 'tool_use') {
        addToolName(names, (block as Record<string, unknown>).name);
      }
    }
  }

  if (Array.isArray(record.output)) {
    for (const item of record.output) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const outputItem = item as Record<string, unknown>;
      if (outputItem.type === 'function_call') {
        addToolName(names, outputItem.name);
      }
      if (outputItem.type === 'message') {
        collectToolNamesFromResponseNode(outputItem, names);
      }
    }
  }

  if (record.message && typeof record.message === 'object') {
    collectToolNamesFromResponseNode(record.message, names);
  }

  if (Array.isArray(record.choices)) {
    for (const choice of record.choices) {
      if (!choice || typeof choice !== 'object') {
        continue;
      }
      collectToolNamesFromResponseNode((choice as Record<string, unknown>).message, names);
    }
  }

  if (record.response && typeof record.response === 'object') {
    collectToolNamesFromResponseNode(record.response, names);
  }
}

export function extractToolNamesFromResponsePayload(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') {
    return ['none'];
  }

  const names: string[] = [];
  collectToolNamesFromResponseNode(payload, names);
  return names.length > 0 ? names : ['none'];
}

function countToolOccurrencesFromResponseNode(node: unknown): number {
  if (!node || typeof node !== 'object') {
    return 0;
  }

  const record = node as Record<string, unknown>;
  let count = 0;

  if (Array.isArray(record.tool_calls)) {
    count += record.tool_calls.filter((toolCall) => toolCall && typeof toolCall === 'object').length;
  }

  if (Array.isArray(record.content)) {
    for (const block of record.content) {
      if (!block || typeof block !== 'object') {
        continue;
      }
      if ((block as Record<string, unknown>).type === 'tool_use') {
        count += 1;
      }
    }
  }

  if (Array.isArray(record.output)) {
    for (const item of record.output) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const outputItem = item as Record<string, unknown>;
      if (outputItem.type === 'function_call') {
        count += 1;
      }
      if (outputItem.type === 'message') {
        count += countToolOccurrencesFromResponseNode(outputItem);
      }
    }
  }

  if (record.message && typeof record.message === 'object') {
    count += countToolOccurrencesFromResponseNode(record.message);
  }

  if (Array.isArray(record.choices)) {
    for (const choice of record.choices) {
      if (!choice || typeof choice !== 'object') {
        continue;
      }
      count += countToolOccurrencesFromResponseNode((choice as Record<string, unknown>).message);
    }
  }

  if (record.response && typeof record.response === 'object') {
    count += countToolOccurrencesFromResponseNode(record.response);
  }

  return count;
}

export function extractToolCountFromResponsePayload(payload: unknown): number {
  if (!payload || typeof payload !== 'object') {
    return 0;
  }

  return countToolOccurrencesFromResponseNode(payload);
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

    const cache_written_tokens = toSafeNumber(
      usageRecord.cache_creation_input_tokens
    );

    const output_tokens = toSafeNumber(
      usageRecord.output_tokens ?? usageRecord.total_output_tokens ?? usageRecord.completion_tokens
    );

    const total_tokens = toSafeNumber(
      usageRecord.total_tokens ?? (input_tokens + cached_tokens + cache_written_tokens + output_tokens)
    );

    if (input_tokens === 0 && cached_tokens === 0 && cache_written_tokens === 0 && output_tokens === 0 && total_tokens === 0) {
      return undefined;
    }

    return { input_tokens, cached_tokens, cache_written_tokens, output_tokens, total_tokens };
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
      cache_written_tokens: 0,
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
    failed_requests: 0,
    input_tokens: 0,
    cached_tokens: 0,
    cache_written_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };
}

/**
 * Get accumulated total_tokens for a model (0 if no usage recorded yet).
 */
export function getModelTotalTokens(model: string | undefined): number {
  if (!model) return 0;
  const entry = modelStats.get(model);
  return entry ? entry.total_tokens : 0;
}

export function recordModelFailedRequest(model: string | undefined): void {
  if (!model) {
    return;
  }

  const current = getOrCreateModelStat(model);
  current.failed_requests += 1;
  modelStats.set(model, current);
}

export function recordModelStat(model: string | undefined, usage?: UsageStats): void {
  if (!model) {
    return;
  }

  const current = getOrCreateModelStat(model);
  current.requests += 1;
  current.input_tokens += toSafeNumber(usage?.input_tokens);
  current.cached_tokens += toSafeNumber(usage?.cached_tokens);
  current.cache_written_tokens += toSafeNumber(usage?.cache_written_tokens);
  current.output_tokens += toSafeNumber(usage?.output_tokens);
  current.total_tokens += toSafeNumber(usage?.total_tokens);
  modelStats.set(model, current);
}

function recordTokenHeatmapEvent(values: number, timestamp = Date.now()): void {
  if (!Number.isFinite(values) || values <= 0) {
    return;
  }

  tokenHeatmapEvents.push({ timestamp, values });
  const cutoff = timestamp - TOKEN_HEATMAP_WINDOW_MS;
  while (tokenHeatmapEvents.length > 0 && tokenHeatmapEvents[0].timestamp < cutoff) {
    tokenHeatmapEvents.shift();
  }
}

export function recordModelUsage(model: string | undefined, usage?: UsageStats): void {
  if (!model || !usage) {
    return;
  }

  const current = getOrCreateModelStat(model);
  current.input_tokens += toSafeNumber(usage.input_tokens);
  current.cached_tokens += toSafeNumber(usage.cached_tokens);
  current.cache_written_tokens += toSafeNumber(usage.cache_written_tokens);
  current.output_tokens += toSafeNumber(usage.output_tokens);
  current.total_tokens += toSafeNumber(usage.total_tokens);
  modelStats.set(model, current);
  recordTokenHeatmapEvent(toSafeNumber(usage.total_tokens));
}

export function recordAgentStat(userAgentPrefix: string, toolNames: string[]): void {
  const ua = userAgentPrefix || 'unknown';
  const effectiveTools = toolNames.length > 0 ? toolNames : ['none'];

  for (const toolName of effectiveTools) {
    const key = `${ua} / ${toolName}`;
    const current = agentStats.get(key) || { key, uses: 0 };
    current.uses += 1;
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

/**
 * Create a TransformStream that intercepts SSE streaming data to capture
 * token usage from Claude SSE events (message_start.usage.input_tokens
 * and message_delta.usage.output_tokens). Records usage via recordModelUsage
 * when the stream ends.
 */
export function createUsageTrackingTransformStream(model: string): TransformStream<Uint8Array, Uint8Array> {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let foundUsage = false;
  let remainder = '';
  const decoder = new TextDecoder();

  return new TransformStream({
    transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
      const text = remainder + decoder.decode(chunk, { stream: true });
      const parts = text.split('\n\n');
      remainder = parts.pop() || '';

      for (const part of parts) {
        // Match Claude SSE event name
        const eventLine = part.match(/^event: (.+)$/m);
        const dataLine = part.match(/^data: (.+)$/m);
        if (eventLine && dataLine) {
          const eventType = eventLine[1];
          try {
            const data = JSON.parse(dataLine[1]);
            if (eventType === 'message_start' && data.message?.usage) {
              const val = data.message.usage.input_tokens;
              if (typeof val === 'number') {
                inputTokens = val;
                foundUsage = true;
              }
            } else if (eventType === 'message_delta' && data.usage) {
              const val = data.usage.output_tokens;
              if (typeof val === 'number') {
                outputTokens = val;
                foundUsage = true;
              }
              const valIn = data.usage.input_tokens;
              if (typeof valIn === 'number') {
                inputTokens = valIn;
                foundUsage = true;
              }
            }
          } catch {
            // Not JSON data, skip
          }
        } else if (dataLine && !eventLine) {
          // OpenAI-style SSE (no event: line) — check data for usage
          try {
            const dataText = dataLine[1].trim();
            if (dataText === '[DONE]') {
              continue;
            }
            const data = JSON.parse(dataText);
            if (data.usage) {
              const usage = data.usage as Record<string, unknown>;
              const pt = toSafeNumber(usage.prompt_tokens);
              const ct = toSafeNumber(usage.completion_tokens);
              const tt = toSafeNumber(usage.total_tokens);
              if (pt > 0 || ct > 0) {
                inputTokens = pt;
                outputTokens = ct;
                totalTokens = tt;
                foundUsage = true;
              }
            }
          } catch {
            // Not JSON data, skip
          }
        }
      }

      controller.enqueue(chunk);
    },
    flush() {
      if (foundUsage) {
        recordModelUsage(model, {
          input_tokens: inputTokens > 0 ? inputTokens : undefined,
          output_tokens: outputTokens > 0 ? outputTokens : undefined,
          total_tokens: totalTokens > 0 ? totalTokens : (inputTokens > 0 || outputTokens > 0 ? inputTokens + outputTokens : undefined),
        });
      }
    },
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

export function recordRequestTiming(endpoint: string, elapsedMs: number): void {
  if (!endpoint || typeof elapsedMs !== 'number' || elapsedMs < 0) {
    return;
  }

  const current: RequestEndpointTimingStatsEntry = requestEndpointTimingStats.get(endpoint) || { endpoint, max_time_ms: 0, min_time_ms: Infinity, total_time_ms: 0, count: 0 };
  if (elapsedMs > current.max_time_ms) {
    current.max_time_ms = elapsedMs;
  }
  if (elapsedMs < current.min_time_ms) {
    current.min_time_ms = elapsedMs;
  }
  current.total_time_ms += elapsedMs;
  current.count += 1;
  requestEndpointTimingStats.set(endpoint, current);
}

export function getRequestEndpointTimingStatsDesc(): (RequestEndpointTimingStatsEntry & { avg_time_ms: number })[] {
  return [...requestEndpointTimingStats.values()].sort((a, b) => {
    if (b.max_time_ms !== a.max_time_ms) {
      return b.max_time_ms - a.max_time_ms;
    }
    return a.endpoint.localeCompare(b.endpoint);
  }).map((entry) => ({
    ...entry,
    avg_time_ms: entry.count > 0 ? Math.round(entry.total_time_ms / entry.count) : 0,
  }));
}

export function getTokenHeatmapStatsDesc(): Array<{ weekday: number; hour: number; values: number }> {
  const cutoff = Date.now() - TOKEN_HEATMAP_WINDOW_MS;
  const buckets = new Map<string, { weekday: number; hour: number; values: number }>();

  for (const event of tokenHeatmapEvents) {
    if (event.timestamp < cutoff) {
      continue;
    }

    const date = new Date(event.timestamp);
    const weekday = date.getDay();
    const hour = date.getHours();
    const key = `${weekday}:${hour}`;
    const current = buckets.get(key) || { weekday, hour, values: 0 };
    current.values += event.values;
    buckets.set(key, current);
  }

  return [...buckets.values()].sort((a, b) => {
    if (a.weekday !== b.weekday) {
      return a.weekday - b.weekday;
    }
    if (a.hour !== b.hour) {
      return a.hour - b.hour;
    }
    return a.values - b.values;
  });
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

export function recordUpstreamResponseToolNames(toolNames: string[]): void {
  if (!Array.isArray(toolNames) || toolNames.length === 0) {
    return;
  }

  for (const toolName of toolNames) {
    const current = upstreamResponseToolStats.get(toolName) || { tool_name: toolName, tools: 0 };
    current.tools += 1;
    upstreamResponseToolStats.set(toolName, current);
  }
}

export function recordUpstreamResponseToolCount(_upstreamMode: string | undefined, _toolCount = 0): void {
  void _upstreamMode;
  void _toolCount;
}

export function getAgentStatsDesc(): AgentStatsEntry[] {
  return [...agentStats.values()].sort((a, b) => {
    if (b.uses !== a.uses) {
      return b.uses - a.uses;
    }
    return a.key.localeCompare(b.key);
  });
}

export function getToolUsageStatsDesc(): ToolUsageStatsEntry[] {
  const combined = new Map<string, ToolUsageStatsEntry>();

  for (const entry of agentStats.values()) {
    const tool_name = entry.key.includes(' / ') ? entry.key.slice(entry.key.lastIndexOf(' / ') + 3) : entry.key;
    const current = combined.get(tool_name) || { tool_name, in_requests: 0, in_responses: 0 };
    current.in_requests += entry.uses;
    combined.set(tool_name, current);
  }

  for (const entry of upstreamResponseToolStats.values()) {
    const tool_name = entry.tool_name;
    const current = combined.get(tool_name) || { tool_name, in_requests: 0, in_responses: 0 };
    current.in_responses += entry.tools;
    combined.set(tool_name, current);
  }

  return [...combined.values()].sort((a, b) => {
    const aTotal = a.in_requests + a.in_responses;
    const bTotal = b.in_requests + b.in_responses;
    if (bTotal !== aTotal) {
      return bTotal - aTotal;
    }
    if (b.in_requests !== a.in_requests) {
      return b.in_requests - a.in_requests;
    }
    return a.tool_name.localeCompare(b.tool_name);
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

export function getUpstreamResponseToolStatsDesc(): UpstreamResponseToolStatsEntry[] {
  return [...upstreamResponseToolStats.values()].sort((a, b) => {
    if (b.tools !== a.tools) {
      return b.tools - a.tools;
    }
    return a.tool_name.localeCompare(b.tool_name);
  });
}

export function createResponseToolTrackingTransformStream(
  onNames: (toolNames: string[]) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let remainder = '';
  const toolNames: string[] = [];

  function collectToolNamesFromPayload(payload: unknown): void {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const root = payload as Record<string, unknown>;

    if (Array.isArray(root.choices)) {
      for (const choice of root.choices) {
        if (!choice || typeof choice !== 'object') continue;
        const delta = (choice as Record<string, unknown>).delta as Record<string, unknown> | undefined;
        if (delta && Array.isArray(delta.tool_calls)) {
          for (const toolCall of delta.tool_calls) {
            if (!toolCall || typeof toolCall !== 'object') continue;
            const fn = (toolCall as Record<string, unknown>).function;
            if (fn && typeof fn === 'object') {
              addToolName(toolNames, (fn as Record<string, unknown>).name);
            }
          }
        }
        const message = (choice as Record<string, unknown>).message;
        if (message && typeof message === 'object') {
          collectToolNamesFromPayload(message);
        }
      }
    }

    if (Array.isArray(root.output)) {
      for (const item of root.output) {
        if (!item || typeof item !== 'object') continue;
        const outputItem = item as Record<string, unknown>;
        if (outputItem.type === 'function_call') {
          addToolName(toolNames, outputItem.name);
        }
        if (outputItem.type === 'message') {
          collectToolNamesFromPayload(outputItem);
        }
      }
    }

    if (Array.isArray(root.content)) {
      for (const block of root.content) {
        if (!block || typeof block !== 'object') continue;
        if ((block as Record<string, unknown>).type === 'tool_use') {
          addToolName(toolNames, (block as Record<string, unknown>).name);
        }
      }
    }

    if (root.content_block && typeof root.content_block === 'object') {
      const contentBlock = root.content_block as Record<string, unknown>;
      if (contentBlock.type === 'tool_use') {
        addToolName(toolNames, contentBlock.name);
      }
    }

    if (root.item && typeof root.item === 'object') {
      const item = root.item as Record<string, unknown>;
      if (item.type === 'function_call') {
        addToolName(toolNames, item.name);
      }
    }
  }

  return new TransformStream({
    transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
      const text = remainder + decoder.decode(chunk, { stream: true });
      const lines = text.split('\n');
      remainder = lines.pop() || '';

      let currentEvent: string | undefined;
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
          continue;
        }
        if (!line.startsWith('data: ')) {
          continue;
        }

        const dataText = line.slice(6).trim();
        if (dataText === '[DONE]') {
          continue;
        }

        try {
          const payload = JSON.parse(dataText);
          if (currentEvent === 'content_block_start' || currentEvent === 'response.output_item.added' || currentEvent === 'response.output_item.done' || !currentEvent) {
            collectToolNamesFromPayload(payload);
          }
        } catch {
          // ignore parse failures
        }
      }

      controller.enqueue(chunk);
    },
    flush() {
      if (toolNames.length > 0) {
        onNames(toolNames);
      }
    },
  });
}
