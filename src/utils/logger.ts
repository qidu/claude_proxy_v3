/**
 * Logger utility with configurable log levels for Cloudflare Workers
 * Log levels: debug=0, info=1, warn=2, error=3
 */

import { Env } from '../types/shared.js';

export interface Logger {
  debug: (requestId: string, message: string, ...args: unknown[]) => void;
  info: (requestId: string, message: string, ...args: unknown[]) => void;
  warn: (requestId: string, message: string, ...args: unknown[]) => void;
  error: (requestId: string, message: string, ...args: unknown[]) => void;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
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

export function createLogger(env: Env | Record<string, unknown>): Logger {
  const logLevelRaw = env.LOG_LEVEL as string;
  const logLevel = (['debug', 'info', 'warn', 'error'].includes(logLevelRaw) ? logLevelRaw : 'info') as LogLevel;
  const minLevel = LOG_LEVELS[logLevel];

  return {
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
