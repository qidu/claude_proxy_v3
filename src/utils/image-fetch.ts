/**
 * Server-side image fetcher for OpenAI image_url -> Gemini inline_data
 * conversion. Used by convertCompletionsToGeminiGenerateContentBody when an
 * image_url points at an http(s) URL rather than a `data:` URI.
 *
 * Two modes:
 *   1. In-process (default): direct fetch with an SSRF guard
 *      (`isInternalHost` blocks loopback / RFC1918 / link-local / mDNS) and a
 *      20 MiB byte cap.
 *   2. Sidecar delegation (when `[fetch] image_encode` or `IMAGE_ENCODE_URL`
 *      is configured): POST `{"url":"..."}` to `{sidecar}/encode`; the sidecar
 *      does the fetch + base64 and returns `{"mime_type","data"}`. The sidecar
 *      is responsible for its own SSRF policy; the proxy only requires the
 *      sidecar itself to be on localhost / a private/LAN host.
 *
 * On any failure, throws — no silent placeholder (Rule #8 Fail Loud).
 */

import { isInternalHost } from './routing.js';
import type { Env } from '../types/shared.js';

/** Hard limit on downloaded image size: 20 MiB. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export interface InlineImageData {
    mime_type: string;
    data: string; // base64-encoded
}

export interface ImageEncodeConfig {
    /** Sidecar base URL, normalized (no trailing slash), e.g. "http://localhost:34567". */
    url: string;
    /** Per-call timeout in milliseconds. */
    timeoutMs: number;
}

/** Toml shape for the `[fetch]` section. */
export interface ImageEncodeToml {
    image_encode?: string;
    timeout_ms?: number;
}

/** Module-level config; global, set once at startup. Null = in-process mode. */
let configuredSidecar: ImageEncodeConfig | null = null;

/** Set the global image-encode sidecar config. Called once at startup. */
export function setImageEncodeConfig(c: ImageEncodeConfig | null): void {
    configuredSidecar = c;
}

/** Read the global image-encode sidecar config (null = in-process mode). */
export function getImageEncodeConfig(): ImageEncodeConfig | null {
    return configuredSidecar;
}

/**
 * Resolve the effective image-encode sidecar config from env + toml.
 * Env var (`IMAGE_ENCODE_URL`) wins over toml. Accepts `host:port` shorthand
 * (prepends `http://`). The sidecar must be reachable on localhost or a
 * private/LAN host (validated via `isInternalHost`). Returns null when both
 * env and toml are empty (in-process mode).
 *
 * Throws on an invalid or non-local sidecar URL (Fail Loud at startup).
 */
export function resolveImageEncodeConfig(
    env: Env | undefined,
    toml: ImageEncodeToml | null | undefined,
): ImageEncodeConfig | null {
    const rawUrl = env?.IMAGE_ENCODE_URL?.trim() || toml?.image_encode?.trim() || '';
    if (!rawUrl) return null;

    // Accept "localhost:34567" shorthand by prepending http:// when there's
    // no protocol marker at all. (Any `scheme://` prefix is left intact so
    // the protocol check below can accept or reject it honestly.)
    const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`;

    let parsed: URL;
    try {
        parsed = new URL(normalized);
    } catch {
        throw new Error(`[fetch] image_encode is not a valid URL: ${rawUrl}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`[fetch] image_encode must use http or https, got: ${parsed.protocol}`);
    }
    // The sidecar itself must be local/LAN — never allow an external sidecar
    // (an external endpoint would itself be an SSRF / data-exfil surface).
    if (!isInternalHost(parsed.hostname)) {
        throw new Error(`[fetch] image_encode must point to localhost or a private/LAN address, got: ${parsed.hostname}`);
    }

    const timeoutRaw = Number(env?.IMAGE_ENCODE_TIMEOUT_MS ?? toml?.timeout_ms);
    const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0
        ? Math.floor(timeoutRaw)
        : 40000;

    return { url: normalized.replace(/\/+$/, ''), timeoutMs };
}

/**
 * Fetch an http(s) image URL and return its mime_type + base64-encoded bytes.
 * Delegates to the configured sidecar when set; otherwise fetches in-process
 * with the SSRF guard + byte cap.
 *
 * Throws on any failure (Rule #8 — no silent placeholder).
 */
export async function fetchImageAsInlineData(url: string): Promise<InlineImageData> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`image_url is not a valid URL: ${url.slice(0, 60)}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`image_url protocol not supported: ${parsed.protocol}`);
    }

    if (configuredSidecar) {
        return fetchImageViaSidecar(url, configuredSidecar);
    }
    return fetchImageInProcess(url, parsed);
}

/** Delegate to the sidecar: POST `{"url":"..."}` -> `{"mime_type","data"}`. */
async function fetchImageViaSidecar(url: string, config: ImageEncodeConfig): Promise<InlineImageData> {
    const response = await fetch(`${config.url}/encode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`image_encode sidecar returned ${response.status} ${response.statusText}: ${text.slice(0, 200)}`);
    }
    let json: { mime_type?: unknown; data?: unknown };
    try {
        json = await response.json() as { mime_type?: unknown; data?: unknown };
    } catch (e) {
        throw new Error(`image_encode sidecar returned non-JSON response: ${(e as Error).message}`);
    }
    if (typeof json.data !== 'string' || json.data === '') {
        throw new Error(`image_encode sidecar returned no base64 data for ${url.slice(0, 60)}`);
    }
    return {
        mime_type: typeof json.mime_type === 'string' && json.mime_type ? json.mime_type : 'image/jpeg',
        data: json.data,
    };
}

/** In-process fetch with SSRF guard + byte cap. */
async function fetchImageInProcess(url: string, parsed: URL): Promise<InlineImageData> {
    if (isInternalHost(parsed.hostname)) {
        throw new Error(`image_url host is blocked (private/loopback): ${parsed.hostname}`);
    }

    const response = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'model-proxy-v3/image-fetch' },
    });
    if (!response.ok) {
        throw new Error(`image fetch failed: ${response.status} ${response.statusText} for ${url.slice(0, 60)}`);
    }

    const mime_type = (response.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength && contentLength > MAX_IMAGE_BYTES) {
        throw new Error(`image exceeds ${MAX_IMAGE_BYTES} byte cap (content-length): ${url.slice(0, 60)}`);
    }

    // Stream-read with a runtime cap so a missing/lying content-length cannot
    // cause unbounded buffering.
    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error(`image fetch returned no body for ${url.slice(0, 60)}`);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            total += value.byteLength;
            if (total > MAX_IMAGE_BYTES) {
                try { await reader.cancel(); } catch { /* best effort */ }
                throw new Error(`image exceeds ${MAX_IMAGE_BYTES} byte cap while streaming: ${url.slice(0, 60)}`);
            }
            chunks.push(value);
        }
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        merged.set(c, offset);
        offset += c.byteLength;
    }

    // base64 encode. btoa requires a binary string; build it in chunks to
    // avoid call-stack issues on large inputs.
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < merged.length; i += CHUNK) {
        bin += String.fromCharCode(...merged.subarray(i, Math.min(i + CHUNK, merged.length)));
    }
    const data = btoa(bin);
    return { mime_type, data };
}

