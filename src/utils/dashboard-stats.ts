import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { stringify } from './stringify.js';
import type { TokenLimitDuration } from './config-loader.js';

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
  in_request_chars: number;
};

type ToolRequestStatsEntry = {
  tool_name: string;
  request_chars: number;
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
  model?: string;
};

const TOKEN_HEATMAP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;   // heatmap rendering: 7 days
const TOKEN_RETENTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // event retention for enforcement: 30 days

// These must be declared before the daily token helpers that reference dailyTokenStats
const modelStats = new Map<string, ModelStatsEntry>();
const agentStats = new Map<string, AgentStatsEntry>();
const toolRequestChars = new Map<string, number>();
const requestEndpointStats = new Map<string, RequestEndpointStatsEntry>();
const requestUpstreamStats = new Map<string, RequestUpstreamStatsEntry>();
const requestStatusCodeToEndpointStats = new Map<number, RequestStatusCodeStatsEntry>();
const requestStatusCodeFromUpstreamStats = new Map<number, RequestStatusCodeStatsEntry>();
const upstreamResponseToolStats = new Map<string, UpstreamResponseToolStatsEntry>();
const requestEndpointTimingStats = new Map<string, RequestEndpointTimingStatsEntry>();
const requestModelTimingStats = new Map<string, RequestEndpointTimingStatsEntry>();
const tokenHeatmapEvents: TokenHeatmapEvent[] = [];

// ── Composite token limit windows ───────────────────────────────────────────────

export interface CompositeLimitWindow {
  limit: number;
  duration: TokenLimitDuration;
  windowStartMs: number;
  accumulator: number;
}

export const compositeLimitWindows = new Map<string, CompositeLimitWindow>();

// Reverse map: target model name → composite alias names that include it
const modelToCompositeAliases = new Map<string, Set<string>>();

export function getWindowMs(duration: TokenLimitDuration): number {
  switch (duration) {
    case '1h': return 60 * 60 * 1000;
    case '1d': return 24 * 60 * 60 * 1000;
    case '1w': return 7 * 24 * 60 * 60 * 1000;
    case '1m': return 30 * 24 * 60 * 60 * 1000;
  }
}

/**
 * Update the reverse model→alias map when composite config changes.
 * Call this from index.ts after a config reload.
 */
export function updateCompositeAliasReverseMap(
  aliases: Record<string, { token_limit?: { num: number; duration: TokenLimitDuration } }>
): void {
  modelToCompositeAliases.clear();
  for (const [alias, targets] of Object.entries(aliases)) {
    if (!targets.token_limit) continue;
    for (const model of Object.keys(targets).filter((k) => k !== 'token_limit')) {
      if (!modelToCompositeAliases.has(model)) {
        modelToCompositeAliases.set(model, new Set());
      }
      modelToCompositeAliases.get(model)!.add(alias);
    }
  }
}

/**
 * Set or update the token limit for a composite alias.
 * Resets the window start and accumulator (fresh window begins now).
 */
export function setCompositeLimit(alias: string, limit: number, duration: TokenLimitDuration): void {
  compositeLimitWindows.set(alias, {
    limit,
    duration,
    windowStartMs: Date.now(),
    accumulator: 0,
  });
}

/**
 * Clear the token limit for a composite alias.
 */
export function clearCompositeLimit(alias: string): void {
  compositeLimitWindows.delete(alias);
}

/**
 * Check if a composite limit window has expired and advance it if so.
 * Call this at the start of enforcement and before persisting state.
 */
function advanceCompositeLimitWindow(alias: string): void {
  const win = compositeLimitWindows.get(alias);
  if (!win) return;
  const windowMs = getWindowMs(win.duration);
  if (Date.now() - win.windowStartMs >= windowMs) {
    win.windowStartMs = Date.now();
    win.accumulator = 0;
  }
}

/**
 * Get the current token usage for a composite alias (tokens in current window).
 * Falls back to all-time sum of targets if no duration limit is set.
 */
export function getCompositeAliasTokenUsage(alias: string, targets: string[]): number {
  const win = compositeLimitWindows.get(alias);
  if (!win) {
    // No duration limit — fall back to all-time sum (backwards compat for
    // configs that set token_limit without duration, e.g. migrated total_token_limit)
    return targets.reduce((sum, m) => sum + getModelTotalTokens(m), 0);
  }
  advanceCompositeLimitWindow(alias);
  return compositeLimitWindows.get(alias)!.accumulator;
}

/**
 * Record token usage for a composite alias's window.
 * Also updates windows for all aliases that include the same model.
 */
export function recordCompositeTokenUsage(alias: string, _targetModel: string, tokenCount: number): void {
  if (!compositeLimitWindows.has(alias)) return;
  advanceCompositeLimitWindow(alias);
  const win = compositeLimitWindows.get(alias)!;
  win.accumulator += tokenCount;
}

/**
 * Record token usage for a model, updating all composite alias windows that include it.
 */
export function recordModelUsageForComposites(modelName: string, tokenCount: number): void {
  const aliases = modelToCompositeAliases.get(modelName);
  if (!aliases) return;
  for (const alias of aliases) {
    recordCompositeTokenUsage(alias, modelName, tokenCount);
  }
}

/**
 * Returns a snapshot of all composite limit windows as a plain object,
 * with windowMs and remainingMs computed for each.
 */
export function getCompositeLimitWindowsSnapshot(): Record<string, {
  limit: number;
  duration: string;
  windowStartMs: number;
  windowMs: number;
  remainingMs: number;
  accumulator: number;
}> {
  const result: Record<string, {
    limit: number;
    duration: string;
    windowStartMs: number;
    windowMs: number;
    remainingMs: number;
    accumulator: number;
  }> = {};
  const now = Date.now();
  for (const [alias, win] of compositeLimitWindows) {
    const windowMs = getWindowMs(win.duration);
    const remainingMs = Math.max(0, win.windowStartMs + windowMs - now);
    result[alias] = {
      limit: win.limit,
      duration: win.duration,
      windowStartMs: win.windowStartMs,
      windowMs,
      remainingMs,
      accumulator: win.accumulator,
    };
  }
  return result;
}

export const TOKEN_LOG_FILE = './model_proxy_tokens.jsonl';

// ── In-flight request tracking ─────────────────────────────────────────────────
// Tracks the number of proxy requests currently being handled. Used by the TUI
// header / terminal title to show an activity indicator. Incremented in
// src/index.ts's fetch handler after the dashboard/health preflight checks. The
// decrement is deferred until the response body has fully streamed to the client
// (handled in src/server.ts), so the count reflects true client-facing duration
// rather than just the time to obtain the upstream Response object.
let activeRequestCount = 0;

// Symbol used to smuggle the per-request release callback on the Response object
// from the fetch handler (src/index.ts) to the HTTP adapter (src/server.ts),
// which calls it once the response body has finished streaming.
const ACTIVE_REQUEST_RELEASE = Symbol('activeRequestRelease');

// Marks a request as in-flight and returns a release callback. The callback is
// guarded so it only ever decrements once, no matter how many times it's called
// (e.g. both a stream `close` and a `res` `close` firing for the same request).
export function incrementActiveRequests(): () => void {
  activeRequestCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (activeRequestCount > 0) activeRequestCount -= 1;
  };
}

export function attachActiveRequestRelease(response: Response, release: () => void): void {
  (response as unknown as Record<symbol, unknown>)[ACTIVE_REQUEST_RELEASE] = release;
}

// Returns and detaches the release callback previously attached to a response,
// or undefined if the request was never counted as in-flight.
export function consumeActiveRequestRelease(response: Response): (() => void) | undefined {
  const holder = response as unknown as Record<symbol, unknown>;
  const release = holder[ACTIVE_REQUEST_RELEASE] as (() => void) | undefined;
  if (release) delete holder[ACTIVE_REQUEST_RELEASE];
  return release;
}

export function getActiveRequestCount(): number {
  return activeRequestCount;
}

const dailyTokenStats = new Map<string, ModelStatsEntry>();

let currentDaySlot = getTodayDateStr();

function getTodayDateStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function ensureTokenLogDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function dumpDailyTokens(dateStr: string): void {
  ensureTokenLogDir(TOKEN_LOG_FILE);
  const timestamp = new Date().toISOString();
  const cutoff = Date.now() - TOKEN_HEATMAP_WINDOW_MS;
  const recentEvents = tokenHeatmapEvents.filter((e) => e.timestamp >= cutoff);

  // Serialize composite limit windows (keyed by alias → plain object)
  const windowsObj: Record<string, { limit: number; duration: string; windowStartMs: number; accumulator: number }> = {};
  for (const [alias, win] of compositeLimitWindows) {
    windowsObj[alias] = {
      limit: win.limit,
      duration: win.duration,
      windowStartMs: win.windowStartMs,
      accumulator: win.accumulator,
    };
  }

  const logLine = JSON.stringify({
    date: dateStr,
    timestamp,
    modelStats: [...dailyTokenStats.values()],
    heatmapEvents: recentEvents,
    compositeLimitWindows: windowsObj,
  }) + '\n';
  writeFileSync(TOKEN_LOG_FILE, logLine, { flag: 'a' });
}

function getOrCreateDailyModelStat(model: string): ModelStatsEntry {
  return dailyTokenStats.get(model) || {
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

function advanceDaySlotIfNeeded(): void {
  const today = getTodayDateStr();
  if (today !== currentDaySlot) {
    dumpDailyTokens(currentDaySlot);
    dailyTokenStats.clear();
    currentDaySlot = today;
  }
}

function recordDailyToken(model: string, usage?: UsageStats, failed = false): void {
  advanceDaySlotIfNeeded();
  const stat = getOrCreateDailyModelStat(model);
  stat.requests += 1;
  if (failed) stat.failed_requests += 1;
  stat.input_tokens += toSafeNumber(usage?.input_tokens);
  stat.cached_tokens += toSafeNumber(usage?.cached_tokens);
  stat.cache_written_tokens += toSafeNumber(usage?.cache_written_tokens);
  stat.output_tokens += toSafeNumber(usage?.output_tokens);
  stat.total_tokens += toSafeNumber(usage?.total_tokens);
  dailyTokenStats.set(model, stat);
}

export function dumpTodayTokens(): void {
  const today = getTodayDateStr();

  // Handle day rollover — persist the old day's data and reset for the new day
  if (today !== currentDaySlot) {
    dumpDailyTokens(currentDaySlot);
    dailyTokenStats.clear();
    currentDaySlot = today;
  }

  ensureTokenLogDir(TOKEN_LOG_FILE);
  const timestamp = new Date().toISOString();

  const modelEntries = [...dailyTokenStats.values()];

  // Collect heatmap events from the last 7 days
  const cutoff = Date.now() - TOKEN_HEATMAP_WINDOW_MS;
  const recentEvents = tokenHeatmapEvents.filter((e) => e.timestamp >= cutoff);

  const logLine = JSON.stringify({
    date: today,
    timestamp,
    modelStats: modelEntries,
    heatmapEvents: recentEvents,
  }) + '\n';
  writeFileSync(TOKEN_LOG_FILE, logLine, { flag: 'a' });
}

type PersistedLimitWindow = {
  limit: number;
  duration: string;
  windowStartMs: number;
  accumulator: number;
};

export function loadTokenStatsFromLog(): void {
  if (!existsSync(TOKEN_LOG_FILE)) return;
  try {
    const content = readFileSync(TOKEN_LOG_FILE, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());

    // Build set of last 30 days (YYYY-MM-DD) for efficient lookup
    // Events are retained 30d for enforcement; heatmap renders only the last 7d
    const last30Days = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      last30Days.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }

    // First pass: find the latest timestamp per date
    const latestPerDate = new Map<string, string>();
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as { date: string; timestamp?: string };
        if (!last30Days.has(record.date)) continue;
        const existing = latestPerDate.get(record.date);
        if (!existing || (record.timestamp && record.timestamp > existing)) {
          latestPerDate.set(record.date, record.timestamp || '');
        }
      } catch {
        // skip malformed lines
      }
    }

    // Second pass: load data only from the latest dump per date
    const seenHeatmap = new Set<string>();
    const cutoff = Date.now() - TOKEN_RETENTION_WINDOW_MS;

    for (const line of lines) {
      try {
        const record = JSON.parse(line) as {
          date: string;
          timestamp?: string;
          entries?: ModelStatsEntry[];
          modelStats?: ModelStatsEntry[];
          heatmapEvents?: TokenHeatmapEvent[];
          compositeLimitWindows?: Record<string, PersistedLimitWindow>;
        };
        if (!last30Days.has(record.date)) continue;
        const latestTs = latestPerDate.get(record.date);
        if (record.timestamp !== latestTs) continue; // not the latest dump for this date, skip

        // Load model stats (support both old 'entries' and new 'modelStats' field)
        // Note: modelStats is NOT loaded — it must start fresh at 0 so the token limit
        // check in index.ts doesn't incorrectly count tokens from previous days.
        // dailyTokenStats is still loaded for daily dump aggregation.
        const modelEntries = record.modelStats ?? record.entries ?? [];
        for (const entry of modelEntries) {
          dailyTokenStats.set(entry.model, entry);
        }

        // Load heatmap events (only from latest dump per date)
        const events = record.heatmapEvents;
        if (Array.isArray(events)) {
          for (const event of events) {
            if (event.timestamp < cutoff) continue;
            const key = `${event.timestamp}:${event.values}:${event.model ?? ''}`;
            if (seenHeatmap.has(key)) continue;
            seenHeatmap.add(key);
            tokenHeatmapEvents.push(event);
          }
        }

        // Load composite limit windows from the latest dump per date
        const windows = record.compositeLimitWindows;
        if (windows && typeof windows === 'object') {
          for (const [alias, win] of Object.entries(windows)) {
            const duration = win.duration as TokenLimitDuration;
            if (!(['1h', '1d', '1w', '1m'] as string[]).includes(duration)) continue;
            const windowMs = getWindowMs(duration);
            // If the saved window has expired (start + duration <= now), don't restore stale accumulator
            if (win.windowStartMs + windowMs <= Date.now()) continue;
            compositeLimitWindows.set(alias, {
              limit: win.limit,
              duration,
              windowStartMs: win.windowStartMs,
              accumulator: win.accumulator,
            });
          }
        }
      } catch {
        // skip malformed lines
      }
    }

    // Re-apply window pruning on heatmap after merge (retain 30d for enforcement)
    const pruneCutoff = Date.now() - TOKEN_RETENTION_WINDOW_MS;
    while (tokenHeatmapEvents.length > 0 && tokenHeatmapEvents[0].timestamp < pruneCutoff) {
      tokenHeatmapEvents.shift();
    }

    currentDaySlot = getTodayDateStr();
  } catch {
    // file read error, start fresh
  }
}

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

function extractSystemText(body: Record<string, unknown>): string {
  const system = body.system;
  if (typeof system === 'string') {
    return system;
  }
  if (Array.isArray(system)) {
    return system
      .map((block) => (block && typeof block === 'object' ? (block as Record<string, unknown>).text : ''))
      .filter((text) => typeof text === 'string' && text.length > 0)
      .join('\n');
  }
  return '';
}

export function extractToolRequestCharLengthsFromBody(body: Record<string, unknown> | undefined): Array<{ tool_name: string; request_chars: number }> {
  if (!body) {
    return [];
  }

  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    return [];
  }

  const systemText = extractSystemText(body);
  const totals = new Map<string, number>();

  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') {
      continue;
    }

    const record = tool as Record<string, unknown>;
    const claudeToolName = typeof record.name === 'string' && record.name.trim()
      ? record.name.trim()
      : undefined;
    const openAiFunction = record.function && typeof record.function === 'object'
      ? (record.function as Record<string, unknown>)
      : undefined;
    const openAiName = typeof openAiFunction?.name === 'string' && openAiFunction.name.trim()
      ? openAiFunction.name.trim()
      : undefined;
    const toolName = claudeToolName || openAiName;
    if (!toolName) {
      continue;
    }

    let requestChars = stringify(record).length;
    if (systemText && systemText.includes(toolName)) {
      requestChars += systemText.length;
    }
    totals.set(toolName, (totals.get(toolName) ?? 0) + requestChars);
  }

  return [...totals.entries()].map(([tool_name, request_chars]) => ({ tool_name, request_chars }));
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

function normalizeModelStatKey(model: string): string {
  const suffixMatch = model.match(/^(.*?):\s+https?:\/\/.+$/);
  return suffixMatch ? suffixMatch[1] : model;
}

function getOrCreateModelStat(model: string): ModelStatsEntry {
  const normalizedModel = normalizeModelStatKey(model);
  return modelStats.get(normalizedModel) || {
    model: normalizedModel,
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
  const entry = modelStats.get(normalizeModelStatKey(model));
  return entry ? entry.total_tokens : 0;
}

export function recordModelFailedRequest(model: string | undefined): void {
  if (!model) {
    return;
  }

  const normalizedModel = normalizeModelStatKey(model);
  const current = getOrCreateModelStat(normalizedModel);
  current.failed_requests += 1;
  modelStats.set(normalizedModel, current);
  recordDailyToken(normalizedModel, undefined, true);
}

export function recordModelStat(model: string | undefined, usage?: UsageStats): void {
  if (!model) {
    return;
  }

  const normalizedModel = normalizeModelStatKey(model);
  const current = getOrCreateModelStat(normalizedModel);
  current.requests += 1;
  current.input_tokens += toSafeNumber(usage?.input_tokens);
  current.cached_tokens += toSafeNumber(usage?.cached_tokens);
  current.cache_written_tokens += toSafeNumber(usage?.cache_written_tokens);
  current.output_tokens += toSafeNumber(usage?.output_tokens);
  current.total_tokens += toSafeNumber(usage?.total_tokens);
  modelStats.set(normalizedModel, current);
  recordDailyToken(normalizedModel, usage);
}

function recordTokenHeatmapEvent(values: number, timestamp = Date.now(), model?: string): void {
  if (!Number.isFinite(values) || values <= 0) {
    return;
  }

  tokenHeatmapEvents.push({ timestamp, values, model });
  const cutoff = timestamp - TOKEN_RETENTION_WINDOW_MS;
  while (tokenHeatmapEvents.length > 0 && tokenHeatmapEvents[0].timestamp < cutoff) {
    tokenHeatmapEvents.shift();
  }
}

export function recordModelUsage(model: string | undefined, usage?: UsageStats): void {
  if (!model || !usage) {
    return;
  }

  const normalizedModel = normalizeModelStatKey(model);
  const current = getOrCreateModelStat(normalizedModel);
  current.input_tokens += toSafeNumber(usage.input_tokens);
  current.cached_tokens += toSafeNumber(usage.cached_tokens);
  current.cache_written_tokens += toSafeNumber(usage.cache_written_tokens);
  current.output_tokens += toSafeNumber(usage.output_tokens);
  current.total_tokens += toSafeNumber(usage.total_tokens);
  modelStats.set(normalizedModel, current);
  recordTokenHeatmapEvent(toSafeNumber(usage.total_tokens), Date.now(), normalizedModel);
  recordDailyToken(normalizedModel, usage);
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

export function recordToolRequestChars(toolChars: Array<{ tool_name: string; request_chars: number }>): void {
  if (!Array.isArray(toolChars) || toolChars.length === 0) {
    return;
  }

  for (const entry of toolChars) {
    if (!entry || typeof entry.tool_name !== 'string' || !entry.tool_name.trim()) {
      continue;
    }
    const toolName = entry.tool_name.trim();
    const requestChars = Number.isFinite(entry.request_chars) ? Math.max(0, Math.floor(entry.request_chars)) : 0;
    toolRequestChars.set(toolName, (toolRequestChars.get(toolName) ?? 0) + requestChars);
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
 * when the stream ends. Also records composite alias window tokens if compositeAlias is set.
 */
export function createUsageTrackingTransformStream(
  model: string,
  compositeAlias?: string,
): TransformStream<Uint8Array, Uint8Array> {
  let inputTokens = 0;
  let cachedTokens = 0;
  let cacheWrittenTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let foundUsage = false;
  let remainder = '';
  const decoder = new TextDecoder();

  return new TransformStream({
    transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
      // Normalize CRLF -> LF so SSE frames delimited by "\r\n\r\n" (the
      // spec-compliant form used by many Anthropic-compatible upstreams)
      // are split correctly. Without this, a trailing "\r" ends up inside
      // the data line and JSON.parse silently throws in the catch below,
      // dropping the message_start frame (so input_tokens stays 0 while
      // message_delta's output_tokens still records).
      const text = (remainder + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
      const parts = text.split('\n\n');
      remainder = parts.pop() || '';

      for (const part of parts) {
        // Match Claude SSE event name
        const eventLine = part.match(/^event: (.+)$/m);
        const dataLine = part.match(/^data: ?(.+?)\r?$/m);
        if (eventLine && dataLine) {
          const eventType = eventLine[1];
          try {
            const data = JSON.parse(dataLine[1]);
            if (eventType === 'message_start' && data.message?.usage) {
              const usage = data.message.usage;
              if (typeof usage.input_tokens === 'number') {
                inputTokens = usage.input_tokens;
                foundUsage = true;
              }
              if (typeof usage.cache_read_input_tokens === 'number') {
                cachedTokens = usage.cache_read_input_tokens;
                foundUsage = true;
              }
              if (typeof usage.cache_creation_input_tokens === 'number') {
                cacheWrittenTokens = usage.cache_creation_input_tokens;
                foundUsage = true;
              }
            } else if (eventType === 'message_delta' && data.usage) {
              const usage = data.usage;
              if (typeof usage.output_tokens === 'number') {
                outputTokens = usage.output_tokens;
                foundUsage = true;
              }
              if (typeof usage.input_tokens === 'number') {
                inputTokens = usage.input_tokens;
                foundUsage = true;
              }
              if (typeof usage.cache_read_input_tokens === 'number') {
                cachedTokens = usage.cache_read_input_tokens;
                foundUsage = true;
              }
              if (typeof usage.cache_creation_input_tokens === 'number') {
                cacheWrittenTokens = usage.cache_creation_input_tokens;
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
        const computedTotal = inputTokens + cachedTokens + cacheWrittenTokens + outputTokens;
        const usageObj = {
          input_tokens: inputTokens > 0 ? inputTokens : undefined,
          cached_tokens: cachedTokens > 0 ? cachedTokens : undefined,
          cache_written_tokens: cacheWrittenTokens > 0 ? cacheWrittenTokens : undefined,
          output_tokens: outputTokens > 0 ? outputTokens : undefined,
          total_tokens: totalTokens > 0 ? totalTokens : (computedTotal > 0 ? computedTotal : undefined),
        };
        recordModelUsage(model, usageObj);
        if (compositeAlias && usageObj.total_tokens) {
          recordCompositeTokenUsage(compositeAlias, model, usageObj.total_tokens);
        }
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

export function recordModelTiming(model: string | undefined, elapsedMs: number): void {
  if (!model || typeof elapsedMs !== 'number' || elapsedMs < 0) {
    return;
  }

  const normalizedModel = normalizeModelStatKey(model);
  const current: RequestEndpointTimingStatsEntry = requestModelTimingStats.get(normalizedModel) || { endpoint: normalizedModel, max_time_ms: 0, min_time_ms: Infinity, total_time_ms: 0, count: 0 };
  if (elapsedMs > current.max_time_ms) {
    current.max_time_ms = elapsedMs;
  }
  if (elapsedMs < current.min_time_ms) {
    current.min_time_ms = elapsedMs;
  }
  current.total_time_ms += elapsedMs;
  current.count += 1;
  requestModelTimingStats.set(normalizedModel, current);
}

export function getRequestModelTimingStatsDesc(): (RequestEndpointTimingStatsEntry & { avg_time_ms: number })[] {
  return [...requestModelTimingStats.values()].sort((a, b) => {
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

export function getTokensInWindow(durationMs: number): number {
  const cutoff = Date.now() - durationMs;
  let total = 0;
  for (const event of tokenHeatmapEvents) {
    if (event.timestamp >= cutoff) {
      total += event.values;
    }
  }
  return total;
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
    const current = combined.get(tool_name) || { tool_name, in_requests: 0, in_responses: 0, in_request_chars: 0 };
    current.in_requests += entry.uses;
    combined.set(tool_name, current);
  }

  for (const [tool_name, request_chars] of toolRequestChars.entries()) {
    const current = combined.get(tool_name) || { tool_name, in_requests: 0, in_responses: 0, in_request_chars: 0 };
    current.in_request_chars += request_chars;
    combined.set(tool_name, current);
  }

  for (const entry of upstreamResponseToolStats.values()) {
    const tool_name = entry.tool_name;
    const current = combined.get(tool_name) || { tool_name, in_requests: 0, in_responses: 0, in_request_chars: 0 };
    current.in_responses += entry.tools;
    combined.set(tool_name, current);
  }

  return [...combined.values()].sort((a, b) => {
    const aTotal = a.in_requests + a.in_responses + a.in_request_chars;
    const bTotal = b.in_requests + b.in_responses + b.in_request_chars;
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

// Load today's token stats from log on module startup (Node.js runtime).
// In Workers runtime this silently fails since fs is unavailable.
try {
  loadTokenStatsFromLog();
} catch {
  // noop in Workers
}
