import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { fetchImageAsInlineData } from '../../src/utils/image-fetch.js';

/**
 * Exercises the image fetcher: SSRF guard rejects private/loopback hosts,
 * success path returns base64 + mime from a stubbed fetch, oversized content
 * is rejected.
 */
describe('fetchImageAsInlineData', () => {
  const realFetch = globalThis.fetch;

  after(() => { globalThis.fetch = realFetch; });

  it('blocks loopback IPv4 hosts (SSRF guard)', async () => {
    globalThis.fetch = realFetch; // not used; guard runs before fetch
    await assert.rejects(
      () => fetchImageAsInlineData('http://127.0.0.1/x.png'),
      /blocked|loopback/i,
    );
  });

  it('blocks RFC1918 private hosts (SSRF guard)', async () => {
    await assert.rejects(
      () => fetchImageAsInlineData('http://10.0.0.1/x.png'),
      /blocked|private/i,
    );
    await assert.rejects(
      () => fetchImageAsInlineData('http://192.168.1.1/x.png'),
      /blocked|private/i,
    );
  });

  it('blocks localhost (SSRF guard)', async () => {
    await assert.rejects(
      () => fetchImageAsInlineData('http://localhost/x.png'),
      /blocked|loopback/i,
    );
  });

  it('rejects non-http(s) protocols', async () => {
    await assert.rejects(
      () => fetchImageAsInlineData('file:///etc/passwd'),
      /protocol/i,
    );
  });

  it('returns mime_type + base64 data on success', async () => {
    // Stub fetch: return 2 PNG bytes with image/png content-type.
    const bytes = new Uint8Array([0x89, 0x50]);
    globalThis.fetch = (async (_url: any) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'image/png' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    })) as typeof fetch;

    const out = await fetchImageAsInlineData('https://example.com/i.png');
    assert.equal(out.mime_type, 'image/png');
    // 0x89 0x50 -> base64 "iVA="
    assert.equal(out.data, 'iVA=');
  });

  it('throws on non-OK status', async () => {
    globalThis.fetch = (async (_url: any) => ({
      ok: false, status: 404, statusText: 'Not Found',
      headers: new Headers(),
      body: new ReadableStream({ start(c) { c.close(); } }),
    })) as typeof fetch;
    await assert.rejects(
      () => fetchImageAsInlineData('https://example.com/missing.png'),
      /404|Not Found|image fetch failed/i,
    );
  });

  it('throws on content-length exceeding the cap', async () => {
    globalThis.fetch = (async (_url: any) => ({
      ok: true, status: 200, statusText: 'OK',
      headers: new Headers({ 'content-length': String(30 * 1024 * 1024) }),
      body: new ReadableStream({ start(c) { c.close(); } }),
    })) as typeof fetch;
    await assert.rejects(
      () => fetchImageAsInlineData('https://example.com/huge.png'),
      /cap/i,
    );
  });

  it('throws on body exceeding the cap while streaming', async () => {
    globalThis.fetch = (async (_url: any) => ({
      ok: true, status: 200, statusText: 'OK',
      headers: new Headers(), // no content-length
      body: new ReadableStream({
        start(controller) {
          // enqueue 4 x 10 MiB chunks -> 40 MiB total > 20 MiB cap
          const chunk = new Uint8Array(10 * 1024 * 1024);
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.enqueue(chunk);
          controller.close();
        },
      }),
    })) as typeof fetch;
    await assert.rejects(
      () => fetchImageAsInlineData('https://example.com/huge-stream.png'),
      /cap/i,
    );
  });
});
