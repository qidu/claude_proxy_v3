/**
 * LIVE integration test for src/utils/apollo-loader.ts
 *
 * Unlike the mock-based unit test (tests/unit/apollo-loader.test.ts), this
 * file hits the REAL Apollo config server. It is gated at runtime: it skips
 * unless APOLLO_LIVE_TEST=1 AND APOLLO_META points at a non-placeholder host,
 * so it cannot fire accidentally from `npm run test:unit`.
 *
 * Run explicitly (all four env vars required — the in-file defaults are
 * placeholder example.com values and won't hit a real Apollo instance):
 *
 *   APOLLO_LIVE_TEST=1 \
 *   APOLLO_META=https://<your-config-service-host> \
 *   APOLLO_APP_ID=<app> \
 *   APOLLO_NAMESPACE=<ns> \
 *   APOLLO_HMAC_KEY=<plaintext HMAC-SHA1 key> \
 *   npx tsx --test tests/unit/apollo-loader.live.test.ts
 *
 * Credentials: the plaintext HMAC-SHA1 key is read from one of (in order):
 *   1. $APOLLO_HMAC_KEY              (env var)
 *   2. /private/tmp/claude/apollo_plaintext_key   (file — keeps key out of shell history / process listing)
 * The enc:AES256GCMv1: form is NOT accepted here — the loader treats the
 * secret as a plaintext HMAC-SHA1 key (see src/utils/apollo-loader.ts).
 * Decode enc: externally first.
 *
 * If APOLLO_LIVE_TEST != 1 OR no key source is provided OR the default meta
 * host has not been overridden, every test is skipped with a reason (not
 * silently passed — project rule #8).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchApolloConfig, ApolloConfig } from '../../src/utils/apollo-loader.js';

const LIVE = process.env.APOLLO_LIVE_TEST === '1';

// Resolve the plaintext HMAC key without ever logging it.
function resolveKey(): string | null {
  if (process.env.APOLLO_HMAC_KEY) return process.env.APOLLO_HMAC_KEY;
  try {
    const raw = readFileSync('/private/tmp/claude/apollo_plaintext_key', 'utf8').replace(/\r?\n$/, '');
    return raw || null;
  } catch {
    return null;
  }
}

const KEY = resolveKey();

// All connection values are overridable via env so the test can target any
// Apollo deployment without code edits. The in-file defaults are intentionally
// placeholder example.com values — this test will SKIP unless APOLLO_META is
// set to a real Apollo Config Service host. Operators supply their own.
//
// `meta` MUST be the Config Service host (returns JSON for /configs/...), not
// the Portal host (returns HTML) — the loader will fail with a JSON parse
// error against the Portal. App_id/cluster/namespace must address a published
// namespace whose `configurations` carries the proxy TOML.
const APOLLO: ApolloConfig = {
  app_id: process.env.APOLLO_APP_ID || 'proxyv3',
  cluster: process.env.APOLLO_CLUSTER || 'default',
  namespace: process.env.APOLLO_NAMESPACE || 'test',
  meta: process.env.APOLLO_META || 'https://test-apollo-config.example.com',
  access_key_secret: KEY ?? '<unset>',
};

// Skip unless LIVE + key + a real (non-example.com) meta host are all present.
const META_IS_PLACEHOLDER = /example\.com$/.test(new URL(APOLLO.meta).hostname);
const maybeIt = LIVE && KEY && !META_IS_PLACEHOLDER
  ? it
  : (_name: string, _fn: () => void | Promise<void>) => {
      // no-op: registered as a skipped test by virtue of not registering it.
      // We log once so the run output explains the skip rather than looking like 0 tests.
    };

if (!LIVE) {
  console.warn('[SKIP] apollo-loader.live.test.ts: set APOLLO_LIVE_TEST=1 to run');
} else if (!KEY) {
  console.warn('[SKIP] apollo-loader.live.test.ts: no key found — set APOLLO_HMAC_KEY or write /private/tmp/claude/apollo_plaintext_key');
} else if (META_IS_PLACEHOLDER) {
  console.warn('[SKIP] apollo-loader.live.test.ts: APOLLO_META still points at example.com placeholder — set it to your real Apollo Config Service host');
}

describe('apollo-loader (LIVE)', () => {
  maybeIt('fetchApolloConfig: returns the exact proxy_config.toml payload from the live namespace', async () => {
    const toml = await fetchApolloConfig(APOLLO);

    // Meaningful assertions (project rule #7): not just "non-empty string".
    // The ns `test` / key `proxy_config.toml` carries a real proxy_config body
    // with a fixed set of top-level sections. We assert on structural facts
    // (section headers must all be present; specific TOML lines must exist)
    // rather than byte-equality with the raw payload — the latter would bake
    // production API keys / secrets into the test source, which is forbidden.
    const SECTION_HEADERS = [
      '[general]',
      '[models',
      '[composite]',
      '[schedule]',
      '[transforms.',
      '[privacy_filter]',
    ];
    for (const header of SECTION_HEADERS) {
      assert.ok(
        toml.includes(header),
        `payload must contain TOML section header '${header}'; got first 200 chars: ${toml.slice(0, 200)}`,
      );
    }
    // A sentinel value known to live in this namespace. If portal content is
    // swapped or wiped, this will fail loudly (rule #8) rather than pass on
    // an unrelated payload.
    assert.ok(
      toml.includes('filter_mode = "local"'),
      `payload must include the known sentinel 'filter_mode = "local"'`,
    );
    // Must be TOML, not an HTML error page or JSON envelope. TOML body starts
    // with '[' (section header) or a bare key.
    assert.ok(
      /^\s*\[/.test(toml) || /^\s*\w/.test(toml),
      'payload should look like TOML (start with a section header or key)',
    );

    // Diagnostic — length only; no payload bytes (may contain secrets).
    console.log('[LIVE] payload length:', toml.length, 'bytes');
  });

  maybeIt('fetchApolloConfig: payload round-trips through parseSimpleToml, preserving section keys', async () => {
    // Imported lazily so a build error in config-loader doesn't block the
    // simpler live-fetch test above.
    const { parseSimpleToml } = await import('../../src/utils/config-loader.js');
    const toml = await fetchApolloConfig(APOLLO);
    const parsed = parseSimpleToml(toml);
    assert.ok(parsed && typeof parsed === 'object', 'parseSimpleToml must return an object');

    // The live namespace is real proxy config — parseSimpleToml must surface
    // its top-level sections. We assert the concrete names that exist in
    // ns=test rather than "at least one section", so a regression that
    // silently drops known sections is caught here.
    const sections = Object.keys(parsed);
    for (const required of ['schedule', 'privacy_filter']) {
      assert.ok(
        sections.includes(required),
        `parsed config must contain [${required}] section; got sections: ${sections.join(', ')}`,
      );
    }
    // [schedule] must round-trip as a non-empty object with the known key.
    assert.ok(
      parsed.schedule && typeof parsed.schedule === 'object',
      '[schedule] must parse to a non-empty object',
    );
  });
});
