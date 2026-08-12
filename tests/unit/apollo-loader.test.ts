/**
 * Unit tests for src/utils/apollo-loader.ts
 *
 * Covers:
 *   - parseApolloFile(): TOML-style parsing, missing-field errors, quoting,
 *     comment/blank-line handling, apollo: header tolerance.
 *   - fetchApolloConfig(): URL construction, Apollo HMAC-SHA1 auth header
 *     scheme (Authorization + Timestamp), configurations join behaviour,
 *     error paths (non-ok, missing configurations, empty configurations),
 *     empty-secret → no auth headers.
 *
 * All HTTP is mocked via globalThis.fetch; no network is hit. The connection
 * values (app_id/cluster/namespace/meta) match the real Qiniu test instance
 * for realism, but `access_key_secret` is a FAKE plaintext key — see
 * https://www.apolloconfig.com/ and src/utils/apollo-loader.ts for why an
 * `enc:AES256GCMv1:`-wrapped value is NOT used here (the loader treats the
 * secret as a plaintext HMAC-SHA1 key; any enc:/AES layer must be resolved
 * before it reaches the loader).
 *
 * Run with: npx tsx --test tests/unit/apollo-loader.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { parseApolloFile, fetchApolloConfig, ApolloConfig } from '../../src/utils/apollo-loader.js';

// Realistic connection data (the real Qiniu test instance). The secret is fake
// — a unit test never needs the real key because fetch is mocked; the HMAC
// math is verified by recomputing the signature in-test.
const FAKE_SECRET = 'fake-hmac-key-for-unit-test';
const BASE_APOLLO: ApolloConfig = {
  app_id: 'test',
  cluster: 'default',
  namespace: 'model_proxy_v3_test',
  meta: 'https://test-apollo-config.example.com',
  access_key_secret: FAKE_SECRET,
};

const EXPECTED_URL_BASE =
  'https://test-apollo-config.example.com/configs/test/default/model_proxy_v3_test';

/**
 * detectLocalIp() runs against the host's real NICs and the result (or '' if
 * none) is appended to the request as `?ip=<addr>`. Tests must therefore
 * tolerate an optional `?ip=...` suffix on the URL. This helper strips it so
 * we can assert on the stable part of the URL.
 */
function stripIpQuery(url: string): { base: string; ipQuery: string } {
  const i = url.indexOf('?ip=');
  return i < 0
    ? { base: url, ipQuery: '' }
    : { base: url.slice(0, i), ipQuery: url.slice(i) };
}

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
}

let captured: CapturedRequest[] = [];
let nextResponse: (() => Response) = () => new Response('{}', { status: 200 });

function installMockFetch(responder: (req: CapturedRequest) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h instanceof Headers) h.forEach((v, k) => { headers[k] = v; });
    else if (Array.isArray(h)) for (const [k, v] of h) headers[k] = String(v);
    else if (h) Object.assign(headers, h);
    const req = { url, headers };
    captured.push(req);
    return responder(req);
  }) as typeof fetch;
}

beforeEach(() => { captured = []; });
afterEach(() => { globalThis.fetch = realFetch; });

// ---------------------------------------------------------------------------
// parseApolloFile
// ---------------------------------------------------------------------------
describe('parseApolloFile', () => {
  it('parses all 5 fields from the TOML-style format', () => {
    const content = `
      # leading comment
      apollo:
      app_id = "test"
      cluster = "default"
      namespace = "model_proxy_v3_test"
      meta = "https://test-apollo-config.example.com"
      access_key_secret = "the-key"
    `;
    assert.deepEqual(parseApolloFile(content), {
      app_id: 'test',
      cluster: 'default',
      namespace: 'model_proxy_v3_test',
      meta: 'https://test-apollo-config.example.com',
      access_key_secret: 'the-key',
    });
  });

  it('accepts single-quoted values', () => {
    const content = `
      apollo:
      app_id = 'test'
      cluster = 'default'
      namespace = 'ns'
      meta = 'https://m.example'
      access_key_secret = 'sec'
    `;
    assert.equal(parseApolloFile(content).app_id, 'test');
    assert.equal(parseApolloFile(content).meta, 'https://m.example');
    assert.equal(parseApolloFile(content).access_key_secret, 'sec');
  });

  it('ignores unknown keys, comments, blank lines, and the apollo: header', () => {
    const content = `
      apollo:
      # a comment
      extra_field = "ignored"

      app_id = "test"
      cluster = "default"
      namespace = "model_proxy_v3_test"
      meta = "https://x.example"
      access_key_secret = "k"
    `;
    const parsed = parseApolloFile(content);
    assert.equal(parsed.app_id, 'test');
    // Unknown field must not leak into the result (parseApolloFile returns
    // only the 5 typed fields — verify no extra props).
    assert.deepEqual(Object.keys(parsed).sort(), [
      'access_key_secret', 'app_id', 'cluster', 'meta', 'namespace',
    ]);
  });

  it('throws listing every missing required field at once', () => {
    // Omit cluster + meta — both should be named in the error.
    const content = `
      apollo:
      app_id = "test"
      namespace = "ns"
      access_key_secret = "k"
    `;
    assert.throws(
      () => parseApolloFile(content),
      /missing required field\(s\):.*cluster.*meta|.*meta.*cluster/,
      'error should list both missing fields (cluster + meta) in one message',
    );
  });

  it('throws when the file is empty', () => {
    assert.throws(
      () => parseApolloFile(''),
      /missing required field\(s\):/,
    );
  });
});

// ---------------------------------------------------------------------------
// fetchApolloConfig — URL construction + auth
// ---------------------------------------------------------------------------
describe('fetchApolloConfig: URL + Apollo HMAC-SHA1 auth', () => {
  it('constructs the correct Config Service URL (meta / configs / app / cluster / namespace)', async () => {
    installMockFetch(() => new Response(
      JSON.stringify({ configurations: { k: '[general]\n' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    await fetchApolloConfig(BASE_APOLLO);
    assert.equal(captured.length, 1);
    const { base, ipQuery } = stripIpQuery(captured[0].url);
    assert.equal(base, EXPECTED_URL_BASE);
    // ipQuery is '' when the host has no routable IPv4 (e.g. CI), or
    // '?ip=<local-lan-addr>' otherwise. Both are acceptable — assert the
    // shape, not the value.
    assert.match(ipQuery, /^$|^\?ip=\d+\.\d+\.\d+\.\d+$/);
  });

  it('strips trailing slashes from meta before building the URL', async () => {
    installMockFetch(() => new Response(
      JSON.stringify({ configurations: { k: 'v' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    await fetchApolloConfig({ ...BASE_APOLLO, meta: 'https://test-apollo-config.example.com///' });
    const { base } = stripIpQuery(captured[0].url);
    assert.equal(base, EXPECTED_URL_BASE);
  });

  it('URL-encodes app_id / cluster / namespace segments', async () => {
    installMockFetch(() => new Response(
      JSON.stringify({ configurations: { k: 'v' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    await fetchApolloConfig({
      ...BASE_APOLLO,
      app_id: 'a b/c',
      cluster: 'd+e',
      namespace: 'ns x',
    });
    // Each path segment must be percent-encoded, never raw.
    const { base } = stripIpQuery(captured[0].url);
    assert.equal(
      base,
      'https://test-apollo-config.example.com/configs/a%20b%2Fc/d%2Be/ns%20x',
    );
  });

  it('sends Authorization: Apollo <appId>:<sig> AND a Timestamp header', async () => {
    installMockFetch(() => new Response(
      JSON.stringify({ configurations: { k: 'v' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    await fetchApolloConfig(BASE_APOLLO);

    const h = captured[0].headers;
    assert.ok(h.Timestamp, 'Timestamp header must be present');
    assert.match(h.Authorization, /^Apollo test:[A-Za-z0-9+/=]+$/);
  });

  it('signature = base64(HMAC-SHA1(secret, "<timestamp>\\n<path?query>")) — Apollo signing convention', async () => {
    installMockFetch(() => new Response(
      JSON.stringify({ configurations: { k: 'v' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    await fetchApolloConfig(BASE_APOLLO);

    const h = captured[0].headers;
    const ts = h.Timestamp;
    const sentSig = h.Authorization.split('Apollo test:')[1];

    // Independently recompute the signature over the FULL path+query
    // (Apollo's signing convention — the ?ip= query is part of the signed
    // string, so the server sees the same signature we sent).
    const u = new URL(captured[0].url);
    const pathWithQuery = u.pathname + (u.search || '');
    const expectedSig = createHmac('sha1', FAKE_SECRET)
      .update(`${ts}\n${pathWithQuery}`)
      .digest()
      .toString('base64');

    assert.equal(sentSig, expectedSig,
      'sent signature must equal HMAC-SHA1(secret, "<ts>\\n<path?query>")');
  });

  it('does NOT send the raw secret in any header (secret is the HMAC key only)', async () => {
    installMockFetch(() => new Response(
      JSON.stringify({ configurations: { k: 'v' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    await fetchApolloConfig(BASE_APOLLO);

    const headerBlob = JSON.stringify(captured[0].headers);
    assert.equal(headerBlob.includes(FAKE_SECRET), false,
      'raw secret must never appear in request headers');
  });

  it('omits Authorization + Timestamp entirely when secret is empty', async () => {
    installMockFetch(() => new Response(
      JSON.stringify({ configurations: { k: 'v' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    await fetchApolloConfig({ ...BASE_APOLLO, access_key_secret: '' });
    const h = captured[0].headers;
    assert.equal(h.Authorization, undefined);
    assert.equal(h.Timestamp, undefined);
  });
});

// ---------------------------------------------------------------------------
// fetchApolloConfig — body handling
// ---------------------------------------------------------------------------
describe('fetchApolloConfig: configurations payload', () => {
  it('returns a single configurations value as-is', async () => {
    const toml = '[general]\nglobal_token_limit = "10B 1w"\n';
    installMockFetch(() => new Response(
      JSON.stringify({ configurations: { 'proxy_config.toml': toml } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    assert.equal(await fetchApolloConfig(BASE_APOLLO), toml);
  });

  it('joins multiple configurations values with \\n in iteration order', async () => {
    installMockFetch(() => new Response(
      JSON.stringify({ configurations: { a: 'AAA', b: 'BBB', c: 'CCC' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const out = await fetchApolloConfig(BASE_APOLLO);
    // Object.values() iteration order is insertion order for string keys.
    assert.equal(out, 'AAA\nBBB\nCCC');
  });

  it('tolerates a trailing slash on meta when extracting configurations', async () => {
    installMockFetch(() => new Response(
      JSON.stringify({ configurations: { x: 'y' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    const out = await fetchApolloConfig({ ...BASE_APOLLO, meta: 'https://m.example/' });
    assert.equal(out, 'y');
  });
});

// ---------------------------------------------------------------------------
// fetchApolloConfig — error paths (fail-loud, project rule #8)
// ---------------------------------------------------------------------------
describe('fetchApolloConfig: error paths', () => {
  it('throws on HTTP non-ok with status + URL in the message', async () => {
    installMockFetch(() => new Response('Unauthorized', { status: 401 }));
    await assert.rejects(
      fetchApolloConfig(BASE_APOLLO),
      /Failed to fetch config from Apollo at .*\/configs\/test\/default\/model_proxy_v3_test(\?ip=[\d.]+)?: 401/,
    );
  });

  it('throws when the response body has no configurations object', async () => {
    installMockFetch(() => new Response(
      JSON.stringify({ appId: 'test', cluster: 'default', namespace: 'ns' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    await assert.rejects(
      fetchApolloConfig(BASE_APOLLO),
      /did not contain a 'configurations' object/,
    );
  });

  it('throws when configurations is an empty object', async () => {
    installMockFetch(() => new Response(
      JSON.stringify({ configurations: {} }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    await assert.rejects(
      fetchApolloConfig(BASE_APOLLO),
      /has an empty 'configurations' object/,
    );
  });

  it('throws when configurations is null', async () => {
    installMockFetch(() => new Response(
      JSON.stringify({ configurations: null }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    await assert.rejects(
      fetchApolloConfig(BASE_APOLLO),
      /did not contain a 'configurations' object/,
    );
  });
});
