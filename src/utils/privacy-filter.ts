/**
 * Privacy filter plugin (OpenAI Privacy Filter / `opf`).
 *
 * Redacts PII out of outbound LLM request text before it leaves the machine and
 * restores the original values in the response returned to the client. The
 * heavy model runs in a persistent Python sidecar (see
 * `submodules/privacy-filter/serve.py`); this module only talks to it over HTTP,
 * so it stays compatible with both the Node server and Cloudflare Workers.
 *
 * The plugin is entirely inert unless `PRIVACY_FILTER_URL` is set.
 */

import type { Env } from '../types/shared.js';
import { isInternalHost } from './routing.js';

/** Sentinels minted by the sidecar look like `⟦PII:0⟧`. */
const SENTINEL_REGEX = /\u27e6PII:\d+\u27e7/g;
/** Longest sentinel we expect, used to size the streaming tail buffer. */
const MAX_SENTINEL_LEN = 24;

export interface PrivacyFilterConfig {
  url: string;
  endpoints: Set<string>;
  failOpen: boolean;
  timeoutMs: number;
  maxChars: number;
}

/** Sentinel -> original text mapping for one request/response cycle. */
export type PiiMapping = Record<string, string>;

/**
 * Read privacy-filter configuration from env. Returns null when disabled
 * (no `PRIVACY_FILTER_URL`), so callers can cheaply skip all work.
 */
export function getPrivacyFilterConfig(env?: Env): PrivacyFilterConfig | null {
  const url = env?.PRIVACY_FILTER_URL?.trim();
  if (!url) return null;

  // Validate the URL is internal-only (localhost / RFC-1918 / link-local)
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`PRIVACY_FILTER_URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`PRIVACY_FILTER_URL must use http or https, got: ${parsed.protocol}`);
  }
  if (!isInternalHost(parsed.hostname)) {
    throw new Error(`PRIVACY_FILTER_URL must point to localhost or a private/LAN address, got: ${parsed.hostname}`);
  }

  const endpointsRaw = env?.PRIVACY_FILTER_ENDPOINTS?.trim() || '/v1/messages,/v1/chat/completions,/v1/responses,/v1/interactions';
  const endpoints = new Set(
    endpointsRaw
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean),
  );

  const failOpen = env?.PRIVACY_FILTER_FAIL_OPEN === 'true' || env?.PRIVACY_FILTER_FAIL_OPEN === '1';

  const timeoutParsed = Number(env?.PRIVACY_FILTER_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutParsed) && timeoutParsed > 0 ? Math.floor(timeoutParsed) : 40000;

  const maxCharsParsed = Number(env?.PRIVACY_FILTER_MAX_CHARS);
  const maxChars = Number.isFinite(maxCharsParsed) && maxCharsParsed > 0 ? Math.floor(maxCharsParsed) : 1024000;

  return { url: url.replace(/\/+$/, ''), endpoints, failOpen, timeoutMs, maxChars };
}

/** Whether the given proxy path should be filtered under this config. */
export function shouldFilterPath(config: PrivacyFilterConfig, path: string): boolean {
  // Match on the path portion, ignoring any query string.
  const bare = path.split('?', 1)[0]; // TODO: not work for '/v1beta/models/${upstreamModelName}:', may split at ':' and then strip last '/' leave just '/v1beta/models'
  if (path.startsWith('/v1beta/models/') || path.startsWith('/v1/models/')) {
    return config.endpoints.has('/v1beta/models') || config.endpoints.has('/v1/models');
  }
  return config.endpoints.has(bare);
}

/**
 * A reference to one text fragment inside a request body, with a setter so we
 * can write the redacted version back in place.
 */
interface TextRef {
  get(): string;
  set(value: string): void;
}

/**
 * Collect editable references to every user-visible text fragment in a parsed
 * request body. Understands the Anthropic Messages shape (string or content
 * blocks, plus `system`) and the OpenAI chat shape (string content).
 */
function collectTextRefs(body: Record<string, unknown>): TextRef[] {
  const refs: TextRef[] = [];

  // system: string | Array<{type:'text', text}>
  const system = body.system;
  if (typeof system === 'string') {
    refs.push({ get: () => body.system as string, set: (v) => { body.system = v; } });
  } else if (Array.isArray(system)) {
    for (const block of system) {
      if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
        const b = block as Record<string, unknown>;
        if (typeof b.text === 'string') {
          refs.push({ get: () => b.text as string, set: (v) => { b.text = v; } });
        }
      }
    }
  }

  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      const m = msg as Record<string, unknown>;
      const content = m.content;
      if (typeof content === 'string') {
        refs.push({ get: () => m.content as string, set: (v) => { m.content = v; } });
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== 'object') continue;
          const p = part as Record<string, unknown>;
          // Anthropic text block and OpenAI {type:'text', text} block.
          if (p.type === 'text' && typeof p.text === 'string') {
            refs.push({ get: () => p.text as string, set: (v) => { p.text = v; } });
          }
        }
      }
    }
  }

  return refs;
}

export interface RedactResult {
  /** Possibly-mutated body (same object reference as input). */
  body: Record<string, unknown>;
  /** Sentinel -> original mapping; empty when nothing was redacted. */
  mapping: PiiMapping;
}

/**
 * Redact PII out of a request body by calling the sidecar. On sidecar failure,
 * throws (fail-closed) unless `config.failOpen` is set, in which case the
 * original body is returned untouched with an empty mapping.
 */
export async function redactBody(
  config: PrivacyFilterConfig,
  body: Record<string, unknown>,
): Promise<RedactResult> {
  const refs = collectTextRefs(body);
  if (refs.length === 0) return { body, mapping: {} };

  const texts = refs.map((r) => r.get());
  const totalChars = texts.reduce((sum, t) => sum + t.length, 0);
  if (totalChars === 0 || totalChars > config.maxChars) {
    return { body, mapping: {} };
  }

  let payload: { redacted?: unknown; mapping?: unknown };
  try {
    const resp = await fetch(`${config.url}/redact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!resp.ok) {
      throw new Error(`sidecar returned ${resp.status}`);
    }
    payload = (await resp.json()) as { redacted?: unknown; mapping?: unknown };
  } catch (error) {
    if (config.failOpen) {
      return { body, mapping: {} };
    }
    throw new Error(`privacy filter unavailable: ${(error as Error).message}`);
  }

  const redacted = payload.redacted;
  if (!Array.isArray(redacted) || redacted.length !== refs.length) {
    if (config.failOpen) return { body, mapping: {} };
    throw new Error('privacy filter returned malformed response');
  }

  for (let i = 0; i < refs.length; i++) {
    if (typeof redacted[i] === 'string') {
      refs[i].set(redacted[i] as string);
    }
  }

  const mapping = (payload.mapping && typeof payload.mapping === 'object'
    ? (payload.mapping as PiiMapping)
    : {}) as PiiMapping;

  return { body, mapping };
}

/** Replace every sentinel in `text` with its original value. */
export function restoreText(text: string, mapping: PiiMapping): string {
  if (!text || Object.keys(mapping).length === 0) return text;
  return text.replace(SENTINEL_REGEX, (match) =>
    Object.prototype.hasOwnProperty.call(mapping, match) ? mapping[match] : match,
  );
}

/**
 * A TransformStream that restores sentinels in a streaming (SSE) response.
 * Keeps a small tail buffer so a sentinel split across two chunks is still
 * matched before being emitted.
 */
export function createRestoreTransformStream(mapping: PiiMapping): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  const hasMapping = Object.keys(mapping).length > 0;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      if (!hasMapping) {
        controller.enqueue(encoder.encode(buffer));
        buffer = '';
        return;
      }
      // Hold back only a genuinely incomplete trailing sentinel: an unclosed
      // sentinel-open bracket with no closing bracket after it. Complete
      // sentinels anywhere in the buffer are restored now, so a fixed-length
      // cut can never slice through a complete `⟦PII:n⟧`.
      let holdFrom = buffer.length;
      const lastOpen = buffer.lastIndexOf('\u27e6');
      if (
        lastOpen !== -1 &&
        buffer.indexOf('\u27e7', lastOpen) === -1 &&
        buffer.length - lastOpen <= MAX_SENTINEL_LEN
      ) {
        holdFrom = lastOpen;
      }
      const emit = buffer.slice(0, holdFrom);
      buffer = buffer.slice(holdFrom);
      if (emit) {
        controller.enqueue(encoder.encode(restoreText(emit, mapping)));
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) {
        controller.enqueue(encoder.encode(restoreText(buffer, mapping)));
      }
    },
  });
}
