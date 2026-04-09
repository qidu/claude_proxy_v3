export const DEFAULT_UPSTREAM_BODY_TIMEOUT_MS = 600000;

import type { Env } from '../types/shared.js';

export function getUpstreamBodyTimeoutMs(env?: Pick<Env, 'UPSTREAM_BODY_TIMEOUT_MS'>): number {
  const rawTimeout = env?.UPSTREAM_BODY_TIMEOUT_MS;
  if (!rawTimeout) {
    return DEFAULT_UPSTREAM_BODY_TIMEOUT_MS;
  }

  const timeoutMs = Number(rawTimeout);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_UPSTREAM_BODY_TIMEOUT_MS;
  }

  return Math.floor(timeoutMs);
}

export function createUpstreamAbortSignal(timeoutMs: number): AbortSignal {
  const abortSignal = AbortSignal as typeof AbortSignal & {
    timeout?: (delay: number) => AbortSignal;
  };

  if (typeof abortSignal.timeout === 'function') {
    return abortSignal.timeout(timeoutMs);
  }

  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs);
  return controller.signal;
}
