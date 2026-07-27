/**
 * Logger utility with configurable log levels for Cloudflare Workers
 * Log levels: trace=-1, debug=0, info=1, warn=2, error=3
 */

import { Env } from '../types/shared.js';

export interface Logger {
  trace: (requestId: string, message: string, ...args: unknown[]) => void;
  debug: (requestId: string, message: string, ...args: unknown[]) => void;
  info: (requestId: string, message: string, ...args: unknown[]) => void;
  warn: (requestId: string, message: string, ...args: unknown[]) => void;
  error: (requestId: string, message: string, ...args: unknown[]) => void;
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  trace: -1,
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Shorten a request id for log display only: keep the `req_<timestamp>_`
 * prefix and the last 12 chars of the UUID suffix.
 * e.g. req_1783840535295_2a042b05-4d3f-4411-a808-5266bdbac7f1
 *   →  req_1783840535295_5266bdbac7f1
 * Non-matching ids are logged unchanged.
 */
function shortRequestId(requestId: string): string {
  const m = /^(req_\d+_)(.+)$/.exec(requestId);
  if (!m) return requestId;
  return m[1] + m[2].slice(-12);
}

/** Pipeline stage at which a message body is being logged. */
export type PipelineStage =
  | 'inbound'           // 1) raw body as received at the endpoint, before conversion
  | 'upstream-request'  // 2) body after conversion, about to be sent upstream
  | 'upstream-response' // 3) raw body received back from upstream
  | 'outbound';         // 4) body after conversion, about to be returned to the client

const PIPELINE_STAGE_LABEL: Record<PipelineStage, string> = {
  inbound: 'IN',
  'upstream-request': 'UPSTREAM-REQ',
  'upstream-response': 'UPSTREAM-RESP',
  outbound: 'OUT',
};

/**
 * Log a message body at one of the four proxy pipeline stages:
 *   1. inbound            — body as received at the endpoint (pre-conversion)
 *   2. upstream-request   — body after conversion, sent to the upstream
 *   3. upstream-response  — raw body received back from the upstream
 *   4. outbound           — body after conversion, returned to the client
 *
 * No-op unless LOG_LEVEL=trace (the caller's `logger.trace` already gates on this,
 * this helper only adds consistent stage labeling and body truncation).
 */
export function logPipelineStage(
  logger: Logger,
  requestId: string,
  stage: PipelineStage,
  endpoint: string,
  body: unknown,
  maxLen = 128000,
): void {
  const text = typeof body === 'string' ? body : (() => { try { return JSON.stringify(body); } catch { return String(body); } })();
  const preview = text.length > maxLen ? `${text.slice(0, maxLen)}... (${text.length} bytes total)` : text;
  logger.trace(requestId, `[${PIPELINE_STAGE_LABEL[stage]}] ${endpoint}: ${preview}`);
}

export function createLogger(env: Env | Record<string, unknown>): Logger {
  const logLevelRaw = env.LOG_LEVEL as string;
  const logLevel = (['trace', 'debug', 'info', 'warn', 'error'].includes(logLevelRaw) ? logLevelRaw : 'info') as LogLevel;
  const minLevel = LOG_LEVELS[logLevel];

  return {
    trace: (requestId: string, message: string, ...args: unknown[]) => {
      if (minLevel <= -1) {
        console.log(`[${shortRequestId(requestId)}] [TRACE] ${message}`, ...args);
      }
    },
    debug: (requestId: string, message: string, ...args: unknown[]) => {
      if (minLevel <= 0) {
        console.log(`[${shortRequestId(requestId)}] [DEBUG] ${message}`, ...args);
      }
    },
    info: (requestId: string, message: string, ...args: unknown[]) => {
      if (minLevel <= 1) {
        console.log(`[${shortRequestId(requestId)}] [INFO] ${message}`, ...args);
      }
    },
    warn: (requestId: string, message: string, ...args: unknown[]) => {
      if (minLevel <= 2) {
        console.log(`[${shortRequestId(requestId)}] [WARN] ${message}`, ...args);
      }
    },
    error: (requestId: string, message: string, ...args: unknown[]) => {
      if (minLevel <= 3) {
        console.log(`[${shortRequestId(requestId)}] [ERROR] ${message}`, ...args);
      }
    },
  };
}
