# Design: `fusion` Composite Alias (Multi-Model Deliberation Router)

Status: **Design only — no source modified.**
Author: design doc
Date: 2026-06-15
Scope: Add a third composite alias *mode* (`fusion`) alongside the existing
`share` (weighted load-balance) and `fallback` (priority retry) modes.

---

## 0. Why this fits the existing proxy

The reference "OpenRouter Fusion Router" design (separate **panel**, **judge**,
and **synthesis** stages) maps almost directly onto concepts this proxy already
has. Rather than inventing a parallel routing system, `fusion` is expressed as a
new **per-target field** in the existing `[composite]` block, reusing:

| Reference concept            | Existing proxy primitive                                              |
|------------------------------|----------------------------------------------------------------------|
| Panel models                 | Composite target list (the keys of a `[composite]` alias)            |
| Outer model / synthesis      | A designated target (`primary` / a new `role` field)                 |
| Judge model                  | A designated target                                                  |
| Provider diversity           | Each target already carries its own `base_url` + `api_key` + mode    |
| Parallel fan-out             | **NEW** — today the retry loop is sequential                         |
| Recursion guard              | **NEW** — header-based depth cap                                     |

The single biggest *new* mechanism is **parallel fan-out + aggregation**.
Everything else is configuration and reuse.

---

## 1. Current architecture (as built today)

Traced from the live code so the design stays grounded.

### 1.1 Composite config shape

`proxy_config.toml`:

```toml
[composite]
"code-small" = {"max-m3": {"share": 0, "fallback": 0}, "opus48": {"share": 100, "fallback": 0}}
"maxplan"    = {"max-m2.7-high": {"share": 100}, "max-m3": {"share": 100}}
```

Per-target config type — `src/utils/config-loader.ts:82`:

```ts
export interface CompositeTargetConfig {
  share?: number;
  primary?: boolean;
  fallback?: number;
}
export interface CompositeModelConfig {
  token_limit?: TokenLimitConfig;
  [modelName: string]: CompositeTargetConfig | TokenLimitConfig | undefined;
}
```

### 1.2 How `share` / `fallback` / `primary` resolve today

`getOrderedCompositeTargets()` — `config-loader.ts:176`:

1. Resolve every target key to a concrete `ModelRouteConfig` (url / key / mode / alias).
2. Drop targets with `share === 0` (recorded in `skippedTargets`) — `:206`.
3. Ordering:
   - if any target has `primary: true` → it goes first — `:219`;
   - else if any target has `fallback > 0` → sort ascending by `fallback` — `:224`;
   - else keep declaration order.

`selectWeightedCompositeCandidate()` — `config-loader.ts:274`: weighted random
pick using `share` as the weight (`share ?? 1`).

`getCompositeRouteCandidates()` — `config-loader.ts:318`: produces the **ordered
attempt list**. If there is no priority ordering, the weighted winner is placed
first, the rest follow as fallbacks.

### 1.3 How candidates are executed (the retry loop)

`src/index.ts`:

- `:683` — `getCompositeRouteCandidates(modelName, proxyConfig)` builds candidates.
- `:687` — alias-level `token_limit` enforcement (window usage vs cap → `OverLimitError`).
- `:708` — each candidate is materialized into a `RouteAttempt` (rewritten
  `Request` with `model` swapped to the upstream alias, per-target auth headers,
  per-target target URL + handler type + upstream mode).
- `:932` — `runAttempt()` dispatches one attempt to the right handler
  (`handleClaudeRequest`, `handleMessagesRequest`, `handleGeminiRequest`, …),
  records stats, and wraps SSE streams for usage tracking.
- `:1088` — **sequential** loop: try attempt `i`; on throw, log and try `i+1`;
  return the first success; if all fail, rethrow `lastError`.

**Key takeaway:** today the loop returns the *first successful single response*.
It never calls more than one upstream for a successful request, and never
combines responses. `fusion` introduces exactly those two capabilities.

---

## 2. `fusion` — concept

`fusion` turns a composite alias from "pick one upstream" into "consult several
upstreams in parallel, have one judge them, and have one synthesize the final
answer." It is selected when targets carry a `fusion` weight/role, analogous to
how `share` and `fallback` select the other two modes.

```
client → fusion alias
   │
   ├─ fan-out (parallel)  → panel target A ┐
   │                       → panel target B ├─ collect responses
   │                       → panel target C ┘
   │
   ├─ judge target        → structured JSON analysis (consensus / contradictions / …)
   │
   └─ synthesis target    → final user-facing answer  → client
```

### 2.1 Mode-selection precedence

A single alias has exactly one effective mode. Precedence (first match wins):

1. **fusion** — any target has a `role` of `panel`/`judge`/`synth`, **or** any
   target has a numeric `fusion` weight `> 0`.
2. **fallback / primary** — existing rule (`primary` or any `fallback > 0`).
3. **share** — weighted random (default).

This keeps every current alias behaving identically (none of them declare
`fusion`/`role`, so they fall through to today's logic).

---

## 3. Config schema (proposed, additive)

Extend `CompositeTargetConfig` with two optional fields. **No removals** — fully
backward compatible.

```ts
type FusionRole = 'panel' | 'judge' | 'synth';

export interface CompositeTargetConfig {
  share?: number;
  primary?: boolean;
  fallback?: number;
  // NEW:
  fusion?: number;       // panel weight; > 0 marks target as part of the panel
  role?: FusionRole;     // explicit stage assignment; overrides `fusion`
}
```

Plus an optional alias-level tuning block (sits next to `token_limit`):

```ts
export interface FusionOptions {
  min_panel?: number;        // min successful panel responses to proceed (default 1)
  panel_timeout_ms?: number; // per-panel-call wall clock (default 60000)
  judge_required?: boolean;  // if false, degrade to synth-without-judge (default false)
  expose_metadata?: boolean; // attach fusion_metadata to response (default true)
}

export interface CompositeModelConfig {
  token_limit?: TokenLimitConfig;
  fusion_options?: FusionOptions;   // NEW
  [modelName: string]: CompositeTargetConfig | TokenLimitConfig | FusionOptions | undefined;
}
```

### 3.1 TOML examples

**Explicit roles (recommended, unambiguous):**

```toml
[composite]
"fusion" = { \
  "opus48"      = { "role" = "panel" }, \
  "max-m3"      = { "role" = "panel" }, \
  "gemini-3.0-flash-preview" = { "role" = "panel" }, \
  "opus46"      = { "role" = "judge" }, \
  "opus48"      = { "role" = "synth" }, \
  "fusion_options" = { "min_panel" = 2, "panel_timeout_ms" = 90000 } \
}
```

> Note: TOML cannot repeat the same key (`opus48`) inside one inline table. When
> the same physical model must play two stages, use a distinct *composite-local
> alias* per role (see §3.2).

**Weight-driven (panel auto-selected by `fusion > 0`):**

```toml
[composite]
"fusion-lite" = { \
  "max-m3"        = { "fusion" = 1 }, \
  "max-m2.7-high" = { "fusion" = 1 }, \
  "opus48"        = { "fusion" = 1, "role" = "judge" }, \
  "fable5"        = { "role" = "synth" } \
}
```

Resolution rules:
- targets with `role: panel` **or** `fusion > 0` (and no other role) → **panel**;
- exactly one `role: judge` → judge (if absent, see §6 fallback);
- exactly one `role: synth` → synth (if absent, defaults to the judge target,
  then to the first panel target);
- `share`/`fallback`/`primary` are **ignored** in fusion mode (documented; a
  config-validation warning is emitted).

### 3.2 Distinct-alias-per-role pattern

Because TOML inline tables forbid duplicate keys and each target is keyed by a
model name, define thin model aliases when one upstream serves two roles. Reuse
the existing `[models.*]` alias mechanism — e.g. add `opus48-judge =
["claude-opus-4-8", "", ""]` under `[models.free]`, then reference both
`opus48` (synth) and `opus48-judge` (judge) in the fusion alias.

---

## 4. Resolution layer (config-loader.ts)

New pure functions, mirroring the existing `getOrderedCompositeTargets` /
`getCompositeRouteCandidates` style. **Design only — describing intended shape.**

```ts
export interface FusionPlan {
  alias: string;
  panel: Array<{ modelName: string; route: ModelRouteConfig }>;
  judge?: { modelName: string; route: ModelRouteConfig };
  synth: { modelName: string; route: ModelRouteConfig };
  options: Required<FusionOptions>;
}

// Returns undefined when the alias is NOT a fusion alias (so callers fall
// through to existing share/fallback handling unchanged).
export function resolveFusionPlan(
  modelName: string,
  proxyConfig: ProxyConfig
): FusionPlan | undefined;

// Mode discriminator used at the call site before building attempts.
export function getCompositeAliasMode(
  modelName: string,
  proxyConfig: ProxyConfig
): 'fusion' | 'fallback' | 'share' | undefined;
```

`resolveFusionPlan` reuses `resolveModelRouteFromConfig()` (`:159`) for each
target exactly like `getOrderedCompositeTargets` does — so per-target
`base_url` / `api_key` / `upstream_mode` / `modelAlias` inheritance is identical
to today.

---

## 5. Execution layer (index.ts)

The existing block at `index.ts:682` branches on whether `modelName` is a
composite alias. Add one branch **before** the current `compositeCandidates`
path:

```
if getCompositeAliasMode(modelName) === 'fusion':
    plan = resolveFusionPlan(modelName, proxyConfig)
    return await runFusion(plan, request, body, env, logger, requestId)
else:
    ... existing compositeCandidates / runAttempt loop (unchanged) ...
```

### 5.1 `runFusion` pipeline

Each stage reuses the **already-existing** per-candidate machinery: the same
`RouteAttempt` construction (`index.ts:708`) and the same `runAttempt()`
dispatcher (`index.ts:932`). Fusion is an *orchestration* layer over them.

```
runFusion(plan, request, body):

  # token_limit check reused as-is (sum across ALL plan targets)

  # ---- Stage 1: PANEL (parallel) ----
  panelAttempts = plan.panel.map(t => buildRouteAttempt(t, body))   # reuse :708 logic
  settled = await Promise.allSettled(
      panelAttempts.map(a => withTimeout(runAttempt(a), options.panel_timeout_ms))
  )
  panelResults = collect non-streaming JSON bodies from fulfilled responses
  if panelResults.length < options.min_panel:
      return degrade(...)   # see §6

  # ---- Stage 2: JUDGE ----
  judgePrompt = buildJudgePrompt(originalUserPrompt, panelResults)   # §5.3
  judgeBody   = { ...body, messages:[{role:'user',content:judgePrompt}],
                  response_format: JUDGE_JSON_SCHEMA, stream:false }
  judgeAttempt = buildRouteAttempt(plan.judge, judgeBody)
  analysis = parseJson( await runAttempt(judgeAttempt) )            # may be skipped, §6

  # ---- Stage 3: SYNTHESIS ----
  synthPrompt = buildSynthesisPrompt(originalUserPrompt, analysis ?? panelResults)
  synthBody   = { ...body, messages:[...history, {role:'user',content:synthPrompt}],
                  stream: body.stream === true }
  synthAttempt = buildRouteAttempt(plan.synth, synthBody)
  return await runAttempt(synthAttempt)   # streamed straight to client if stream:true
```

Critical reuse points:
- **`buildRouteAttempt`** is the *existing* mapper at `index.ts:708` factored as
  a helper (it already rewrites `model`, picks target URL, handler type, upstream
  mode, and per-target auth headers for every upstream family). Fusion calls it
  N+2 times instead of once.
- **`runAttempt`** (`index.ts:932`) already records per-model stats, usage, tool
  counts, and SSE usage tracking — so panel/judge/synth calls are observed for
  free.
- **Streaming**: only the synthesis call streams to the client. Panel and judge
  always run non-streaming (`stream:false`) because their bodies must be fully
  buffered for aggregation.

### 5.2 Body extraction across API families

The proxy accepts Anthropic Messages, Gemini generateContent, OpenAI
completions/responses. Panel/judge/synth prompts must be built in the **client's
inbound format** so the existing converters handle upstream translation.
`runFusion` therefore:

1. detects inbound format from `path` (same conditions as `index.ts:638`);
2. extracts the latest user prompt + prior history via a small per-format
   adapter (Messages: `messages[]`; Gemini: `contents[]`; OpenAI: `messages[]`);
3. re-emits judge/synth bodies in that same inbound format, then lets
   `buildRouteAttempt` + the converter layer translate per target.

This means a Gemini panel target and an Anthropic judge target can coexist —
exactly like mixed-provider composite aliases work today.

### 5.3 Judge output schema (enforced)

Passed as `response_format` to OpenAI-mode judges; for Anthropic/Gemini judges,
injected as a strict instruction in the prompt and validated post-hoc.

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["consensus","contradictions","partial_coverage","unique_insights","blind_spots"],
  "properties": {
    "consensus":        { "type": "array", "items": {"type":"string"} },
    "contradictions":   { "type": "array", "items": {
        "type":"object","required":["topic","stances"],"properties":{
          "topic":{"type":"string"},
          "stances":{"type":"array","items":{"type":"object",
            "required":["model","stance"],
            "properties":{"model":{"type":"string"},"stance":{"type":"string"}}}}}}},
    "partial_coverage": { "type": "array", "items": {
        "type":"object","required":["models","point"],"properties":{
          "models":{"type":"array","items":{"type":"string"}},
          "point":{"type":"string"}}}},
    "unique_insights":  { "type": "array", "items": {
        "type":"object","required":["model","insight"],"properties":{
          "model":{"type":"string"},"insight":{"type":"string"}}}},
    "blind_spots":      { "type": "array", "items": {"type":"string"} }
  }
}
```

### 5.4 Prompt templates

**Judge:**
```
You are a meta-analyst comparing responses from multiple expert models.

ORIGINAL PROMPT:
{{prompt}}

PANEL RESPONSES:
{{#each panel}}
--- MODEL: {{model}} ---
{{content_or_error}}
{{/each}}

Produce ONLY valid JSON matching the schema. Fields: consensus, contradictions,
partial_coverage, unique_insights, blind_spots.
```

**Synthesis:**
```
You are writing the final answer for the user.

ORIGINAL PROMPT: {{prompt}}
STRUCTURED ANALYSIS: {{analysis_json}}   # or raw panel responses if judge degraded

Lead with consensus; attribute contradictions to specific models; caveat
partial-coverage points; surface unique insights as minority views; explicitly
name blind spots. Write naturally — do not echo the JSON.
```

---

## 6. Failure handling & graceful degradation

Reuses the proxy's existing philosophy (the sequential loop already degrades by
falling through candidates). Fusion degradation ladder:

| Condition                              | Behavior                                                            |
|----------------------------------------|--------------------------------------------------------------------|
| All panel calls succeed, judge ok      | Full pipeline; `fusion_metadata.analysis_present = true`           |
| Some panel calls fail (≥ `min_panel`)  | Proceed with survivors; record `panel_errors[]`                    |
| Panel ok, judge fails / bad JSON       | Skip analysis; synthesis runs on **raw panel responses**          |
| Fewer than `min_panel` panels succeed  | If `synth` target reachable → answer from whatever panel returned; else error |
| Zero panel calls succeed               | `error: all_panels_failed` (Claude-format error via existing `errors.ts`) |
| Alias `token_limit` exceeded           | Existing `OverLimitError` (`index.ts:694`) — unchanged             |
| Recursion attempt (depth header set)   | `error: fusion_invocation_capped` (§7)                            |

Errors are emitted through the existing `handleTargetApiError` / Claude-format
error path so clients see a consistent shape.

---

## 7. Recursion / cost protection

A fusion synth/judge/panel target could itself be a fusion alias → blow-up.
Guard with a propagated header, checked at ingress:

- On every internal `runAttempt` issued by `runFusion`, set
  `x-fusion-depth: <n+1>` on the candidate request headers.
- At the fusion branch in `index.ts`, read `x-fusion-depth`; if `>= 1`, **do not**
  expand fusion — treat the alias as plain `share` (pick one panel target) or
  return `fusion_invocation_capped` per `fusion_options`.

This mirrors the reference design's depth header and costs nothing when unused.

Cost note: a fusion call is `N (panel) + 1 (judge) + 1 (synth)` upstream calls.
Panel runs in parallel, so **latency ≈ max(panel) + judge + synth**, while
**cost ≈ (N+2)×**. Document this prominently; gate behind explicit alias config
so it is never the default.

---

## 8. Observability

`runAttempt` already feeds `recordModelStat`, `recordModelUsage`,
`recordModelTiming`, `recordCompositeTokenUsage` (`index.ts:1046-1082`). Fusion
gets per-stage stats for free. Additionally, when
`fusion_options.expose_metadata` is true, attach to the final (non-streaming)
response body, or as trailer SSE event for streams:

```json
{
  "router": "fusion",
  "fusion_metadata": {
    "alias": "fusion",
    "panel_models": ["opus48","max-m3","gemini-3.0-flash-preview"],
    "judge_model": "opus46",
    "synth_model": "opus48",
    "panel_latency_ms": {"opus48":1200,"max-m3":1400,"gemini-3.0-flash-preview":1100},
    "judge_latency_ms": 800,
    "synth_latency_ms": 600,
    "panel_errors": [],
    "analysis_present": true
  }
}
```

Token accounting: sum panel+judge+synth `total_tokens` and feed the existing
`recordCompositeTokenUsage(aliasName, ...)` so alias-level `token_limit` covers
the *whole* fusion cost, not just one call.

---

## 9. Dashboard / config UI impact

`src/handlers/dashboard.ts` already renders composite aliases and their per-target
fields (`share`, `fallback`, `primary`, `token_limit`). For fusion it needs:

- render/edit the new `role` (`panel`/`judge`/`synth`) and `fusion` weight per target;
- render/edit `fusion_options` next to `token_limit` (it already special-cases
  the `token_limit` key at `dashboard.ts:452`);
- serialize them via `serializeCompositeModelConfig` (`config-loader.ts:710`) —
  extend the field emitter to include `fusion` and `role`.

Config validation (`config-loader.ts:803`) should additionally:
- warn when `share`/`fallback` coexist with `role`/`fusion` on the same alias
  (ignored in fusion mode);
- error when an alias has `role: panel` targets but zero, or >1, `role: judge`
  without a defined fallback;
- error when `min_panel > panel target count`.

---

## 10. Backward compatibility checklist

- `CompositeTargetConfig` / `CompositeModelConfig` only **gain** optional fields →
  existing TOML parses unchanged.
- `getOrderedCompositeTargets`, `getCompositeRouteCandidates`,
  `selectWeightedCompositeCandidate` are **untouched**; fusion is a sibling path
  gated by `getCompositeAliasMode === 'fusion'`.
- No existing alias declares `role`/`fusion`, so all current aliases
  (`gpt-all`, `code-small`, `maxplan`, …) keep exact present behavior.
- The sequential retry loop (`index.ts:1088`) remains the executor for
  share/fallback aliases.

---

## 11. Implementation surface (when greenlit)

Ordered, minimal-diff plan. **Not executed in this doc.**

1. `config-loader.ts`: extend `CompositeTargetConfig` + `CompositeModelConfig`;
   add `resolveFusionPlan` + `getCompositeAliasMode`; extend serializer
   (`:710`) and validator (`:803`) and `parseCompositeModelConfig` (`:547`).
2. `index.ts`: factor the candidate-building block (`:708`) into a reusable
   `buildRouteAttempt(target, body, path, …)`; add the fusion branch + `runFusion`
   orchestrator using `Promise.allSettled`; add `x-fusion-depth` handling.
3. `dashboard.ts`: surface `role` / `fusion` / `fusion_options` in the editor.
4. Tests under `testcases/09_composite/`: panel fan-out, judge JSON enforcement,
   degradation ladder, recursion cap, mixed-provider panel, token_limit summing.

---

## 12. When to use vs avoid (operator guidance)

Use fusion for: high-stakes/disputed questions, research synthesis, peer-review
simulation, blind-spot detection. Avoid for: latency-critical interactive use,
high-volume low-margin traffic, simple lookups, creative tasks where divergence
is noise. Because cost is `(N+2)×`, fusion must always be an explicitly
configured alias — never a silent default.
