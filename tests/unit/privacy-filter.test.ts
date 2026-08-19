/**
 * Unit tests for utils/privacy-filter.ts
 *
 * Covers config resolution (env vs toml precedence, inert cases, sidecar URL
 * validation), local hash-only redaction (sentinel minting, dedup, block-type
 * skipping, maxChars guard), sidecar redaction (fail-closed on transport /
 * malformed response), restoreText, and the streaming restore transform's
 * split-sentinel handling.
 *
 * Run with: npx tsx --test tests/unit/privacy-filter.test.ts
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  getPrivacyFilterConfig,
  redactBody,
  restoreText,
  createRestoreTransformStream,
  type PrivacyFilterConfig,
} from '../../src/utils/privacy-filter.js';

// A reliably high-entropy hex token the local hash detector flags.
const SECRET = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// ---------------------------------------------------------------------------
// getPrivacyFilterConfig
// ---------------------------------------------------------------------------

describe('getPrivacyFilterConfig', () => {
  it('returns null when neither env nor toml enables the filter', () => {
    assert.equal(getPrivacyFilterConfig({} as any, null), null);
    assert.equal(getPrivacyFilterConfig({} as any, { filter_mode: 'sidecar' }), null); // sidecar w/o url
  });

  it('enables local mode via toml with an empty url', () => {
    const cfg = getPrivacyFilterConfig({} as any, { filter_mode: 'local' });
    assert.ok(cfg);
    assert.equal(cfg!.mode, 'local');
    assert.equal(cfg!.url, '');
  });

  it('env PRIVACY_FILTER_URL forces sidecar mode and strips trailing slashes', () => {
    const cfg = getPrivacyFilterConfig({ PRIVACY_FILTER_URL: 'http://localhost:9000/' } as any, null);
    assert.ok(cfg);
    assert.equal(cfg!.mode, 'sidecar');
    assert.equal(cfg!.url, 'http://localhost:9000');
  });

  it('toml local mode wins over an env sidecar url', () => {
    const cfg = getPrivacyFilterConfig(
      { PRIVACY_FILTER_URL: 'http://localhost:9000' } as any,
      { filter_mode: 'local' },
    );
    assert.equal(cfg!.mode, 'local');
  });

  it('accepts toml sidecar mode with a valid private url', () => {
    const cfg = getPrivacyFilterConfig({} as any, { filter_mode: 'sidecar', filter_url: 'http://127.0.0.1:8080' });
    assert.equal(cfg!.mode, 'sidecar');
    assert.equal(cfg!.url, 'http://127.0.0.1:8080');
  });

  it('rejects a non-internal sidecar host', () => {
    assert.throws(
      () => getPrivacyFilterConfig({ PRIVACY_FILTER_URL: 'http://evil.example.com' } as any, null),
      /localhost or a private\/LAN address/,
    );
  });

  it('rejects a non-http(s) sidecar protocol', () => {
    assert.throws(
      () => getPrivacyFilterConfig({ PRIVACY_FILTER_URL: 'ftp://localhost' } as any, null),
      /must use http or https/,
    );
  });

  it('applies default timeout / maxChars and honors toml overrides', () => {
    const dflt = getPrivacyFilterConfig({} as any, { filter_mode: 'local' })!;
    assert.equal(dflt.timeoutMs, 40000);
    assert.equal(dflt.maxChars, 1024000);
    const custom = getPrivacyFilterConfig({} as any, { filter_mode: 'local', timeout_ms: 5000, max_chars: 100 })!;
    assert.equal(custom.timeoutMs, 5000);
    assert.equal(custom.maxChars, 100);
  });
});

// ---------------------------------------------------------------------------
// redactBody — local mode
// ---------------------------------------------------------------------------

function localConfig(over: Partial<PrivacyFilterConfig> = {}): PrivacyFilterConfig {
  return getPrivacyFilterConfig({} as any, { filter_mode: 'local' })! && {
    ...getPrivacyFilterConfig({} as any, { filter_mode: 'local' })!,
    ...over,
  };
}

describe('redactBody — local mode', () => {
  it('replaces a hash-shaped secret with a HASH sentinel and records the mapping', async () => {
    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content: `my key is ${SECRET} ok` }],
    };
    const { mapping } = await redactBody(localConfig(), body);
    const content = (body.messages as any)[0].content as string;
    assert.match(content, /\u27e6HASH:0\u27e7/);
    assert.equal(content.includes(SECRET), false, 'secret must not remain in the body');
    assert.equal(mapping['\u27e6HASH:0\u27e7'], SECRET);
  });

  it('reuses one sentinel for a token repeated across messages (dedup)', async () => {
    const body: Record<string, unknown> = {
      messages: [
        { role: 'user', content: `a ${SECRET}` },
        { role: 'user', content: `b ${SECRET}` },
      ],
    };
    const { mapping } = await redactBody(localConfig(), body);
    assert.equal(Object.keys(mapping).length, 1, 'identical tokens share one sentinel');
    for (const m of body.messages as any[]) {
      assert.match(m.content, /\u27e6HASH:0\u27e7/);
    }
  });

  it('redacts string content, array text blocks, and system string', async () => {
    const body: Record<string, unknown> = {
      system: `sys ${SECRET}`,
      messages: [{ role: 'user', content: [{ type: 'text', text: `arr ${SECRET}` }] }],
    };
    await redactBody(localConfig(), body);
    assert.equal((body.system as string).includes(SECRET), false);
    assert.equal(((body.messages as any)[0].content[0].text as string).includes(SECRET), false);
  });

  it('never touches image/document block payloads', async () => {
    const body: Record<string, unknown> = {
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: SECRET } },
          { type: 'text', text: 'hello' },
        ],
      }],
    };
    const { mapping } = await redactBody(localConfig(), body);
    // The base64 image data must survive untouched.
    assert.equal((body.messages as any)[0].content[0].source.data, SECRET);
    assert.equal(Object.keys(mapping).length, 0);
  });

  it('skips Gemini inlineData parts but redacts sibling text', async () => {
    const body: Record<string, unknown> = {
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: SECRET }, text: SECRET },
          { text: `gem ${SECRET}` },
        ],
      }],
    };
    await redactBody(localConfig(), body);
    const parts = (body.contents as any)[0].parts;
    assert.equal(parts[0].inlineData.data, SECRET, 'inlineData part is skipped entirely');
    assert.equal((parts[1].text as string).includes(SECRET), false, 'plain text part is redacted');
  });

  it('no-ops on a body with no text refs', async () => {
    const body: Record<string, unknown> = { model: 'x' };
    const { mapping } = await redactBody(localConfig(), body);
    assert.deepEqual(mapping, {});
  });

  it('skips redaction when combined text exceeds maxChars', async () => {
    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content: `${SECRET} padding` }],
    };
    const { mapping } = await redactBody(localConfig({ maxChars: 10 }), body);
    assert.deepEqual(mapping, {});
    assert.equal((body.messages as any)[0].content.includes(SECRET), true, 'left unredacted under cap');
  });
});

// ---------------------------------------------------------------------------
// redactBody — sidecar mode (fail-closed)
// ---------------------------------------------------------------------------

describe('redactBody — sidecar mode', () => {
  const realFetch = globalThis.fetch;
  after(() => { globalThis.fetch = realFetch; });

  const sidecarConfig = (): PrivacyFilterConfig =>
    getPrivacyFilterConfig({ PRIVACY_FILTER_URL: 'http://localhost:9999' } as any, null)!;

  it('applies the redacted[] array and mapping from a healthy sidecar', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ redacted: ['clean text'], mapping: { '\u27e6PII:0\u27e7': 'Alice' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as any;

    const body: Record<string, unknown> = { messages: [{ role: 'user', content: 'Alice was here' }] };
    const { mapping } = await redactBody(sidecarConfig(), body);
    assert.equal((body.messages as any)[0].content, 'clean text');
    assert.equal(mapping['\u27e6PII:0\u27e7'], 'Alice');
  });

  it('throws (fail-closed) when the sidecar is unreachable', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as any;
    const body: Record<string, unknown> = { messages: [{ role: 'user', content: 'x' }] };
    await assert.rejects(redactBody(sidecarConfig(), body), /privacy filter unavailable/);
  });

  it('throws when the sidecar returns a non-ok status', async () => {
    globalThis.fetch = (async () => new Response('err', { status: 500 })) as any;
    const body: Record<string, unknown> = { messages: [{ role: 'user', content: 'x' }] };
    await assert.rejects(redactBody(sidecarConfig(), body), /privacy filter unavailable/);
  });

  it('throws when redacted[] length does not match the text refs', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ redacted: ['a', 'b'], mapping: {} }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as any;
    const body: Record<string, unknown> = { messages: [{ role: 'user', content: 'only one' }] };
    await assert.rejects(redactBody(sidecarConfig(), body), /malformed response/);
  });
});

// ---------------------------------------------------------------------------
// restoreText
// ---------------------------------------------------------------------------

describe('restoreText', () => {
  it('replaces known sentinels and leaves unknown ones intact', () => {
    const mapping = { '\u27e6HASH:0\u27e7': 'secret' };
    assert.equal(restoreText('here is \u27e6HASH:0\u27e7 done', mapping), 'here is secret done');
    assert.equal(restoreText('unknown \u27e6PII:5\u27e7 stays', mapping), 'unknown \u27e6PII:5\u27e7 stays');
  });

  it('returns input unchanged when mapping is empty', () => {
    assert.equal(restoreText('\u27e6HASH:0\u27e7', {}), '\u27e6HASH:0\u27e7');
  });
});

// ---------------------------------------------------------------------------
// createRestoreTransformStream
// ---------------------------------------------------------------------------

async function pump(stream: TransformStream<Uint8Array, Uint8Array>, chunks: string[]): Promise<string> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  let out = '';
  const readAll = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
  })();
  for (const c of chunks) await writer.write(enc.encode(c));
  await writer.close();
  await readAll;
  return out;
}

describe('createRestoreTransformStream', () => {
  it('passes chunks through untouched when the mapping is empty', async () => {
    const out = await pump(createRestoreTransformStream({}), ['hello ', 'world']);
    assert.equal(out, 'hello world');
  });

  it('restores a sentinel that is split across two chunks', async () => {
    const mapping = { '\u27e6HASH:0\u27e7': 'RESTORED' };
    const out = await pump(createRestoreTransformStream(mapping), ['before \u27e6HAS', 'H:0\u27e7 after']);
    assert.equal(out, 'before RESTORED after');
  });

  it('restores sentinels contained within a single chunk', async () => {
    const mapping = { '\u27e6PII:0\u27e7': 'Bob' };
    const out = await pump(createRestoreTransformStream(mapping), ['hi \u27e6PII:0\u27e7!']);
    assert.equal(out, 'hi Bob!');
  });
});
