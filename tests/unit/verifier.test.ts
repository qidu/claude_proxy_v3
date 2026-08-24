/**
 * Unit tests for utils/verifier.ts
 *
 * Covers: getVerifierConfig (disabled / URL validation / env knobs),
 * redeemVerifierGrant (the four ordered checks — sidecar origin, grant
 * existence, exhaustion/expiry, model allowlist — plus grant-identity
 * propagation and the never-trust-the-callback's-own-credentials rule),
 * the OTAC grant lifecycle (mint on dispatch, revoke in finally, admission
 * ceiling from the PPT bound, otac_max_reuse clamp), and runVerifier against
 * a mocked sidecar (winner unwrapping, fail-open on every failure mode,
 * non-openai-completions scorer refusal).
 *
 * Run with: npx tsx --test tests/unit/verifier.test.ts
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getVerifierConfig,
  redeemVerifierGrant,
  revokeVerifierGrant,
  runVerifier,
  type VerifierConfig,
} from '../../src/utils/verifier.js';
import type { VerifierPlan } from '../../src/utils/config-loader.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIDECAR_URL = 'http://127.0.0.1:8790';

function makeConfig(overrides: Partial<VerifierConfig> = {}): VerifierConfig {
  return {
    url: SIDECAR_URL,
    failOpen: true,
    timeoutMs: 300000,
    sidecarIps: new Set(['127.0.0.1', '::1']),
    callMargin: 1.25,
    ...overrides,
  };
}

function makePlan(overrides: Partial<VerifierPlan> = {}): VerifierPlan {
  return {
    alias: 'bo5',
    target: {
      modelName: 'target-model',
      route: { targetUrl: 'http://127.0.0.1:9001', upstreamMode: 'openai-completions' } as any,
    },
    scorer: {
      modelName: 'scorer-model',
      route: { targetUrl: 'http://127.0.0.1:9002', upstreamMode: 'openai-completions' } as any,
    },
    options: {
      samples: 5,
      temperature: 1.0,
      n_evaluations: 4,
      pivots: 2,
    } as VerifierPlan['options'],
    ...overrides,
  };
}

const BODY = {
  model: 'bo5',
  messages: [{ role: 'user', content: 'what is 2+2?' }],
};

const AUTH_HEADERS = { Authorization: 'Bearer caller-secret-key' };

/** A `/select` response carrying a winning OpenAI choice. */
function okSidecar(winnerText: string): Response {
  return new Response(
    JSON.stringify({
      index: 0,
      winner: { index: 0, message: { role: 'assistant', content: winnerText }, finish_reason: 'stop' },
      scores: [1, 0],
      ranking: [0, 1],
      n_comparisons: 7,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** Build an inbound sidecar callback request. */
function callback(opts: {
  otac?: string;
  clientAddress?: string;
  model?: string;
  requestId?: string;
} = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.otac !== undefined) headers.one_time_auth_code = opts.otac;
  if (opts.clientAddress !== undefined) headers['x-client-address'] = opts.clientAddress;
  if (opts.requestId !== undefined) headers['x-request-id'] = opts.requestId;
  headers['Content-Type'] = 'application/json';
  return new Request('http://proxy.local/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: opts.model ?? 'target-model', messages: [] }),
  });
}

const ENV = { VERIFIER_URL: SIDECAR_URL } as any;

/**
 * Run one dispatch and capture the OTAC the sidecar was called with, so tests
 * can exercise redemption against a grant that is genuinely live (the grant
 * table is module-private by design, so this is the only legitimate handle).
 */
async function captureOtac(
  plan: VerifierPlan = makePlan(),
  config: VerifierConfig = makeConfig(),
): Promise<{ otac: string; release: () => void; done: Promise<Response | null> }> {
  let seenOtac = '';
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });

  globalThis.fetch = (async (_u: any, init: any) => {
    seenOtac = init.headers.one_time_auth_code;
    await gate; // hold the grant open until the test releases it
    return okSidecar('winner');
  }) as any;

  const done = runVerifier(config, plan, BODY, 'req-1', AUTH_HEADERS, 'user-key-1');
  // Yield until the mocked fetch has recorded the OTAC.
  while (!seenOtac) await new Promise((r) => setImmediate(r));
  return { otac: seenOtac, release, done };
}

// ---------------------------------------------------------------------------
// getVerifierConfig
// ---------------------------------------------------------------------------

describe('getVerifierConfig', () => {
  it('returns null when VERIFIER_URL is unset', () => {
    assert.equal(getVerifierConfig({} as any), null);
  });

  it('builds defaults from a valid internal URL and strips trailing slashes', () => {
    const cfg = getVerifierConfig({ VERIFIER_URL: 'http://localhost:8790//' } as any);
    assert.ok(cfg);
    assert.equal(cfg!.url, 'http://localhost:8790');
    assert.equal(cfg!.failOpen, true);
    assert.equal(cfg!.timeoutMs, 300000);
    assert.equal(cfg!.callMargin, 1.25);
    assert.deepEqual([...cfg!.sidecarIps].sort(), ['127.0.0.1', '::1']);
    assert.equal(cfg!.criteria, undefined);
  });

  it('rejects a non-internal sidecar host', () => {
    assert.throws(
      () => getVerifierConfig({ VERIFIER_URL: 'http://verifier.example.com' } as any),
      /localhost or a private\/LAN address/,
    );
  });

  it('rejects a non-http(s) protocol', () => {
    assert.throws(
      () => getVerifierConfig({ VERIFIER_URL: 'file://localhost' } as any),
      /must use http or https/,
    );
  });

  it('rejects an unparseable URL', () => {
    assert.throws(
      () => getVerifierConfig({ VERIFIER_URL: 'not a url' } as any),
      /not a valid URL/,
    );
  });

  it('parses sidecar IPs, fail-open override, criteria, and numeric knobs', () => {
    const cfg = getVerifierConfig({
      VERIFIER_URL: SIDECAR_URL,
      VERIFIER_SIDECAR_IPS: '10.0.0.5, 127.0.0.1',
      VERIFIER_FAIL_OPEN: 'false',
      VERIFIER_TIMEOUT_MS: '1500',
      VERIFIER_CALL_MARGIN: '2',
      VERIFIER_CRITERIA: 'terminal_bench_2.1',
    } as any);
    assert.ok(cfg);
    assert.deepEqual([...cfg!.sidecarIps].sort(), ['10.0.0.5', '127.0.0.1']);
    assert.equal(cfg!.failOpen, false);
    assert.equal(cfg!.timeoutMs, 1500);
    assert.equal(cfg!.callMargin, 2);
    assert.equal(cfg!.criteria, 'terminal_bench_2.1');
  });

  it('treats "0" as fail-closed, like kompress', () => {
    const cfg = getVerifierConfig({ VERIFIER_URL: SIDECAR_URL, VERIFIER_FAIL_OPEN: '0' } as any);
    assert.equal(cfg!.failOpen, false);
  });

  it('falls back to defaults on non-numeric or out-of-range knobs', () => {
    const cfg = getVerifierConfig({
      VERIFIER_URL: SIDECAR_URL,
      VERIFIER_TIMEOUT_MS: 'soon',
      VERIFIER_CALL_MARGIN: '0.5', // < 1 would under-provision the grant
    } as any);
    assert.equal(cfg!.timeoutMs, 300000);
    assert.equal(cfg!.callMargin, 1.25);
  });
});

// ---------------------------------------------------------------------------
// runVerifier — dispatch, winner unwrapping, fail-open
// ---------------------------------------------------------------------------

describe('runVerifier', () => {
  const realFetch = globalThis.fetch;
  after(() => { globalThis.fetch = realFetch; });

  it('returns the winning choice wrapped as a chat.completion', async () => {
    globalThis.fetch = (async () => okSidecar('four')) as any;
    const resp = await runVerifier(makeConfig(), makePlan(), BODY, 'req-1', AUTH_HEADERS, 'user-key-1');
    assert.ok(resp);
    const json = await resp!.json() as any;
    assert.equal(json.object, 'chat.completion');
    assert.equal(json.model, 'target-model');
    assert.equal(json.choices.length, 1);
    assert.equal(json.choices[0].message.content, 'four');
  });

  it('posts /select with the contract serve.py requires', async () => {
    let seenUrl = '';
    let seenBody: any;
    let seenHeaders: any;
    globalThis.fetch = (async (u: any, init: any) => {
      seenUrl = String(u);
      seenBody = JSON.parse(init.body);
      seenHeaders = init.headers;
      return okSidecar('w');
    }) as any;

    await runVerifier(makeConfig(), makePlan(), BODY, 'req-42', AUTH_HEADERS, 'user-key-1');

    assert.equal(seenUrl, `${SIDECAR_URL}/select`);
    // scorer_model is required and must never be defaulted away.
    assert.equal(seenBody.model, 'target-model');
    assert.equal(seenBody.scorer_model, 'scorer-model');
    assert.equal(seenBody.samples, 5);
    assert.equal(seenBody.pivots, 2);
    assert.equal(seenBody.n_evaluations, 4);
    assert.equal(seenBody.problem, 'what is 2+2?');
    assert.deepEqual(seenBody.messages, BODY.messages);
    assert.equal(seenBody.alias, 'bo5');
    assert.equal(seenHeaders['x-request-id'], 'req-42');
    assert.ok(seenHeaders.one_time_auth_code.startsWith('otac_'));
    // The sidecar holds no credentials: the caller's key must not be forwarded.
    assert.equal(seenHeaders.Authorization, undefined);
  });

  it('prefers per-alias criteria over the env default', async () => {
    let seenBody: any;
    globalThis.fetch = (async (_u: any, init: any) => { seenBody = JSON.parse(init.body); return okSidecar('w'); }) as any;

    const plan = makePlan();
    (plan.options as any).criteria = 'alias-criteria';
    await runVerifier(makeConfig({ criteria: 'env-criteria' }), plan, BODY, 'r', AUTH_HEADERS, 'u');
    assert.equal(seenBody.criteria, 'alias-criteria');

    const plainPlan = makePlan();
    await runVerifier(makeConfig({ criteria: 'env-criteria' }), plainPlan, BODY, 'r', AUTH_HEADERS, 'u');
    assert.equal(seenBody.criteria, 'env-criteria');
  });

  it('fails open (null) when the scorer route is not openai-completions', async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return okSidecar('w'); }) as any;

    const plan = makePlan();
    (plan.scorer.route as any).upstreamMode = 'anthropic-messages';
    const resp = await runVerifier(makeConfig(), plan, BODY, 'r', AUTH_HEADERS, 'u');

    assert.equal(resp, null);
    // Refused before dispatch — a tournament with no logprobs is all ties.
    assert.equal(called, false);
  });

  it('fails open on a network error', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as any;
    assert.equal(await runVerifier(makeConfig(), makePlan(), BODY, 'r', AUTH_HEADERS, 'u'), null);
  });

  it('fails open on a non-2xx (the on_error="raise" surface)', async () => {
    globalThis.fetch = (async () => new Response('tournament aborted', { status: 502 })) as any;
    assert.equal(await runVerifier(makeConfig(), makePlan(), BODY, 'r', AUTH_HEADERS, 'u'), null);
  });

  it('fails open on invalid JSON', async () => {
    globalThis.fetch = (async () => new Response('not json', { status: 200 })) as any;
    assert.equal(await runVerifier(makeConfig(), makePlan(), BODY, 'r', AUTH_HEADERS, 'u'), null);
  });

  it('fails open when the response has no winner', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ index: 0, scores: [] }), { status: 200 })) as any;
    assert.equal(await runVerifier(makeConfig(), makePlan(), BODY, 'r', AUTH_HEADERS, 'u'), null);
  });
});

// ---------------------------------------------------------------------------
// Grant lifecycle + redeemVerifierGrant
// ---------------------------------------------------------------------------

describe('verifier grant lifecycle', () => {
  const realFetch = globalThis.fetch;
  after(() => { globalThis.fetch = realFetch; });

  it('mints a grant that redeems for the ORIGINAL caller credentials', async () => {
    const { otac, release, done } = await captureOtac();

    const verdict = await redeemVerifierGrant(callback({ otac, clientAddress: '127.0.0.1' }), ENV);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.status, 200);
    // The grant's identity, never the callback's own.
    assert.deepEqual(verdict.authHeaders, AUTH_HEADERS);
    assert.equal(verdict.requestId, 'req-1');
    assert.equal(verdict.aliasName, 'bo5');
    assert.equal(verdict.userKey, 'user-key-1');

    release();
    await done;
  });

  it('revokes the grant once /select settles', async () => {
    const { otac, release, done } = await captureOtac();
    release();
    await done;

    const verdict = await redeemVerifierGrant(callback({ otac, clientAddress: '127.0.0.1' }), ENV);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.status, 401);
    assert.match(verdict.error!, /invalid or expired/);
  });

  it('revokes the grant even when the sidecar call fails', async () => {
    let seenOtac = '';
    globalThis.fetch = (async (_u: any, init: any) => {
      seenOtac = init.headers.one_time_auth_code;
      throw new Error('ECONNREFUSED');
    }) as any;

    assert.equal(await runVerifier(makeConfig(), makePlan(), BODY, 'r', AUTH_HEADERS, 'u'), null);
    const verdict = await redeemVerifierGrant(callback({ otac: seenOtac, clientAddress: '127.0.0.1' }), ENV);
    assert.equal(verdict.ok, false);
  });

  it('rejects a callback from a non-sidecar address', async () => {
    const { otac, release, done } = await captureOtac();

    const verdict = await redeemVerifierGrant(callback({ otac, clientAddress: '203.0.113.9' }), ENV);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.status, 401);
    assert.match(verdict.error!, /origin not allowed/);

    release();
    await done;
  });

  it('never trusts x-forwarded-for for the origin check', async () => {
    const { otac, release, done } = await captureOtac();

    // Spoofed forwarding headers, real socket address is off-list.
    const req = new Request('http://proxy.local/v1/chat/completions', {
      method: 'POST',
      headers: {
        one_time_auth_code: otac,
        'x-client-address': '203.0.113.9',
        'x-forwarded-for': '127.0.0.1',
        'x-real-ip': '127.0.0.1',
      },
      body: JSON.stringify({ model: 'target-model', messages: [] }),
    });
    const verdict = await redeemVerifierGrant(req, ENV);
    assert.equal(verdict.ok, false);
    assert.match(verdict.error!, /origin not allowed/);

    release();
    await done;
  });

  it('rejects a callback with no address header at all', async () => {
    const { otac, release, done } = await captureOtac();
    const verdict = await redeemVerifierGrant(callback({ otac }), ENV);
    assert.equal(verdict.ok, false);
    assert.match(verdict.error!, /origin not allowed/);
    release();
    await done;
  });

  it('rejects a missing one_time_auth_code', async () => {
    const verdict = await redeemVerifierGrant(callback({ clientAddress: '127.0.0.1' }), ENV);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.status, 401);
    assert.match(verdict.error!, /missing one_time_auth_code/);
  });

  it('rejects an unknown code', async () => {
    const verdict = await redeemVerifierGrant(
      callback({ otac: 'otac_deadbeef', clientAddress: '127.0.0.1' }),
      ENV,
    );
    assert.equal(verdict.ok, false);
    assert.equal(verdict.status, 401);
  });

  it('rejects when the verifier is disabled entirely (deny by default)', async () => {
    const { otac, release, done } = await captureOtac();
    const verdict = await redeemVerifierGrant(callback({ otac, clientAddress: '127.0.0.1' }), {} as any);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.status, 401);
    assert.match(verdict.error!, /verifier disabled/);
    release();
    await done;
  });

  it('permits both the target and scorer models, and nothing else', async () => {
    const { otac, release, done } = await captureOtac();

    for (const model of ['target-model', 'scorer-model']) {
      const ok = await redeemVerifierGrant(callback({ otac, clientAddress: '127.0.0.1', model }), ENV);
      assert.equal(ok.ok, true, `${model} should be permitted`);
    }

    const denied = await redeemVerifierGrant(
      callback({ otac, clientAddress: '127.0.0.1', model: 'some-expensive-model' }),
      ENV,
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 403);
    assert.match(denied.error!, /not permitted/);

    release();
    await done;
  });

  it('leaves the callback body readable after the allowlist peek', async () => {
    const { otac, release, done } = await captureOtac();
    const req = callback({ otac, clientAddress: '127.0.0.1' });

    assert.equal((await redeemVerifierGrant(req, ENV)).ok, true);
    // The peek used request.clone(), so the original stream is intact.
    const body = await req.json() as any;
    assert.equal(body.model, 'target-model');

    release();
    await done;
  });

  it('exhausts after the derived PPT call bound and then denies', async () => {
    // samples=2, pivots=2, n_evaluations=1, margin=1 →
    // k=2, comparisons = 2 + 2*(2-2) + C(2,2 -1)=1 → 3; scoring = 3*1 = 3;
    // bound = ceil((2 + 3) * 1) = 5.
    const plan = makePlan();
    plan.options.samples = 2;
    plan.options.pivots = 2;
    (plan.options as any).n_evaluations = 1;
    const { otac, release, done } = await captureOtac(plan, makeConfig({ callMargin: 1 }));

    let redeemed = 0;
    for (;;) {
      const v = await redeemVerifierGrant(callback({ otac, clientAddress: '127.0.0.1' }), ENV);
      if (!v.ok) break;
      redeemed++;
      assert.ok(redeemed < 50, 'grant should exhaust, not redeem forever');
    }
    assert.equal(redeemed, 5);

    const after = await redeemVerifierGrant(callback({ otac, clientAddress: '127.0.0.1' }), ENV);
    assert.equal(after.ok, false);
    assert.match(after.error!, /exhausted or expired/);

    release();
    await done;
  });

  it('lets otac_max_reuse lower the ceiling but never widen it', async () => {
    const plan = makePlan();
    (plan.options as any).otac_max_reuse = 2;
    const { otac, release, done } = await captureOtac(plan);

    assert.equal((await redeemVerifierGrant(callback({ otac, clientAddress: '127.0.0.1' }), ENV)).ok, true);
    assert.equal((await redeemVerifierGrant(callback({ otac, clientAddress: '127.0.0.1' }), ENV)).ok, true);
    const third = await redeemVerifierGrant(callback({ otac, clientAddress: '127.0.0.1' }), ENV);
    assert.equal(third.ok, false);
    assert.match(third.error!, /exhausted or expired/);

    release();
    await done;
  });

  it('denies a grant past its expiry', async () => {
    // timeoutMs=1 → the grant is already expired by the time we redeem.
    const { otac, release, done } = await captureOtac(makePlan(), makeConfig({ timeoutMs: 1 }));
    await new Promise((r) => setTimeout(r, 5));

    const verdict = await redeemVerifierGrant(callback({ otac, clientAddress: '127.0.0.1' }), ENV);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.status, 401);

    release();
    await done;
  });

  it('revokeVerifierGrant is idempotent', () => {
    assert.doesNotThrow(() => {
      revokeVerifierGrant('otac_never_existed');
      revokeVerifierGrant('otac_never_existed');
    });
  });
});
