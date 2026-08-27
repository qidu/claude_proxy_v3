/**
 * Unit tests for the dashboard quota endpoint's model-keyed header fallback:
 * GET /dashboard/api/quota?model=<id> on a route whose host has no usage
 * provider (e.g. a local anthropic-compatible pi proxy) must fall back to
 * the passively recorded anthropic-ratelimit-unified-5h-utilization header —
 * looked up under the upstream model name (route.modelAlias), not the
 * config key. See handleDashboardModelQuota in src/handlers/dashboard.ts.
 *
 * Run with: npx tsx --test tests/unit/dashboard-quota.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { handleDashboardModelQuota } from '../../src/handlers/dashboard.js';
import { recordUpstreamRateLimit } from '../../src/utils/provider-quota.js';
import type { ProxyConfig } from '../../src/utils/config-loader.js';

const HDR = 'anthropic-ratelimit-unified-5h-utilization';

// Routes mimic the array form the runtime config uses for inline-table
// entries: [target, base_url, api_key, mode].
const config = {
  models: {
    free: {
      codelite: ['code-lite-pi', 'http://192.168.68.179:3000', '', 'anthropic-messages'],
      codesmall: ['code-small-pi', 'http://192.168.68.179:3000', '', 'anthropic-messages'],
    },
  },
} as unknown as ProxyConfig;

function quotaRequest(model: string): Request {
  return new Request(`http://localhost:8788/dashboard/api/quota?model=${encodeURIComponent(model)}`);
}

describe('handleDashboardModelQuota model-keyed header fallback', () => {
  it('unsupported-host model falls back to the header recorded under the upstream name', async () => {
    // The claude handler records under route.modelAlias, not the config key.
    recordUpstreamRateLimit('code-lite-pi', (name) => (name === HDR ? '0.25' : null), 'http://192.168.68.179:3000/v1/messages');

    const res = await handleDashboardModelQuota(quotaRequest('codelite'), config);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.provider, 'anthropic-5h');
    assert.equal(json.source, 'response-header');
    assert.equal(json.left, '75%');
  });

  it('no recorded header → 404 unsupported (nothing to show)', async () => {
    // codesmall shares the base URL but has never carried the header on a
    // response; the per-model lookup must miss rather than leak the value
    // recorded for a sibling model.
    const res = await handleDashboardModelQuota(quotaRequest('codesmall'), config);
    assert.equal(res.status, 404);
    const json = await res.json();
    assert.equal(json.ok, false);
    assert.equal(json.kind, 'unsupported');
  });

  it('recording under the config key alone (no route alias) still resolves', async () => {
    // Un-aliased model: recording key == config key, route.modelAlias is
    // undefined and the lookup falls back to the requested name.
    const cfg = {
      models: { free: { minimax: ['minimax', 'http://192.168.68.179:3000', '', 'anthropic-messages'] } },
    } as unknown as ProxyConfig;
    recordUpstreamRateLimit('minimax', (name) => (name === HDR ? '0.5' : null));
    const res = await handleDashboardModelQuota(quotaRequest('minimax'), cfg);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.left, '50%');
  });
});
