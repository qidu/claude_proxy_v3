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

export function createLogger(env: Env | Record<string, unknown>): Logger {
  const logLevelRaw = env.LOG_LEVEL as string;
  const logLevel = (['debug', 'info', 'warn', 'error'].includes(logLevelRaw) ? logLevelRaw : 'info') as LogLevel;
  const minLevel = LOG_LEVELS[logLevel];

  return {
    debug: (requestId: string, message: string, ...args: unknown[]) => {
      if (minLevel <= 0) {
        console.log(`[${requestId}] [DEBUG] ${message}`, ...args);
      }
    },
    info: (requestId: string, message: string, ...args: unknown[]) => {
      if (minLevel <= 1) {
        console.log(`[${requestId}] [INFO] ${message}`, ...args);
      }
    },
    warn: (requestId: string, message: string, ...args: unknown[]) => {
      if (minLevel <= 2) {
        console.log(`[${requestId}] [WARN] ${message}`, ...args);
      }
    },
    error: (requestId: string, message: string, ...args: unknown[]) => {
      if (minLevel <= 3) {
        console.log(`[${requestId}] [ERROR] ${message}`, ...args);
      }
    },
  };
}
