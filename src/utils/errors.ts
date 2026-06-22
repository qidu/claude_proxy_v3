/**
 * Error handling utilities for Claude Proxy v3
 */

import { ClaudeErrorResponse } from '../types/shared.js';
import { createLogger } from './logger.js';

export class ClaudeProxyError extends Error {
  constructor(
    message: string,
    public readonly status: number = 500,
    public readonly type: string = 'error'
  ) {
    super(message);
    this.name = 'ClaudeProxyError';
  }

  toClaudeErrorResponse(): ClaudeErrorResponse {
    return {
      type: this.type as any,
      error: {
        type: this.type,
        message: this.message,
      },
    };
  }
}

export class ValidationError extends ClaudeProxyError {
  constructor(message: string) {
    super(message, 400, 'invalid_request_error');
    this.name = 'ValidationError';
  }
}

export class AuthenticationError extends ClaudeProxyError {
  constructor(message: string = 'Authentication failed') {
    super(message, 401, 'authentication_error');
    this.name = 'AuthenticationError';
  }
}

export class PermissionError extends ClaudeProxyError {
  constructor(message: string = 'Insufficient permissions') {
    super(message, 403, 'permission_error');
    this.name = 'PermissionError';
  }
}

export class RateLimitError extends ClaudeProxyError {
  constructor(message: string = 'Rate limit exceeded') {
    super(message, 429, 'rate_limit_error');
    this.name = 'RateLimitError';
  }
}

export class ProcessingError extends ClaudeProxyError {
  constructor(message: string = 'Error processing request') {
    super(message, 500, 'processing_error');
    this.name = 'ProcessingError';
  }
}

export class OverLimitError extends ClaudeProxyError {
  constructor(message: string = 'Request exceeds limits') {
    // Token-limit exhaustion is a payload-size / quota concept, not a rate
    // (RPM) limit. Use 413 + over_limit_error to match the documented
    // "token_limit reached" contract and the canonical Anthropic-style error
    // shape (see README "Composite total_token_limit" section).
    super(message, 413, 'over_limit_error');
    this.name = 'OverLimitError';
  }
}

/**
 * Create a Claude API error response
 */
export function createErrorResponse(
  error: Error | ClaudeProxyError,
  requestId?: string,
  customStatus?: number
): Response {
  let responseStatus = customStatus ?? 500;
  let type = 'error';
  let message = error.message;

  if (error instanceof ClaudeProxyError) {
    responseStatus = error.status;
    type = error.type;
  }

  const errorResponse: ClaudeErrorResponse = {
    type: type as any,
    error: {
      type,
      message,
    },
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (requestId) {
    headers['x-request-id'] = requestId;
  }

  return new Response(JSON.stringify(errorResponse), {
    status: responseStatus,
    headers,
  });
}

/**
 * Extract the user-facing message from an upstream error response body.
 * Checks `error.message` (Anthropic/OpenAI format) then top-level `message`.
 * Returns undefined if no parseable message is found.
 */
function extractUpstreamMessage(rawBody: string | undefined): string | undefined {
  if (!rawBody) return undefined;
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && typeof parsed === 'object') {
      if (parsed.error && typeof parsed.error === 'object' && typeof parsed.error.message === 'string' && parsed.error.message.trim()) {
        return parsed.error.message;
      }
      if (typeof parsed.message === 'string' && parsed.message.trim()) {
        return parsed.message;
      }
    }
  } catch {
    // not JSON or unparseable
  }
  return undefined;
}

/**
 * Handle errors from target API responses
 */
export function handleTargetApiError(
  response: Response,
  targetApiName: string,
  requestInfo?: { url: string; body?: string; upstreamBody?: string }
): never {
  const status = response.status;
  const upstreamMessage = extractUpstreamMessage(requestInfo?.upstreamBody);

  let errorMessage = upstreamMessage ?? `Target API (${targetApiName}) returned error: ${status}`;
  let errorType = 'processing_error';

  switch (status) {
    case 400:
      errorType = 'invalid_request_error';
      if (!upstreamMessage) {
        errorMessage = `Invalid request to ${targetApiName}`;
        // Log the body server-side only; do NOT include it in the client-facing
        // error message (it may contain user messages, PII, or tool arguments).
        if (requestInfo) {
          const logger = createLogger({});
          if (requestInfo.url) {
            logger.debug('errors', `Upstream 400 from ${targetApiName} [URL: ${requestInfo.url}]`);
          }
          if (requestInfo.body) {
            const bodyPreview = requestInfo.body.length > 300
              ? requestInfo.body.substring(0, 300) + '...'
              : requestInfo.body;
            logger.debug('errors', `Upstream 400 from ${targetApiName} [Body: ${bodyPreview}]`);
          }
        }
      }
      break;
    case 401:
      errorType = 'authentication_error';
      errorMessage = upstreamMessage ?? `Authentication failed for ${targetApiName}`;
      break;
    case 403:
      errorType = 'permission_error';
      errorMessage = upstreamMessage ?? `Insufficient permissions for ${targetApiName}`;
      break;
    case 429:
      errorType = 'rate_limit_error';
      errorMessage = upstreamMessage ?? `Rate limit exceeded for ${targetApiName}`;
      break;
    case 413:
      errorType = 'over_limit_error';
      errorMessage = upstreamMessage ?? `Request exceeds limits for ${targetApiName}`;
      break;
    case 500:
    case 502:
    case 503:
    case 504:
      errorType = 'processing_error';
      errorMessage = upstreamMessage ?? `Service error from ${targetApiName}`;
      break;
    default:
      // Unknown status — preserve upstream message if we have it; otherwise generic
      errorType = 'processing_error';
      if (!upstreamMessage) {
        errorMessage = `Target API (${targetApiName}) returned error: ${status}`;
      }
      break;
  }

  throw new ClaudeProxyError(errorMessage, status, errorType);
}

/**
 * Validate required parameters
 */
export function validateRequired(
  obj: Record<string, any>,
  requiredFields: string[],
  context: string = 'request'
): void {
  for (const field of requiredFields) {
    if (obj[field] === undefined || obj[field] === null) {
      throw new ValidationError(
        `Missing required field: ${field} in ${context}`
      );
    }
  }
}

/**
 * Validate string parameter constraints
 */
export function validateString(
  value: any,
  fieldName: string,
  options?: {
    minLength?: number;
    maxLength?: number;
    pattern?: RegExp;
    allowedValues?: string[];
  }
): void {
  if (typeof value !== 'string') {
    throw new ValidationError(
      `${fieldName} must be a string, got ${typeof value}`
    );
  }

  if (options?.minLength !== undefined && value.length < options.minLength) {
    throw new ValidationError(
      `${fieldName} must be at least ${options.minLength} characters`
    );
  }

  if (options?.maxLength !== undefined && value.length > options.maxLength) {
    throw new ValidationError(
      `${fieldName} must be at most ${options.maxLength} characters`
    );
  }

  if (options?.pattern && !options.pattern.test(value)) {
    throw new ValidationError(
      `${fieldName} does not match required pattern`
    );
  }

  if (
    options?.allowedValues &&
    !options.allowedValues.includes(value)
  ) {
    throw new ValidationError(
      `${fieldName} must be one of: ${options.allowedValues.join(', ')}`
    );
  }
}

/**
 * Validate number parameter constraints
 */
export function validateNumber(
  value: any,
  fieldName: string,
  options?: {
    min?: number;
    max?: number;
    integer?: boolean;
  }
): void {
  if (typeof value !== 'number' || isNaN(value)) {
    throw new ValidationError(
      `${fieldName} must be a number, got ${typeof value}`
    );
  }

  if (options?.integer && !Number.isInteger(value)) {
    throw new ValidationError(`${fieldName} must be an integer`);
  }

  if (options?.min !== undefined && value < options.min) {
    throw new ValidationError(
      `${fieldName} must be at least ${options.min}`
    );
  }

  if (options?.max !== undefined && value > options.max) {
    throw new ValidationError(
      `${fieldName} must be at most ${options.max}`
    );
  }
}

/**
 * Validate array parameter constraints
 */
export function validateArray(
  value: any,
  fieldName: string,
  options?: {
    minItems?: number;
    maxItems?: number;
    itemValidator?: (item: any, index: number) => void;
  }
): void {
  if (!Array.isArray(value)) {
    throw new ValidationError(
      `${fieldName} must be an array, got ${typeof value}`
    );
  }

  if (options?.minItems !== undefined && value.length < options.minItems) {
    throw new ValidationError(
      `${fieldName} must contain at least ${options.minItems} items`
    );
  }

  if (options?.maxItems !== undefined && value.length > options.maxItems) {
    throw new ValidationError(
      `${fieldName} must contain at most ${options.maxItems} items`
    );
  }

  if (options?.itemValidator) {
    for (let i = 0; i < value.length; i++) {
      try {
        options.itemValidator(value[i], i);
      } catch (error) {
        if (error instanceof ClaudeProxyError) {
          throw new ValidationError(
            `${fieldName}[${i}]: ${error.message}`
          );
        }
        throw error;
      }
    }
  }
}