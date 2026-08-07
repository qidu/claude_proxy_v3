import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchImageAsInlineData,
  resolveImageEncodeConfig,
  setImageEncodeConfig,
  getImageEncodeConfig,
} from '../../src/utils/image-fetch.js';
import type { Env } from '../../src/types/shared.js';

/**
 * Exercises the image fetcher: SSRF guard rejects private/loopback hosts,
 * success path returns base64 + mime from a stubbed fetch, oversized content
 * is rejected, and the sidecar delegation path POSTs to {sidecar}/encode.
 */
describe('fetchImageAsInlineData', () => {
  const realFetch = globalThis.fetch;
  const priorSidecar = getImageEncodeConfig();

  before(() => { setImageEncodeConfig(null); });
  after(() => {
    globalThis.fetch = realFetch;
    setImageEncodeConfig(priorSidecar);
  });

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

describe('fetchImageAsInlineData — sidecar delegation', () => {
  const realFetch = globalThis.fetch;
  const priorSidecar = getImageEncodeConfig();

  before(() => setImageEncodeConfig({ url: 'http://localhost:34567', timeoutMs: 5000 }));
  after(() => {
    globalThis.fetch = realFetch;
    setImageEncodeConfig(priorSidecar);
  });

  it('POSTs {"url"} to {sidecar}/encode and returns mime+data from response', async () => {
    let capturedUrl = '';
    let capturedBody: any;
    globalThis.fetch = (async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ mime_type: 'image/png', data: 'U0dW' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    // Note: with sidecar active, even loopback image URLs are allowed —
    // the sidecar owns its own SSRF policy.
    const out = await fetchImageAsInlineData('http://127.0.0.1/some-image.png');
    assert.equal(capturedUrl, 'http://localhost:34567/encode');
    assert.deepEqual(capturedBody, { url: 'http://127.0.0.1/some-image.png' });
    assert.equal(out.mime_type, 'image/png');
    assert.equal(out.data, 'U0dW');
  });

  it('throws when sidecar returns non-OK status', async () => {
    globalThis.fetch = (async () => new Response('{"err":"nope"}', {
      status: 502, statusText: 'Bad Gateway', headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    await assert.rejects(
      () => fetchImageAsInlineData('https://example.com/x.png'),
      /image_encode sidecar returned 502/,
    );
  });

  it('throws when sidecar response is missing base64 data', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ mime_type: 'image/png' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    await assert.rejects(
      () => fetchImageAsInlineData('https://example.com/x.png'),
      /no base64 data/,
    );
  });

  it('throws when sidecar returns non-JSON', async () => {
    globalThis.fetch = (async () => new Response('not json', {
      status: 200, headers: { 'content-type': 'text/plain' },
    })) as typeof fetch;
    await assert.rejects(
      () => fetchImageAsInlineData('https://example.com/x.png'),
      /non-JSON|image_encode sidecar/,
    );
  });
});

describe('resolveImageEncodeConfig', () => {
  const priorSidecar = getImageEncodeConfig();
  after(() => setImageEncodeConfig(priorSidecar));

  it('returns null when neither env nor toml is set', () => {
    assert.equal(resolveImageEncodeConfig(undefined, undefined), null);
    assert.equal(resolveImageEncodeConfig({} as Env, { image_encode: '' }), null);
  });

  it('accepts host:port shorthand (prepends http://)', () => {
    const c = resolveImageEncodeConfig(undefined, { image_encode: 'localhost:34567' });
    assert.equal(c?.url, 'http://localhost:34567');
    assert.equal(c?.timeoutMs, 40000);
  });

  it('strips trailing slashes from the sidecar URL', () => {
    const c = resolveImageEncodeConfig(undefined, { image_encode: 'http://localhost:34567///' });
    assert.equal(c?.url, 'http://localhost:34567');
  });

  it('env var wins over toml', () => {
    const c = resolveImageEncodeConfig(
      { IMAGE_ENCODE_URL: 'http://127.0.0.1:9999' } as Env,
      { image_encode: 'localhost:34567' },
    );
    assert.equal(c?.url, 'http://127.0.0.1:9999');
  });

  it('honors IMAGE_ENCODE_TIMEOUT_MS / timeout_ms', () => {
    const c = resolveImageEncodeConfig(
      { IMAGE_ENCODE_TIMEOUT_MS: '1234' } as Env,
      { image_encode: 'localhost:34567' },
    );
    assert.equal(c?.timeoutMs, 1234);
  });

  it('rejects non-local sidecar hosts', () => {
    assert.throws(
      () => resolveImageEncodeConfig(undefined, { image_encode: 'https://example.com' }),
      /localhost|private\/LAN/,
    );
  });

  it('rejects non-http protocols', () => {
    assert.throws(
      () => resolveImageEncodeConfig(undefined, { image_encode: 'ftp://localhost' }),
      /http or https/,
    );
  });

  it('accepts LAN private hosts (10.x / 192.168.x)', () => {
    assert.equal(
      resolveImageEncodeConfig(undefined, { image_encode: 'http://10.0.0.5:34567' })?.url,
      'http://10.0.0.5:34567',
    );
  });
});

