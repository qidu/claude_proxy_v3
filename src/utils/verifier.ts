/**
 * Best-of-N verifier plugin (`llm-as-a-verifier` / `serve.py` sidecar).
 *
 * Samples N candidates from a target model and ranks them with a Probabilistic
 * Pivot Tournament run by a Python sidecar (see
 * `submodules/llm-as-a-verifier/serve.py`), returning the winning choice
 * verbatim. Unlike kompress/privacy-filter, this plugin does not touch request
 * or response bodies in place — it is a full alternate dispatch path for a
 * `composite.*` alias, alongside coordinator and fusion. See
 * `docs/plan-llm-as-a-verifier-plugin.md`.
 *
 * Architecture, load-bearing:
 *
 *   - The sidecar holds NO credentials. This module mints a one-time auth code
 *     (OTAC) per `/select` call and registers a short-lived grant; the sidecar
 *     echoes the OTAC on every upstream generation/scoring call it makes back
 *     to this proxy, and `redeemVerifierGrant` exchanges it for the ORIGINAL
 *     CALLER's own auth headers. A static sidecar key would outrank the
 *     caller's key on the proxy's default tier and misbill every user.
 *   - `x-client-address` (injected by server.ts from the raw socket, never
 *     client-suppliable) is the ONLY signal used to gate sidecar-origin calls.
 *     `x-forwarded-for` / `x-real-ip` are attribution-only and MUST NEVER be
 *     used for authorization here.
 *   - The grant is the capability; `x-request-id` is correlation-only and
 *     authorizes nothing on its own.
 *   - `remainingCalls` is an ADMISSION check, computed once at grant mint time
 *     from the PPT comparison bound. It is never widened mid-flight, and
 *     `otac_max_reuse` (when set) only ever lowers that ceiling further.
 *   - Fails OPEN by default (like kompress, unlike privacy-filter): a sidecar
 *     outage, timeout, or aborted tournament falls back to one plain call to
 *     the target model. This is why the sidecar's `on_error="raise"` matters
 *     — without it, failures never surface as errors and fail-open never
 *     triggers, silently corrupting comparisons into coin-flip ties instead.
 *   - The grant table is module-private: never exported, never logged (only a
 *     validity verdict is), never surfaced on `/dashboard`, deleted in a
 *     `finally` when `/select` returns, and swept on insert against
 *     `expiresAt`.
 */

import type { Env, Logger } from '../types/shared.js';
import type { VerifierPlan } from './config-loader.js';
import { isInternalHost, transformAuthHeadersForUpstream } from './routing.js';

export interface VerifierConfig {
  url: string;
  failOpen: boolean;
  timeoutMs: number;
  sidecarIps: Set<string>;
  callMargin: number;
  criteria?: string;
}

/**
 * Read verifier configuration from env. Returns null when disabled (no
 * `VERIFIER_URL`), so callers can cheaply skip all work — mirrors
 * `getKompressConfig`.
 */
export function getVerifierConfig(env?: Env): VerifierConfig | null {
  const url = env?.VERIFIER_URL?.trim();
  if (!url) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`VERIFIER_URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`VERIFIER_URL must use http or https, got: ${parsed.protocol}`);
  }
  if (!isInternalHost(parsed.hostname)) {
    throw new Error(`VERIFIER_URL must point to localhost or a private/LAN address, got: ${parsed.hostname}`);
  }

  const sidecarIpsRaw = env?.VERIFIER_SIDECAR_IPS?.trim() || '127.0.0.1,::1';
  const sidecarIps = new Set(
    sidecarIpsRaw
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean),
  );

  // Covers N generations AND the full tournament — far higher than kompress's
  // single-fragment timeout.
  const timeoutParsed = Number(env?.VERIFIER_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(timeoutParsed) && timeoutParsed > 0 ? Math.floor(timeoutParsed) : 300000;

  const callMarginParsed = Number(env?.VERIFIER_CALL_MARGIN);
  const callMargin = Number.isFinite(callMarginParsed) && callMarginParsed >= 1 ? callMarginParsed : 1.25;

  const failOpen = env?.VERIFIER_FAIL_OPEN !== 'false' && env?.VERIFIER_FAIL_OPEN !== '0';

  const criteria = env?.VERIFIER_CRITERIA?.trim() || undefined;

  return {
    url: url.replace(/\/+$/, ''),
    failOpen,
    timeoutMs,
    sidecarIps,
    callMargin,
    criteria,
  };
}

/** One redeemable capability grant, keyed by OTAC. Never exported. */
interface VerifierGrant {
  requestId: string;
  aliasName: string;
  userKey: string;
  authHeaders: Record<string, string>;
  allowedModels: Set<string>;
  remainingCalls: number;
  expiresAt: number;
}

// Module-private grant table. Never exported, never logged, never surfaced on
// /dashboard (contrast compositeAliasStates, which is). Deleted in a finally
// when /select returns; swept on insert against expiresAt.
const verifierGrants: Map<string, VerifierGrant> = new Map();

/** Remove expired grants. Called on every insert — cheap, since the table is
 * small and short-lived (one entry per in-flight /select call). */
function sweepExpiredGrants(): void {
  const now = Date.now();
  for (const [code, grant] of verifierGrants) {
    if (grant.expiresAt <= now) {
      verifierGrants.delete(code);
    }
  }
}

/**
 * Constant-time string comparison. No existing helper for this in the
 * codebase — written from scratch because the OTAC is a bearer credential and
 * a short-circuiting `===` leaks timing information about how many leading
 * characters matched.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);

  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  const subtle = cryptoObj?.subtle as (SubtleCrypto & { timingSafeEqual?: (a: BufferSource, b: BufferSource) => boolean }) | undefined;
  if (subtle && typeof subtle.timingSafeEqual === 'function') {
    if (bufA.length !== bufB.length) {
      // Still run a comparison of equal-length buffers so the false branch
      // costs a similar amount of time as the true branch, rather than
      // returning instantly on a length mismatch.
      subtle.timingSafeEqual(bufA, bufA);
      return false;
    }
    return subtle.timingSafeEqual(bufA, bufB);
  }

  // Manual constant-time fallback: always walk the longer buffer's full
  // length, accumulate mismatches (including the length mismatch itself)
  // into one OR'd flag, and never branch on data.
  const len = Math.max(bufA.length, bufB.length);
  let diff = bufA.length ^ bufB.length;
  for (let i = 0; i < len; i++) {
    const byteA = i < bufA.length ? bufA[i] : 0;
    const byteB = i < bufB.length ? bufB[i] : 0;
    diff |= byteA ^ byteB;
  }
  return diff === 0;
}

/** Find a grant by OTAC using a constant-time compare against every key.
 * Map.get() itself is not timing-safe (V8 hashing is effectively constant
 * time for this purpose, but the string equality it falls back to on
 * collision is not a guarantee we want to depend on), so grants are looked
 * up by explicit constant-time scan. The table is small (one entry per
 * in-flight /select call), so this is cheap. */
function findGrant(otac: string): VerifierGrant | undefined {
  for (const [code, grant] of verifierGrants) {
    if (timingSafeEqual(code, otac)) return grant;
  }
  return undefined;
}

/**
 * The PPT comparison bound: N + k(N-k) + C(k,2) comparisons, each costing
 * n_evaluations verifier calls, plus the N generation calls themselves.
 * Mirrors the identical formula already validated in config-loader.ts's
 * validateProxyConfig (see docs/plan-llm-as-a-verifier-plugin.md's cost
 * table) — kept in sync by hand since the two call sites (config-time
 * warning vs. runtime admission ceiling) serve different purposes.
 */
function derivedCallBound(samples: number, pivots: number, nEvaluations: number, callMargin: number): number {
  const k = Math.min(pivots, samples);
  const comparisons = samples + k * (samples - k) + (k * (k - 1)) / 2;
  const maxScoringCalls = comparisons * nEvaluations;
  return Math.ceil((samples + maxScoringCalls) * callMargin);
}

export interface VerifierGrantResult {
  ok: boolean;
  status: 200 | 401 | 403;
  error?: string;
  authHeaders?: Record<string, string>;
  requestId?: string;
  aliasName?: string;
  userKey?: string;
}

/**
 * Redeem an inbound sidecar callback for the original caller's credentials.
 * Resolves verifier config from `env` itself, so callers only need the raw
 * request — matching kompress/privacy-filter's "(request, env)" call shape.
 *
 * All four checks must hold, in order:
 *   1. sidecar-origin — x-client-address (unspoofable; injected by server.ts
 *      from the raw socket) must be in an allowed sidecar address.
 *   2. grant — one_time_auth_code must name a live, unexpired grant.
 *   3. not exhausted — grant.remainingCalls > 0 && now < grant.expiresAt.
 *   4. model permitted — the request body's `model` must be in
 *      grant.allowedModels (skipped if the body has no readable `model`;
 *      run_select's own `_require` on the sidecar side still enforces one is
 *      present, this proxy-side check narrows to what the grant allows).
 *
 * On success, decrements remainingCalls and returns the grant's own
 * authHeaders (never the callback's). Logs only the request id and a
 * validity verdict — never the code itself.
 */
export async function redeemVerifierGrant(request: Request, env?: Env, logger?: Logger): Promise<VerifierGrantResult> {
  const requestId = request.headers.get('x-request-id') || '';

  let config: VerifierConfig | null;
  try {
    config = getVerifierConfig(env);
  } catch {
    config = null;
  }
  if (!config) {
    logger?.warn(requestId, 'verifier callback rejected: verifier disabled');
    return { ok: false, status: 401, error: 'verifier disabled' };
  }

  const clientAddr = request.headers.get('x-client-address') || '';
  if (!config.sidecarIps.has(clientAddr)) {
    logger?.warn(requestId, 'verifier callback rejected: origin not an allowed sidecar address');
    return { ok: false, status: 401, error: 'callback origin not allowed' };
  }

  const otac = request.headers.get('one_time_auth_code') || '';
  if (!otac) {
    logger?.warn(requestId, 'verifier callback rejected: missing one_time_auth_code');
    return { ok: false, status: 401, error: 'missing one_time_auth_code' };
  }

  const grant = findGrant(otac);
  if (!grant) {
    logger?.warn(requestId, 'verifier callback rejected: unknown or expired grant');
    return { ok: false, status: 401, error: 'invalid or expired one_time_auth_code' };
  }

  const now = Date.now();
  if (grant.remainingCalls <= 0 || now >= grant.expiresAt) {
    logger?.warn(grant.requestId, 'verifier callback rejected: grant exhausted or expired');
    return { ok: false, status: 401, error: 'grant exhausted or expired' };
  }

  // Best-effort model-allowlist check: peek at the body without consuming
  // it, so the caller can still read it afterward. A body that can't be
  // parsed here just skips this narrowing check — the sidecar's own
  // required-field validation still applies downstream.
  let requestedModel: string | undefined;
  try {
    const cloned = await request.clone().json() as Record<string, unknown>;
    if (typeof cloned.model === 'string') requestedModel = cloned.model;
  } catch {
    // not JSON, or already consumed — skip the narrowing check
  }

  if (requestedModel !== undefined && !grant.allowedModels.has(requestedModel)) {
    logger?.warn(grant.requestId, `verifier callback rejected: model "${requestedModel}" not in grant allowlist`);
    return { ok: false, status: 403, error: 'model not permitted for this grant' };
  }

  grant.remainingCalls -= 1;
  logger?.debug(grant.requestId, 'verifier callback redeemed: ok');

  return {
    ok: true,
    status: 200,
    authHeaders: grant.authHeaders,
    requestId: grant.requestId,
    aliasName: grant.aliasName,
    userKey: grant.userKey,
  };
}

/** Explicitly revoke a grant (called in runVerifier's finally). Idempotent. */
export function revokeVerifierGrant(otac: string): void {
  verifierGrants.delete(otac);
}

/** Fall back to the last user-turn text (Anthropic Messages format), the same
 * extraction runFusion's inline extractUserPrompt performs. Duplicated rather
 * than imported: that helper is a private closure inside index.ts's fetch
 * handler, not an exported function, and this module must stand alone (it is
 * invoked before any request-scoped closures exist). */
function extractUserPrompt(bodyObj: Record<string, unknown>): string {
  const msgs = bodyObj.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return '';
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as Record<string, unknown>;
    if (m.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return (m.content as Array<Record<string, unknown>>)
          .filter((b) => b.type === 'text')
          .map((b) => String(b.text ?? ''))
          .join('\n');
      }
    }
  }
  return '';
}

/**
 * Run one best-of-N verifier dispatch.
 *
 * Mints an OTAC, registers a grant scoped to exactly this call (target +
 * scorer models only, admission-bounded remainingCalls), issues a single
 * outbound `POST /select` to the sidecar (which itself makes the N
 * generation + scoring calls back to this proxy, authenticated by the
 * OTAC), and revokes the grant when the call settles.
 *
 * Returns null on any failure (sidecar unreachable, non-openai-completions
 * scorer route, aborted tournament, timeout) so the caller can fall back to
 * one plain call — the fail-open landing point for every aborted tournament.
 * Never throws.
 *
 * Signature extends the plan's canonical `(config, plan, body, requestId,
 * authHeaders)` with two more parameters this implementation needs:
 * `userKey` (so the grant, and therefore every accounting call site on a
 * redeemed callback, carries the caller's identity) and `env`/`logger`
 * (present-but-optional, for the outbound User-Agent version string and
 * request-scoped logging — omit either for a self-contained call, e.g. in
 * tests).
 */
export async function runVerifier(
  config: VerifierConfig,
  plan: VerifierPlan,
  body: Record<string, unknown>,
  requestId: string,
  authHeaders: Record<string, string>,
  userKey: string,
  env?: Env,
  logger?: Logger,
): Promise<Response | null> {
  // Pre-dispatch re-check: the scorer route MUST be openai-completions
  // (logprobs required for scoring). Config validation already reports this
  // as an error at load time (report-only, never blocks), and the sidecar's
  // own startup probe checks it too — this is the layer that actually stops
  // an all-ties tournament from running. Fail open to a plain call.
  if (plan.scorer.route.upstreamMode !== 'openai-completions') {
    logger?.warn(requestId, `verifier alias "${plan.alias}" scorer route is not openai-completions; failing open to a plain call`);
    return null;
  }

  const { samples, temperature, n_evaluations: nEvaluations, pivots, criteria, seed, otac_max_reuse: otacMaxReuse } = plan.options;

  // The ceiling is an admission check, computed once here, never widened
  // mid-flight. otac_max_reuse (when set) only ever lowers it further.
  const derivedBound = derivedCallBound(samples, pivots, nEvaluations, config.callMargin);
  const remainingCalls = typeof otacMaxReuse === 'number' ? Math.min(derivedBound, otacMaxReuse) : derivedBound;

  const otac = `otac_${crypto.randomUUID().replace(/-/g, '')}`;
  const allowedModels = new Set([plan.target.modelName, plan.scorer.modelName]);

  sweepExpiredGrants();
  verifierGrants.set(otac, {
    requestId,
    aliasName: plan.alias,
    userKey,
    authHeaders,
    allowedModels,
    remainingCalls,
    expiresAt: Date.now() + config.timeoutMs,
  });

  try {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const problem = extractUserPrompt(body);

    const selectBody: Record<string, unknown> = {
      model: plan.target.modelName,
      scorer_model: plan.scorer.modelName,
      messages,
      problem,
      samples,
      temperature,
      n_evaluations: nEvaluations,
      pivots,
      // Diagnostic only — the sidecar logs it but never echoes it back, and
      // even if it did, the caller must ignore it: accounting identity comes
      // only from the grant table (grant.aliasName), never from a value the
      // sidecar could send.
      alias: plan.alias,
    };
    if (criteria !== undefined) selectBody.criteria = criteria;
    else if (config.criteria !== undefined) selectBody.criteria = config.criteria;
    if (seed !== undefined) selectBody.seed = seed;
    if (typeof body.max_tokens === 'number') selectBody.max_tokens = body.max_tokens;

    let resp: Response;
    try {
      resp = await fetch(`${config.url}/select`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          one_time_auth_code: otac,
          'x-request-id': requestId,
          'User-Agent': `model-proxy-v3-verifier/${env?.VERSION || 'dev'}`,
        },
        body: JSON.stringify(selectBody),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (err) {
      // Network error, timeout, or abort — the landing point for every
      // aborted tournament. Fail open.
      logger?.warn(requestId, `verifier sidecar request failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    if (!resp.ok) {
      // Includes the on_error="raise" case: the sidecar surfaces an aborted
      // tournament as a non-2xx, never a silent 200 with tie scores.
      const text = await resp.text().catch(() => '');
      logger?.warn(requestId, `verifier sidecar returned ${resp.status}: ${text.slice(0, 500)}`);
      return null;
    }

    let payload: { winner?: unknown; index?: unknown };
    try {
      payload = (await resp.json()) as typeof payload;
    } catch (err) {
      logger?.warn(requestId, `verifier sidecar returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    if (!payload.winner || typeof payload.winner !== 'object') {
      logger?.warn(requestId, 'verifier sidecar response missing winner choice');
      return null;
    }

    // The winner is a raw OpenAI-format `choice` object. Wrap it into a
    // minimal chat-completions-shaped response so downstream response
    // translation (Anthropic/Gemini format conversion) works exactly as it
    // does for a plain openai-completions call.
    //
    // Streaming note: verification is fundamentally incompatible with
    // token-by-token streaming — all N candidates must complete before
    // ranking can happen at all. When the inbound request has `stream:
    // true`, the caller (index.ts dispatch) must buffer this single
    // non-streaming Response and re-emit it as one SSE message rather than
    // silently degrading to a non-streaming reply. That translation belongs
    // at the dispatch call site, not here, since it depends on which
    // upstream wire format the original request expects.
    const responseBody = {
      id: `verifier-${requestId}`,
      object: 'chat.completion',
      model: plan.target.modelName,
      choices: [payload.winner],
    };

    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } finally {
    revokeVerifierGrant(otac);
  }
}

/** Re-exported for callers that need to format the caller's own credentials
 * into the shape a grant's authHeaders should carry (same transform used for
 * every other upstream dispatch). Kept here rather than re-implemented so
 * verifier.ts and index.ts agree on exactly one auth-header shape. */
export { transformAuthHeadersForUpstream };
