import type { Logger } from '../types/shared.js';
import type { UsageStats } from './dashboard-stats.js';

export interface ModelUsageRecordPayload {
  request_id: string;
  timestamp: string;
  endpoint: string;
  user_key: string;
  model: string;
  input_tokens: number;
  cached_tokens: number;
  cache_written_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

function toSafeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function buildModelUsageRecordPayload(
  requestId: string,
  endpoint: string,
  userKey: string,
  model: string,
  usage: UsageStats,
): ModelUsageRecordPayload {
  return {
    request_id: requestId,
    timestamp: new Date().toISOString(),
    endpoint,
    user_key: userKey,
    model,
    input_tokens: toSafeNumber(usage.input_tokens),
    cached_tokens: toSafeNumber(usage.cached_tokens),
    cache_written_tokens: toSafeNumber(usage.cache_written_tokens),
    output_tokens: toSafeNumber(usage.output_tokens),
    total_tokens: toSafeNumber(usage.total_tokens),
  };
}

export function recordModelUsageToRemote(
  recordUrl: string | undefined,
  payload: ModelUsageRecordPayload,
  logger?: Logger,
  accessToken?: string,
): void {
  if (!recordUrl) return;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) headers.access_token = accessToken;

  void fetch(recordUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  }).then(response => {
    if (!response.ok) {
      logger?.warn(payload.request_id, `Model usage recorder returned HTTP ${response.status}`);
    }
  }).catch(error => {
    logger?.warn(payload.request_id, `Model usage recorder failed: ${(error as Error).message}`);
  });
}
