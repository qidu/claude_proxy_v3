/**
 * Server-side image fetcher for OpenAI image_url -> Gemini inline_data
 * conversion. Used by convertCompletionsToGeminiGenerateContentBody when an
 * image_url points at an http(s) URL rather than a `data:` URI.
 *
 * Safety: blocks loopback / private / link-local hosts via `isInternalHost`
 * (RFC 1918 + RFC 4291 + mDNS). Enforces a byte cap to avoid memory blowups.
 * On any failure, throws — no silent placeholder (Rule #8 Fail Loud).
 */

import { isInternalHost } from './routing.js';

/** Hard limit on downloaded image size: 20 MiB. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export interface InlineImageData {
    mime_type: string;
    data: string; // base64-encoded
}

/**
 * Fetch an http(s) image URL and return its mime_type + base64-encoded bytes.
 * Throws if the host is internal (SSRF guard), the response is too large,
 * the status is not OK, or the body cannot be read.
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
