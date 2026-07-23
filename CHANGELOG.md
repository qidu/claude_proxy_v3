# Changelog

Historical changes to `model_proxy_v3`. For current usage documentation, see
[README.md](./README.md).

## Latest Changes

Newest merged work, reverse-chronological.

### `DEV_PASS_THROUGH` upstream-auth notice

The README and `docs/README_DETAILS.md` now explicitly flag that `DEV_PASS_THROUGH=true`
on `/v1/chat/completions` forwards the caller's `Authorization` / `x-api-key` /
`x-goog-api-key` to the upstream unchanged — the proxy does **not** perform a local
credential check, the upstream directly authenticates the request (valid key → 200,
invalid key → upstream 401). Previously this was implied by the "validation only (no
model routing)" startup warning but not stated in the docs. No code change; this is
a documentation-only notice. See the env-var table row in `README.md` and the
`DEV_PASS_THROUGH` section in `docs/README_DETAILS.md`.

### Node server decoded response header normalization

The Node server adapter now removes `content-encoding` and `content-length` from
responses before writing them to clients. This prevents clients from trying to
decompress plain text when Node `fetch()` has already decoded an upstream
compressed response while preserving the upstream compression headers.

**Files changed:** `src/server.ts`.

### Composite alias resolution for `DEV_PASS_THROUGH` `/v1/chat/completions`

When `DEV_PASS_THROUGH=true`, the `/v1/chat/completions` passthrough handler now resolves
composite aliases and `target`-mapped model ids before forwarding the request upstream.

- Composite aliases (e.g. `for-claw`) are resolved to their primary/weighted target model
  via the same `getModelRouteConfig` path used by `/v1/messages`.
- `target`-mapped entries (e.g. `minimax-m3` → `MiniMax-M3`, `MiniMaxAI/MiniMax-M3` → `MiniMax-M3`)
  are also resolved.
- The `model` field in the forwarded request body is rewritten to the resolved target model id.
  If no alias resolves, the original model name is forwarded unchanged.
- Previously, composite alias names were forwarded verbatim, causing upstreams to return
  `unknown model` errors (e.g. MiniMax error 2013).

**Files changed:** `src/index.ts`, `README.md`, `docs/README_DETAILS.md`.

### `<think>` tag extraction for `openai-completions` upstream

Upstreams with mode `openai-completions` that emit reasoning wrapped in `<think>...</think>` or
`<thinking>...</thinking>` XML tags now have that content split into each endpoint's
native reasoning field, mirroring the existing `<thinking>` behavior.

- `/v1/messages`: extracted into a Claude `thinking` content block.
- `/v1/responses`: extracted into a `reasoning` output item, with `reasoning_text`
  embedded inside the assistant message for round-trip fidelity (matches Codex's
  expected input shape for multi-turn DeepSeek responses).
- `/v1/interactions`: extracted into a `thought` output item alongside the cleaned
  text output.
- `/v1beta/models/<model>:generateContent`: extracted into a Gemini `thought`
  content part alongside the cleaned text part.
- Tag is stripped from the user-visible text content in all paths.
- Both streaming and non-streaming responses are covered; the streaming path
  stitches tags that straddle SSE chunk boundaries via a per-stream `thinkStreamBuffer`
  that is reset on `[DONE]` to avoid cross-request leakage.

`README.md` documents the new behavior next to the existing thinking/reasoning notes.

**Files changed:** `src/converters/openai-to-claude.ts`, `src/converters/streaming.ts`,
`src/converters/completions-to-responses.ts`, `src/converters/openai-to-gemini.ts`,
`src/handlers/responses.ts`, `src/handlers/openai.ts`, `tests/unit/think-tag-extraction.test.ts`,
`README.md`.

### Model usage HTTP recording and auth context headers

The proxy can now optionally POST per-request model usage records to an HTTP collector configured with `[model_usage] record_url`.

- Usage records include `request_id`, `endpoint`, raw `user_key`, `model`, and token counters (`input_tokens`, `cached_tokens`, `cache_written_tokens`, `output_tokens`, `total_tokens`).
- JSON and streaming responses reuse the existing token accounting path, so both non-streaming usage payloads and final streaming usage chunks are reported.
- If `auth_url` returns an `access_token` response header, that one-request token is forwarded to `record_url` as an `access_token` request header.
- Requests to `auth_url` now also include `request_id` and `endpoint` headers, plus the existing auth headers and optional `x-resource-for` when `auth_with_model = true`.
- `proxy_config.toml_example` and `README.md` document the new optional `[model_usage]` section.

**Files changed:** `src/index.ts`, `src/utils/model-usage-recorder.ts`, `src/utils/config-loader.ts`, `src/utils/dashboard-stats.ts`, `tests/unit/token-usage.test.ts`, `tests/unit/auth-with-model.test.ts`, `testcases/15_config_parse/config_parse.test.js`, `README.md`, `proxy_config.toml_example`.

### TUI statistics overlay and compact tool names

The proxy TUI now has a `D` hotkey that opens a scrollable statistics overlay,
matching the existing overlay style used by `P` Tool Blocklist. The panel shows
all rows from `Top Models`, `Tools Used`, and `Top Endpoints` instead of the
main view's first-five-row summaries.

- `Top Models` keeps the full token/accounting column set.
- `Tools Used` and `Top Endpoints` use their own shorter column sets, with
  separator lines between modules.
- Long tool names are compacted in both the statistics overlay and Tool
  Blocklist panel using a prefix/suffix form to preserve recognizable endings.

**Files changed:** `src/tui.ts`.

### Token usage propagation across streaming and cache-aware routes

Token accounting is now more complete across transformed streaming routes:

- OpenAI Chat Completions streaming requests now force `stream_options.include_usage = true` in both Claude-format conversion and OpenAI passthrough paths, so final upstream usage chunks can be propagated.
- Gemini streaming conversion now parses final `interaction.usage` / `usageMetadata` and emits Claude `message_delta.usage`, allowing `/v1/messages` and `/v1/responses` Gemini streaming routes to report final input/output/cache-read token counts.
- OpenAI Responses `usage.input_tokens_details.cached_tokens` is preserved through Claude and Responses conversion paths instead of being dropped or hardcoded to zero when available.
- Local token counting now includes tool results and other non-text blocks with best-effort serialization instead of silently skipping them.
- Unit tests cover streaming usage propagation, cache-token mapping, and local non-text token counting.

**Files changed:** `src/converters/gemini-streaming.ts`, `src/converters/openai-to-claude.ts`, `src/handlers/messages.ts`, `src/handlers/responses.ts`, `src/utils/token-counting.ts`, `tests/unit/token-usage.test.ts`, `README.md`.

### `[general]` section; `[upstream]` renamed to `[default_upstream]`; `auth_passthrough_with` and `auth_url`

Three related config-layer changes landed together.

**`[upstream]` → `[default_upstream]`**

The TOML section that holds global upstream defaults (`default_base_url`,
`default_api_key`, `upstream_mode`) is renamed from `[upstream]` to
`[default_upstream]` to make its scope clearer — it applies only to models
that fall through every `[models.*]` section. Existing configs must rename
the section header; all other keys inside it are unchanged.

**New `[general]` section**

A top-level `[general]` section collects settings that are not tied to a
specific upstream:

- `global_token_limit` and `budget_to_effort_low/medium/high` (previously
  in `[upstream]`) have moved here.
- `auth_url` (optional): if set, the proxy validates every inbound auth
  header by forwarding it (plus `User-Agent`) to this URL via `GET`. HTTP
  200 (or a 301/302 chain that resolves to 200) = success; any 4xx/5xx
  = 401 to the client; network error = 503.
- `auth_passthrough_with` (optional, default `"user_key"`): controls which
  credentials the proxy sends to the upstream provider.

**`auth_passthrough_with`**

| Value | Behaviour |
|:------|:----------|
| `"user_key"` *(default)* | Caller's auth header is forwarded upstream for all sections except `[models.free]`, which always uses its configured key. Unchanged from prior behaviour. |
| `"config_key"` | Configured `api_key` wins for every section — per-entry → section → `[default_upstream] default_api_key`. Callers can still send a key (needed for the `auth_url` validation step) but it is not forwarded upstream. |

`config_key` is intended for shared-gateway deployments where callers must
not supply their own upstream credentials.

**Files changed:** `proxy_config.toml`, `proxy_config.toml_example`,
`src/utils/config-loader.ts` (interface + TOML parser + Consul loader +
serializer), `src/index.ts` (five auth-header sites), `src/server.ts`,
`src/tui.ts`, `src/handlers/dashboard.ts`, `README.md`.

### Privacy filter: local hash-only mode (no sidecar)

The proxy now ports the entropy-based hash/API-key scanner from
[`submodules/privacy-filter/hash_detect.py`](./submodules/privacy-filter/hash_detect.py)
into the TypeScript runtime as `src/utils/hash-detect.ts`. When
`[privacy_filter] filter_mode = "local"` is set in `proxy_config.toml`, the
proxy redacts hash-shaped tokens (API keys, tokens) in-process with no
HTTP call and no Python sidecar. Detected spans are replaced with the
same `⟦HASH:n⟧` sentinels the sidecar emits and are restored on the
response exactly as in sidecar mode — the on-the-wire shape is
identical, so the existing `restoreText` / streaming transform code is
shared.

- **Config source**: a new `[privacy_filter]` toml section. Env vars
  (`PRIVACY_FILTER_URL`, `PRIVACY_FILTER_TIMEOUT_MS`, etc.) override toml,
  matching the rest of the proxy's plugin knobs. The plugin is enabled
  when `filter_mode = "local"` (no URL required), or when
  `filter_mode = "sidecar"` is paired with a valid `filter_url`;
  otherwise it stays inert. There is no separate `enabled` flag — the
  combination of `filter_mode` and `filter_url` is what turns the
  filter on.
- **Detection semantics**: identical to the Python reference — Shannon
  entropy ≥ `entropy_threshold` (default `3.0`), 8+ contiguous hex chars
  with non-hex boundaries, length multiple of 8 ⇒ `HIGH` (16–256 chars),
  otherwise `LOW`. A built-in whitelist (`deadbeef`, `cafebabe`, etc.)
  is always applied and can be extended with `whitelist_add` /
  `whitelist_remove`. The minimum token length is configurable via
  `hash_min_len` (default `8`); the Python `hash_detect.py` was updated
  to match (`<= 8` → `< 8`).
- **Sidecar mode is unchanged**; setting `[privacy_filter] filter_mode = "sidecar"`
  + `filter_url = "..."` activates the OPF Python sidecar via toml, in
  addition to the legacy `PRIVACY_FILTER_URL` env-var path.

**Files changed:** `src/utils/hash-detect.ts` (new), `src/utils/privacy-filter.ts`
(local mode + toml plumbing), `src/utils/config-loader.ts`
(`[privacy_filter]` section), `src/index.ts` (wire toml through
`getPrivacyFilterConfig`), `proxy_config.toml` and `proxy_config.toml_example`
(documented example), `testcases/16_security/privacy_filter.test.js`
(TC2115–TC2122), `dist/`.

### Privacy filter now restores both `PII` and `HASH` sentinels

The privacy-filter sidecar ([`submodules/privacy-filter/serve.py`](./submodules/privacy-filter/serve.py)) emits two sentinel prefixes: `⟦PII:n⟧` (model-detected PII) and `⟦HASH:n⟧` (cryptographic-hash-shaped secrets such as API keys and tokens, caught by the entropy-based `hash_detect.py` scan). Previously the proxy's `SENTINEL_REGEX` only matched `PII:`, so `HASH:` sentinels would leak through as literal text in streaming responses. The regex now matches `(?:PII|HASH):`, and the info log line no longer claims HASH spans are PII. On overlap the sidecar's priority order (`HASH_HIGH > HASH_LOW > MODEL`) still applies — the proxy is just restoration, not detection.

**Files changed:** `src/utils/privacy-filter.ts`, `src/index.ts`, `testcases/16_security/privacy_filter.test.js` (TC2113, TC2114), `dist/`.

### Smaller production Docker image

- After the TypeScript build, `Dockerfile` runs `npm prune --omit=dev` so the runtime image no longer carries `wrangler`, `@anthropic-ai/claude-code`, `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@google/genai`, etc. They have also been moved to `devDependencies` in `package.json`.

**Files changed:** `Dockerfile`, `package.json`.

### `DEV_PASS_THROUGH` now honors per-model routes and OpenAI Responses upstreams

- `/v1/chat/completions` with `DEV_PASS_THROUGH=true` now resolves the request `model` through the normal model config before forwarding, so per-model `base_url`, `api_key`, and `mode` entries (including `[models.free]`) are used instead of always falling back to `[models.default]`.
- If the resolved route uses `upstream_mode = "openai-responses"`, the Chat Completions body is converted to Responses format and sent to `/v1/responses`; `openai-completions` routes still forward the original body as-is.
- Azure OpenAI Responses routes keep using the configured model key; the handler normalizes OpenAI-style auth to Azure's `api-key` header for Azure URLs.

**Files changed:** `src/index.ts`, `src/handlers/chat-completions.ts`, `src/handlers/openai.ts`, `testcases/16_security/dev_pass_through_responses.test.js`, `README.md`, `testcases/README.md`.

### Gemini endpoint routing can target Anthropic Messages and OpenAI Responses

- `/v1/interactions` can now route to `upstream_mode = "anthropic-messages"` and `"openai-responses"` through the existing OpenAI Chat Completions intermediate conversion. The upstream response is converted back to the Interactions shape.
- `/v1beta/models/{model}:generateContent` and `:streamGenerateContent` (plus `/v1/models/...`) can now route to `anthropic-messages` and `openai-responses` through the same double-conversion path, then convert responses back to Gemini `candidates[].content.parts`.
- Cross-mode streaming text deltas are converted back to Gemini-shaped SSE instead of passing through raw Claude or Responses SSE.
- Tool calls are preserved: Claude `tool_use` blocks and OpenAI Responses `function_call` items become Chat Completions `tool_calls`, then Gemini `functionCall` parts or Interactions `function_call` outputs.
- When routing Interactions/generateContent to OpenAI Responses, `system`/`developer` messages are forwarded as Responses `instructions`, and OpenAI content-part arrays are normalized to text for Responses `input_text` fields.

**Files changed:** `src/index.ts`, `src/handlers/openai.ts`, `src/converters/openai-to-gemini.ts`, `testcases/16_security/openai_responses_routing.test.js`, `README.md`.

### `base_url` may now point to a full upstream endpoint path

The proxy no longer blindly appends the endpoint suffix to a configured `base_url`. If `base_url` already contains a known full endpoint path, it is used as-is. This lets providers configure `base_url` to the exact upstream URL they need, without getting a doubled path such as `.../v1/messages/v1/messages`.

Recognised full-endpoint markers (case-insensitive):

- `/v1/messages`, `/anthropic/messages` (anthropic-messages)
- `/v1/chat/completions`, `/v1/interactions` (openai-completions / interactions)
- `/v1/responses`, `/openai/responses` (openai-responses, including Azure)
- `/v1beta/models/{model}:generateContent`, `/v1/models/{model}:generateContent`, `:streamGenerateContent`, `:countTokens`

Gemini `base_url` can also stop at the API version or models collection, such as `https://generativelanguage.googleapis.com/v1beta` or `https://generativelanguage.googleapis.com/v1beta/models`; the proxy appends `{model}:generateContent` without duplicating `/v1beta` or `/models`.

For example, a model configured with `base_url = "https://api.anthropic.com/v1/messages"` and `upstream_mode = "anthropic-messages"` will forward `/v1/messages` requests to that exact URL, rather than `https://api.anthropic.com/v1/messages/v1/messages`.

**Files changed:** `src/utils/routing.ts` (new `buildUpstreamUrl` helper), `src/index.ts` (use helper in fixed, composite, and fusion routing).

### Thinking budget clamping: `budget_tokens` is capped to `max_tokens` (with interleaved-thinking exception)
When request to `kimi-2.7-code`, exception shows rised: 'InvalidParameter: max_completion_tokens [32000] must be greater than thinking_budget [32768]'. This is not a fix for the problem, they are just completions to follow api docs:
- **`POST /v1/messages` and `POST /v1/messages/count_tokens`**: when `thinking` is enabled and
  `thinking.budget_tokens` exceeds `max_tokens`, the request validator reduces
  `budget_tokens` down to `max_tokens` before forwarding, keeping the budget within the
  per-response output window required by the Claude API spec.
- **Interleaved-thinking exception**: if the request carries the
  `anthropic-beta: interleaved-thinking-2025-05-14` header, `budget_tokens` is left
  unchanged even when it exceeds `max_tokens` (per `docs/claude-extended-thinking.md`),
  since interleaved thinking is permitted to consume the full context window for
  reasoning tokens.
- **Below-minimum `max_tokens`**: if `max_tokens < 1024` while thinking is enabled with a
  non-null budget, validation throws with a clear message instead of clamping to an
  invalid value.

**Files changed:** `src/utils/validation.ts` (new `clampThinkingBudget`; updated
`validateClaudeMessagesRequest` / `validateClaudeTokenCountingRequest` signatures),
`src/handlers/messages.ts`, `src/handlers/token-counting.ts`.

### Composite alias safety: routing cycle detection, name-conflict stripping, self-reference rejection

#### Routing cycle detection
- **Load time**: `validateProxyConfig` now resolves every composite alias through the full routing chain and catches cycles (e.g. `for-claw6 → for-claw7 → for-claw8 → for-claw6`). Each unique cycle is pushed as a fatal validation error, logged as `[FATAL]`, and surfaced in the TUI status bar and dashboard status bar via `_validationErrors`.
- **Request time**: `getModelRouteConfig`, `getOrderedCompositeTargets`, `resolveCompositeModelRoute`, `getCompositeRouteCandidates`, and `resolveFusionPlan` all accept a `visited: Set<string>` parameter. If a cycle is detected mid-resolution, a `Routing cycle detected: A → B → … → A` error is thrown immediately rather than looping forever.
- **Dashboard snapshot**: `getDashboardSnapshot` now passes `new Set([alias])` when resolving each composite target's route and uses `flatMap` + try/catch so a cyclic target is silently omitted from the snapshot instead of crashing the entire snapshot call (which previously caused TUI to hang at `Loading…`).

#### Nested composite routing (composite → composite)
- Composite targets that are themselves composite (or schedule/fusion) aliases are now resolved through the full routing chain (`getModelRouteConfig`) rather than only `resolveModelRouteFromConfig` (which only looked at `[models.*]`). This makes `alias-a → alias-b → real-model` work correctly end-to-end.

#### Name-conflict stripping
- `findAliasNameConflicts` / `stripConflictingAliases`: composite and schedule aliases whose name collides with a `[models.*]` entry are stripped from the in-memory config at load time. `[FATAL]` is logged per stripped alias; `_validationErrors` carries the error so it appears in TUI / dashboard.
- `addCompositeAlias` / `addScheduleAlias` throw if the new alias name matches an existing model name, preventing the conflict from being written to disk.

#### Self-reference rejection
- `findSelfReferencingCompositeTargets` / `stripSelfReferencingCompositeTargets`: composite targets that list their own alias name as a target are stripped from the in-memory config at load time with `[FATAL]` logging.
- `upsertCompositeTarget` and `validateAndNormalizeComposite` (dashboard PUT path) both throw immediately if a target name equals the alias name, preventing self-references from reaching disk.
- All four TUI call sites for `upsertCompositeTargetFromDashboard` (add/edit × share/fusion) are wrapped in try/catch; errors are shown on the TUI message line without saving.

**Files changed:** `src/utils/config-loader.ts`, `src/handlers/dashboard.ts`, `src/tui.ts`.

### Test runner: `TEST_CONFIG` default is now force-set on `process.env`

- **Fixed silent isolation bypass**: `run-tests.js` and `testcases/utils/test_helpers.js`
  each computed a local `TEST_CONFIG` constant as `process.env.TEST_CONFIG || 'test_'`,
  but never wrote that default back to `process.env.TEST_CONFIG`. Any code path
  that read `process.env.TEST_CONFIG` directly (e.g. the proxy process itself,
  when started independently of `run-tests.js`) would see it unset and fall back
  to `./proxy_config.toml` instead of the isolated `./test_proxy_config.toml`,
  letting config-mutating test suites (composite/fusion/schedule PUTs, tool
  blocklist, global token limit) write into the real config file.
- Both files now do `if (!process.env.TEST_CONFIG) process.env.TEST_CONFIG = 'test_';`
  before reading it, so `TEST_CONFIG` is always defined for every child process
  and for `src/server.ts`'s own `PROXY_CONFIG_PATH` resolution, regardless of
  whether it arrived empty, unset, or already set by the caller.

**Files changed:** `run-tests.js`, `testcases/utils/test_helpers.js`.

### Schedule window editor: friendly `days` input (weekdays/weekend/everyday) in TUI and dashboard

- **Simplified `days` semantics**: schedule windows now accept `"weekday"`/`"weekdays"`
  and `"weekend"`/`"weekends"` in any casing; any other string value normalizes
  to "every day" instead of throwing a validation error. Explicit day-name
  arrays (e.g. `["mon","tue"]`) are still honored for hand-edited TOML. Added
  a shared `normalizeScheduleDays()` helper in `src/utils/config-loader.ts`
  used by the TOML parser, the dashboard JSON-payload validator
  (`validateAndNormalizeScheduleWindow`), and `upsertScheduleWindow` (the
  function both the TUI and the dashboard HTTP route call), so all three
  input paths agree.
- **TUI**: replaced the single JSON-array text prompt for editing a schedule
  target's windows with a step wizard — `from` (number prompt) → `to` (number
  prompt) → **days** (a 3-way picker: Every day / Weekdays / Weekend), with an
  "add another window" loop, or "Set as fallback" to clear the window list in
  one step. Also fixed the alias panel's per-target summary line, which
  previously silently dropped `days: "weekday"`/`"weekend"` (it only rendered
  array-style day lists).
- **Dashboard**: the schedule window's `days` free-text input (which could
  only ever produce a custom day array, never the special weekday/weekend
  values) is now a `<select>` dropdown with the same three options, matching
  the TUI.

**Files changed:** `src/utils/config-loader.ts` (`normalizeScheduleDays`,
`parseScheduleWindow`, `validateAndNormalizeScheduleWindow`,
`upsertScheduleWindow`), `src/tui.ts` (`openEditScheduleWindowsPrompt`,
`ScheduleAliasesOverlay.render`), `src/handlers/dashboard.ts`
(`scheduleAliasRows`, `collectConfigPayload`).

### Schedule Aliases panel: target-add UX fixes, target scope, and test-isolation path bug

- **Enter no longer dismisses the "Add target" list** — selecting a target in the
  "Adding target to *alias*" picker now returns to the Schedule Aliases panel
  (matching Esc/cancel behavior), instead of leaving no overlay open.
- **Key rebind**: adding a schedule target is now `M` (was `T`), for consistency
  with the Composite Aliases panel's `M add target` binding.
- **Target picker no longer offers invalid candidates**: wildcard routing patterns
  (`*`, `claude-*`, etc.) and the schedule alias itself (self-reference) are
  excluded from the "Adding target to *alias*" list.
- **Schedule targets can now be composite/fusion aliases**, not just concrete
  custom models — the picker already sourced candidates from
  `getConfiguredModelIds()` (which includes composite alias names), so this
  was a filtering/doc fix rather than a resolver change.
- **Fixed test-config isolation path bug**: `src/server.ts` computed the
  `TEST_CONFIG`-isolated config path as `` ./${TEST_CONFIG}_proxy_config.toml ``
  (extra underscore), while `run-tests.js` copies the developer config to
  `` ./${TEST_CONFIG}proxy_config.toml `` (no extra underscore). Because the two
  paths didn't match, a running test suite's `PUT /dashboard/api/config` calls
  could end up mutating a config path outside the isolation the test runner set
  up. Removed the extra underscore so the server reads/writes the exact path
  `run-tests.js` isolates.

**Files changed:** `src/tui.ts` (`ScheduleAliasesOverlay`, `openAddScheduleTargetPrompt`), `src/server.ts`.

### Config validation warnings + relaxed `api_key` requirement

`validateProxyConfig` now distinguishes **warnings** from **errors**. Situations that were previously
hard errors but are valid in practice (e.g. missing `api_key` when the caller supplies their own
auth header) are now surfaced as warnings and no longer block the config from loading.

- `ValidationResult` gains a `warnings: ConfigValidationError[]` field (same shape as `errors`).
- Dashboard GET `/dashboard/api/config` response includes `config_warnings` alongside `config_errors`.
- Dashboard UI and TUI both display warnings in amber/yellow when there are no hard errors.
- `api_key` absence is no longer an error for any section — the proxy forwards the caller's auth header.
  Only `base_url` absence (when required) remains a hard error.

**Files changed:** `src/utils/config-loader.ts`, `src/handlers/dashboard.ts`, `src/tui.ts`.

### Per-model `mode` override in `models.*` entries

Each model entry in a `[models.<section>]` block can now declare an explicit
`mode` to override the section's `upstream_mode`. This allows a single
category (e.g. `[models.free]`) to route different models to different
API formats without needing separate sections.

**Config syntax** (both forms supported):

```toml
[models.free]
upstream_mode = "openai-completions"   # section default
sonnet46 = {target = "claude-sonnet-4-6", base_url = "http://localhost:3000", api_key = "", mode = "anthropic-messages"}
opus46   = ["claude-opus-4-6", "http://localhost:3000", "", "anthropic-messages"]
```

**Mode resolution chain**: `model entry mode` → `section upstream_mode` →
`[upstream] upstream_mode` → `"openai-completions"`.

**Files changed:**
- `src/utils/config-loader.ts` — `resolveModelRouteFromEntry` extracts
  `modelMode` from entry[3] and cascades it; inline-table and array
  parsers handle `mode`; validation accepts 4-element arrays;
  `sanitizeDashboardCategoryConfig` preserves mode at index 2 of the
  3-element `[target, base_url, mode]` dashboard format;
  `applyDashboardConfigUpdate` reconstructs the 4-element internal form
  on PUT.
- `src/tui.ts` — `modelChoices()` and `resolveModelTestConfig()` now read
  mode from index 2 of the dashboard sanitized array (was incorrectly
  reading index 3), so the Test Custom Model panel shows the correct
  `anthropic-messages` / `completions` / `gemini` label per model.

### Bug fix: config `api_key` overrode caller key for `[models.default]` targets reached via composite / direct routing

The non-fusion composite dispatch in `src/index.ts` (the `compositeAttempts.map` block) was applying
the model's per-entry `api_key` from the config on top of the caller's auth headers unconditionally,
for every section. This contradicted the documented rule in `proxy_config.toml_example`:

> For the `[models.default]` tier, the auth key sent by the caller takes priority over ALL configured
> `api_key` values, including per-entry overrides. The `api_key` field is intentionally left unset by
> admins in practice — it only acts as a fallback when the caller did not supply an auth key.

Effect: a request for a model like `max-m3` (whose entry in `[models.default]` declares a
`sk-cp-p_i6lDK-...` key) would send the config key to the upstream, ignoring the caller's
`Authorization` / `x-api-key` header. The fusion path was already correct (gated on
`route.section === 'free'`), so the same target behaved differently depending on whether it was
reached via a fusion alias or via composite / direct routing.

Fix: align the inline composite-dispatch block with `buildRouteAttempt` — only override the caller's
auth with the config `api_key` when `route.section === 'free'`. All non-`free` sections
(`default`, `claude`, `gemini`, etc.) now pass the caller's key through unchanged. Affects
`src/index.ts` only (one block, ~10 lines).

### Bug fixes: `/v1/responses` reasoning round-trip (DeepSeek thinking mode + Codex multi-turn)

Four root causes behind the persistent `"reasoning_content must be passed back to the API"` error
when using the Responses API (`/v1/responses`) with DeepSeek thinking-mode upstreams and the Codex
CLI. All changes are in the responses handler and its two converter modules.

- **Streaming path silently dropped `delta.reasoning_content`** — `streamCompletionsAsResponses`
  in `src/handlers/responses.ts` was ignoring the `reasoning_content` / `thinking` delta fields
  that DeepSeek and OpenAI thinking-mode upstreams send per chunk. Added accumulation into
  `accumulatedReasoning` and emitted a `reasoning` output item (with the text) in the final
  `response.output_item.done` event for each text message. The `reasoning_text` is also appended
  inside the assistant message's content array so Codex can echo it back on the next turn.

- **Non-streaming path produced an empty `reasoning` output item** —
  `src/converters/completions-to-responses.ts` was emitting a `reasoning` item with no content
  when the upstream `message.reasoning_content` field was present. Fixed to actually extract the
  string and populate `content: [{ type: 'reasoning_text', text: reasoningText }]`. Also handles
  `part.type === 'thinking'` content parts from OpenAI-style array content.

- **Consecutive `function_call` input items produced separate assistant messages** —
  `src/converters/responses-to-completions.ts` was converting each `function_call` item into its
  own assistant message. Chat Completions (and DeepSeek) require all tool calls from a single
  assistant turn to be in *one* assistant message with multiple `tool_calls` entries. The new
  `convertInputItemsToMessages` exported function collects all consecutive `function_call` items
  and merges them into a single assistant message.

- **Server-side call_id → reasoning store for Codex multi-turn** — Codex builds conversation
  history from `response.output_item.done` events and echoes `function_call` items back as input
  on the next turn, but does **not** re-send `reasoning` items. Without a server-side store, the
  `reasoning_content` field would be absent from the echoed assistant message, causing DeepSeek to
  reject the request. Added a module-level `reasoningByCallId` map (10-minute TTL) in
  `src/handlers/responses.ts`: when a streaming response ends with both tool calls and accumulated
  reasoning, the reasoning is keyed by each `call_id`. On the next request, `handleAsCompletions`
  walks the converted messages and injects the stored `reasoning_content` onto any assistant message
  whose `tool_calls` match a stored entry.

### Bug fixes: OpenAI thinking passthrough + composite 413 path

Two single-case regressions caught by the full integration suite are now
fixed; the suite runs **18/18 suites, 165/165 cases** against the local
proxy (port 7799, `qnaigc` upstream). Recorded in
`tests/test_results_at_2026-06-22_20-14-47.md`.

- **TC413 — OpenAI-style thinking field (`{ enabled, budget_tokens }`)
  was rejected with HTTP 400** on `/v1/messages`. The request was dispatched
  to the Claude-format path (because `requestBody.thinking` is truthy) and
  then failed `validateClaudeMessagesRequest` with `thinking.type is
  required`. Added `normalizeOpenAIToClaudeThinking()` in
  `src/utils/thinking.ts` and applied it in `src/handlers/messages.ts`
  right after JSON parsing, so format detection, validation, and
  conversion all see the canonical Claude shape
  (`{ type: 'enabled'|'disabled', budget_tokens }`).
  Test now uses `budget_tokens: 2000` (validation floor is 1024) and
  `max_tokens: 3000` to fit.
- **TC1110 — Composite `token_limit` exhaustion returned 400 instead of
  413.** Two issues stacked:
  1. `OverLimitError` in `src/utils/errors.ts` was using 429 /
     `rate_limit_error`, the rate-limit shape. Token-limit exhaustion is a
     payload-size / quota concept, not RPM, so it now returns 413 /
     `over_limit_error` to match the documented `token_limit reached`
     contract and the canonical Anthropic-style error envelope.
  2. The catch block in `src/index.ts` around the model-routing body
     parse was swallowing *every* error (including typed
     `ClaudeProxyError` instances) and rewriting it as a 400 "Invalid
     request body". Added an `instanceof ClaudeProxyError` re-raise
     branch so the original status code and `type` field reach the
     client.

  Manual verification: two consecutive requests against a temporary
  `__test_ttl413__` alias with `token_limit: { num: 1, duration: '1h' }`
  now return `200` then
  `413 {"type":"over_limit_error","error":{"type":"over_limit_error","message":"Composite alias '__test_ttl413__' token limit (1 1h) reached (10). No further requests will be routed through this alias."}}`.

### Kompress (context compression) plugin

The proxy can now drop low-importance tokens out of outbound request text to cut
upstream token usage and cost. It mirrors the privacy-filter architecture: a thin
`fetch`-only client (`src/utils/kompress.ts`) talks to a persistent
[kompress](./submodules/kompress/README.md) HTTP sidecar (`POST /compress`), so it
stays Cloudflare-Workers-compatible and is **entirely inert unless `KOMPRESS_URL`
is set**.

Unlike the privacy filter, compression is **lossy and one-directional** — there is
no response-side restore (no sentinel map, no transform stream).

- **`src/utils/kompress.ts`** (new) — `getKompressConfig(env)` (returns `null` when
  `KOMPRESS_URL` unset; validates the sidecar is an internal host), `shouldCompressPath`,
  `isCjkHeavy` (English-only model guard), and `compressBody` (parallel per-fragment
  fan-out to the sidecar).
- **Scope:** compresses only **user-message text** and **tool definitions/results**
  (Anthropic `tools[].description` + `tool_result`, OpenAI `function.description` +
  `role:'tool'`). The system prompt, assistant messages, JSON schemas, images, and
  tool-call inputs are left untouched.
- **CJK guard:** the model is English-only and garbles non-Latin input, so fragments
  above a non-ASCII threshold (or containing CJK/Kana/Hangul) are passed through
  uncompressed.
- **Fail-open by default** (inverse of the privacy filter): a sidecar outage forwards
  the original uncompressed text rather than failing the request. Override with
  `KOMPRESS_FAIL_OPEN=false`.
- **Wiring** (`src/index.ts`): runs right after PII redaction and before tool-blocklist
  erasure, inside the same body-parse block, so single/composite/fusion paths all see
  the compressed body.
- **Env:** `KOMPRESS_URL`, `KOMPRESS_ENDPOINTS`, `KOMPRESS_FAIL_OPEN`,
  `KOMPRESS_TIMEOUT_MS`, `KOMPRESS_MAX_CHARS`, `KOMPRESS_KEEP_RATIO`, `KOMPRESS_MIN_CHARS`
  (declared in `src/types/shared.ts`, surfaced in `src/server.ts`).

### Dashboard Tool Blocklist (mirrors TUI `P` overlay)

The `/dashboard` web UI now ships the same tool blocklist the TUI exposes
behind the `P` key. The previous "Tools Used" aggregated view is replaced
by a per-`(tool, agent)` table with a Block/Unblock button per row.

- **`GET /dashboard/api/tools/blocklist`** (`src/handlers/dashboard.ts`) —
  returns `{ rows: AgentToolPanelEntry[], blockedTools: string[] }` from
  `getAgentToolPanelStats()` + `[...getBlockedTools()]`. Reuses the
  same data feed the TUI overlay consumes (per-tool × per-agent
  `in_requests` / `in_responses` / `in_request_chars`).
- **`POST /dashboard/api/tools/toggle-block`** — body
  `{ tool_name: string, blocked: boolean }`, calls `blockTool()` /
  `unblockTool()` from `src/utils/dashboard-stats.ts`, returns
  `{ ok, tool_name, blocked }`. Returns `400 { error }` when `tool_name`
  is missing or empty.
- **Routes registered** in `src/index.ts` next to the existing
  `/dashboard/api/stats/agents`, `/test-model`, `/global-token-limit`
  handlers.
- **Dashboard UI** (`section-agent` in `handleDashboardPage()`):
  - Heading renamed "Tools Used" → "Tool Blocklist" with a one-line
    caption pointing at the TUI `P` overlay.
  - Table now has 7 columns: status (`✗` / `·`) | Tool | Agent | in req
    | in resp | total len | Action.
  - Blocked rows get a red `✗` status cell, a light red background,
    and the action button toggles between `Block` (neutral) and
    `Unblock` (red).
  - Click handler delegated on `#toolStats` posts to the toggle-block
    endpoint and re-fetches `/tools/blocklist` to refresh the view.
  - 5-second auto-refresh already in place keeps the block state live
    with the rest of the dashboard.
- **Behavior parity with TUI**: blocked tools stop accumulating
  `in_requests` / `in_responses` / `in_request_chars` (existing
  pre-block counts are preserved). In-memory only — same as the TUI,
  resets at proxy restart.
- **Backward compatibility**: `GET /dashboard/api/stats/agents` and
  the `toolStats` field on the main `/dashboard/api/config` snapshot
  are unchanged. The aggregated per-tool view is still available via
  the API; only the dashboard UI now uses the per-`(tool, agent)` view.

### Model Statistic Collapse (default 10)

The Model Statistic table in `/dashboard` now collapses to the top 10
models by default and shows a `Show all (N)` / `Collapse` toggle next
to the existing Export CSV button — same pattern as the Tool Blocklist
section.

- **Default view** shows 10 rows; the toggle is hidden when fewer than
  10 models are present, otherwise it reads `Show all (N)` (collapsed)
  or `Collapse` (expanded).
- **`Export CSV` interaction**: the existing button reads rows from the
  DOM, so it exports only the currently visible rows. Click `Show all`
  first if a full export is needed. This matches the pre-existing CSV
  behavior (the button always reflected whatever was rendered).

### Request Hot-Path Performance: Single Body Parse + Incremental Token-Window Cache

Two optimizations on the per-request hot path, applied without changing any
behavioral contract.

- **Single request body parse** (`src/index.ts`) — tool/agent stats were
  previously extracted from a `request.clone().json()` call at the top of
  the request handler, *before* the routing block parsed the same body via
  `request.text()` + `JSON.parse()`. That meant every JSON request paid
  for two full body parses (and a full body clone allocation). The
  extraction now happens inside the routing block, reading from the body
  that was already parsed for model resolution. `recordAgentStat()` is
  also called from that same site, so routed requests still record tool
  stats exactly as before; non-routed paths (`/v1/models`, `/dashboard`,
  dynamic routes) had no tool stats to record in the first place.
- **Incremental cache for `getTokensInWindow`** (`src/utils/dashboard-stats.ts`)
  — `tokenHeatmapEvents` is append-only within the 30-day retention window
  and sorted by ascending timestamp, so events older than the current
  query cutoff are immutable. The function previously did an O(n) scan of
  the entire 30-day array on every call (each call: every active token-
  limit window checks its accumulator). It now caches the sum of all
  events older than the previous cutoff in `windowSumFrozen`, with
  `windowSumCutoff` marking the boundary, and only scans the live tail
  plus absorbs newly-eligible events into the frozen sum on each call.
  Pruning (30-day `shift()`) only removes events outside any query window,
  so the frozen sum is never invalidated. Cold start still pays a single
  O(n) pass to seed the cache; subsequent calls are O(tail length).

### Token Log Persistence Made Opt-In (TUI=1 / DUMP=1)

Token log persistence (the `model_proxy_tokens.jsonl` JSONL file holding
token stats, heatmap data, and composite limit windows) is now gated on
`TUI=true|1` or `DUMP=true|1`. Without one of those flags the proxy
performs no JSONL file I/O at all — no startup restore, no day-rollover
dump, no periodic 30-min dump, no `Ctrl+U` dump.

- **src/utils/dashboard-stats.ts** — added a module-level
  `persistenceEnabled` flag plus `setStatsPersistenceEnabled(enabled)` /
  `isStatsPersistenceEnabled()` exports. `dumpTodayTokens()`,
  `dumpDailyTokens()`, `advanceDaySlotIfNeeded()` (the day-rollover dump
  path), and `loadTokenStatsFromLog()` all early-return when the flag is
  false. The in-memory `recordTokenHeatmapEvent()` 30-day pruning is
  unchanged, so heatmap stats still age out after 30 days; they just
  don't outlive the process.
- **src/server.ts** — computes `persistenceEnabled = TUI || DUMP`,
  calls `setStatsPersistenceEnabled()` once, and wraps the
  `loadTokenStatsFromLog(retentionDays)` call (and its retention-window
  computation) in an `if (persistenceEnabled)` block. The retention
  window is still derived from the configured global / composite token
  limits and falls back to 30 days when no local TOML config is available.
- The live `/dashboard` and TUI views continue to work either way — they
  read from the in-memory state, which is always populated by the request
  hot path regardless of persistence.
- See [README § 3.2 Token Log Persistence](./README.md#32-token-log-persistence)
  for the full behavior.

### Tool Blocklist (TUI `P` key)

Added a Tool Blocklist overlay in the TUI that lists every observed
`(tool, agent)` pair with `req` / `resp` / `len` counters. Press `Enter` to
toggle the block state for the highlighted tool; blocked tools are marked
with a red `✗` and stop accumulating stats (existing pre-block counts are
preserved). Blocklist state is in-memory only and resets at proxy restart.
See the **Tool Blocklist (`P`)** section in README for full details.

### TUI keybinding change

The model test picker's "test all (30m)" / "stop test timer" toggle is now
`W`. The `P` key on the main view now opens the Tool Blocklist overlay.

### Security Hardening

A batch of defensive fixes applied after review of the proxy boundary. All
user-facing behavior changes.

- **SSRF protection on internal sidecar URLs** — `PROXY_CONFIG_URL` (Consul
  config source) and `PRIVACY_FILTER_URL` (PII-redaction sidecar) are now
  validated against a new `isInternalHost()` helper (`src/utils/routing.ts`).
  The URL must resolve to `localhost` / `127.x.x.x`, an RFC-1918 range
  (`10/8`, `172.16/12`, `192.168/16`), a link-local range (`169.254/16`,
  `fe80::/10`), an IPv6 ULA (`fc00::/7`), `*.local` (mDNS), or `::1`.
  Anything else (public DNS names, public IPs, exotic schemes) is rejected
  at startup with a descriptive error. This closes the path where a
  misconfigured or attacker-controlled `PROXY_CONFIG_URL` could be used to
  exfiltrate the proxy's outbound traffic.
- **No request body in client-facing error messages** — `handleTargetApiError`
  (`src/utils/errors.ts`) used to append a 300-char preview of the upstream
  request body to the `invalid_request_error` message returned to the client.
  That body can contain user prompts, tool arguments, or PII. The preview is
  now logged server-side only via `logger.debug('errors', ...)`; the client
  gets a generic message.
- **No internal error messages from SDK handlers** — `handleSdkOpenAIRequest`
  and `handleSdkAnthropicRequest` (`src/utils/sdk-handler.ts`) caught
  exceptions and returned `error.message` verbatim to the caller, which
  could leak stack frames, file paths, or upstream error bodies. They now
  return `"An internal error occurred"`; the original error continues to be
  logged.
- **Stricter `anthropic-beta` header handling** — `validateBetaFeatures()`
  (`src/utils/beta-features.ts`) silently forwarded any unknown beta feature
  name upstream. Unknown features are now dropped. Additionally,
  CRLF/control chars are stripped from the header value before forwarding,
  so a header value like `prompt-caching\r\nX-Injected: 1` cannot be used
  to inject extra response headers.
- **Tighter API-key logging** — the partial-key formatter in
  `transformAuthHeadersForUpstream` (`src/utils/routing.ts`) used
  `first16...last8` for `x-goog-api-key`, `x-api-key`, and `Authorization`.
  Reduced to `first4...` (or `***` if shorter than 4 chars). The previous
  window could expose enough entropy to brute-force the prefix.
- **Hardened host allowlist** — wildcard entries in `ALLOWED_HOSTS`
  (`*.example.com`) now require a literal `.` separator before the domain,
  so `*.example.com` no longer matches the apex `example.com`. The wildcard
  rule now correctly rejects suffixes that are not real subdomains.

### Misc bug fixes (bundled with the hardening pass)

- `crypto.randomUUID()` replaces `Math.random()` for `resp_*` and `msg_*`
  IDs in `completions-to-responses.ts` and `responses.ts`.
- `dashboard.ts` uses `??` (not `||`) for `PROXY_CONFIG_PATH`, so an
  explicitly empty string is preserved as a real path instead of falling
  through to `null`.

### Per-(tool, agent) stats and persistence changes

- `agentToolStats` and `blockedTools` fields are now part of the dashboard
  snapshot (`src/handlers/dashboard.ts`) — `agentToolStats` is built by the
  new `getAgentToolPanelStats()` in `src/utils/dashboard-stats.ts`, which
  joins the three source maps (`agentStats`, `toolRequestChars`,
  `upstreamResponseToolStats`) into a per-(tool, agent) row keyed by
  `${tool}\0${agent}`.
- `recordToolRequestChars()` and `recordUpstreamResponseToolNames()` now
  take an `agent` argument; `createResponseToolTrackingTransformStream()`
  now takes an `agent` argument and threads it into the `flush()` callback.
  The Claude request handler (`src/index.ts`) passes the user-agent prefix
  through both call sites.
- `dumpTodayTokens()` writes a new `toolStats` field (per-(tool, agent) rows
  with `name`, `agent`, `req`, `resp`, `len`, `blocked`) in the JSONL token
  log. `loadTokenStatsFromLog()` restores those rows back into the three
  source maps on startup (latest dump per date wins, and the `blocked` flag
  is applied via `blockTool()` so the blocklist survives a restart).
- The cumulative `modelStats` Map (powers TUI "Top Models" +
  `getModelTotalTokens()`) is now also restored from the latest dump per
  date, and is **accumulated** across the latest per-date dumps (each
  per-date dump is that day's totals, so summing reconstructs true
  all-time). Previously only the daily `modelStats` map was restored, and
  the cumulative map was not restored at all.
- `recordAgentStat()`, `recordToolRequestChars()`, and
  `recordUpstreamResponseToolNames()` short-circuit on `blockedTools` so
  blocked tools no longer grow their counters.
- **Blocked tools are erased from the request body before forwarding**: a
  new `eraseBlockedTools()` helper in `src/utils/tool-blocklist.ts` runs at
  the body-parsing chokepoint in `src/index.ts` (right after the privacy
  filter). It strips tool definitions matching the blocklist from the
  `tools` array, supports the Claude / OpenAI / Gemini shapes, deletes the
  `tools` field entirely if the filter would empty it, and resets
  `tool_choice` to `'auto'` if it forces a blocked tool. Past `tool_use` /
  `tool_result` blocks in message history are intentionally left untouched.

### ChatJimmy SDK Made Optional (2026-06-17)

- **src/utils/sdk-handler.ts**: The submodule is imported through a
  non-literal dynamic specifier, so `tsc` no longer treats it as a static
  build/typecheck dependency. The existing try/catch surfaces a missing
  submodule only when an `sdk://` route is hit at runtime.
- **package.json / tsconfig.json / tsconfig.server.json**: Removed the
  unused `chatjimmy-sdk` `imports` entry and TypeScript `paths` aliases
  (nothing in `src/` imported that alias; the handler references `dist/`
  by relative path).
- **Net effect**: clone, `npm install`, `npm run typecheck`, `npm run
  build`, and `npm run server` all succeed without the submodule. See
  [Optional: ChatJimmy SDK](./README.md#optional-chatjimmy-sdk-sdk-models).

### Model Response Time Tracking

The proxy now tracks per-model response time (min/avg/max in ms) alongside
existing per-endpoint timing.

- **Recording**: `recordModelTiming(modelId, elapsedMs)` is called inside
  `runAttempt()` after each request completes (both success and error),
  using the config key (`attemptModelId`) as the timing key — same key
  used by `recordModelStat`/`recordModelUsage`
- **Storage**: `requestModelTimingStats` map (same shape as
  `requestEndpointTimingStats`: `min_time_ms`, `max_time_ms`,
  `total_time_ms`, `count`)
- **Snapshot**: `getDashboardSnapshot()` and `handleDashboardRequestStats()`
  expose `model_timings` in `requestStats`
- **TUI Custom Models**: each configured model shows `[min/avg/maxs]`
  after its description, resolved by matching `routeModel` (upstream name)
  from the config array
- **TUI Composite Aliases**: each target shows `[min/avg/maxs]` after its
  properties, resolved by matching `routeModel` from `compositeResolved`
- **Dashboard HTML**: Model Statistic table has 3 new columns (min(s),
  avg(s), max(s)) joined from `model_timings` keyed by the resolved
  upstream model name

### Composite Fallback to Default Upstream

Composite aliases now support unresolved target models by falling back to
the default upstream route (`getDefaultModelRoute`) while preserving the
target model as `modelAlias`. This allows aliases such as `code-small` to
route even when the target is not explicitly declared in `models.*`.

### Messages Format Detection Fix (Claude blocks vs OpenAI passthrough)

`/v1/messages` request detection now treats block-style Claude content
(`content: [{type:"text"|"tool_use"|"tool_result"|"thinking", ...}]`) as
Claude format, forcing Claude→OpenAI conversion for `openai-completions`
upstreams. This prevents malformed passthrough payloads to
`/v1/chat/completions`.

### Dashboard Side-Nav Active Style

The active side navigation item in `/dashboard` now has a visible border
(light gray) for clearer section focus.

### Config Reload Endpoint Rename

The config reload endpoint is now `/config-reload` (previously `/reload`).

### Token Counting Toggle Simplification

Removed `LOCAL_TOKEN_COUNTING`. Local token counting is now controlled
only by `LOCAL_TIKTOKEN` (`true`/`1` enables tiktoken-based local
counting). If API-based token counting fails, the proxy falls back to
byte-based counting for user text.

### TOML Parser Regex Order Fix

The `parseSimpleToml()` function in `config-loader.ts` checked
`unquotedMatch` (regex `key = (.+)`) before `arrayMatch` (regex `key =
[...]`). For model IDs containing only hyphens and underscores (e.g.,
`deepseek-v4-flash`), the greedy `unquotedMatch` captured the array
value but silently discarded it since `models` sections are not in its
handling scope. Models with dots (e.g., `gpt-5.4-mini`) were unaffected
because `.` is outside the `[a-zA-Z0-9_-]` character class. Fixed by
swapping the check order — `arrayMatch` is now evaluated before
`unquotedMatch`, with a comment explaining the ordering constraint. This
fixes composite model resolution (e.g., `code-small` → `deepseek-v4-flash`)
where the candidate model key was previously never found in its category.

### Thinking Block Validation Field Fix

`ThinkingBlock` type defines field `thinking: string`, but
`validateClaudeContentBlock()` in `validation.ts` was checking `block.text`
for `type: "thinking"` blocks. This caused validation to throw `text is
required for thinking blocks` when Claude CLI sent requests with thinking
content blocks in assistant messages (the field is `thinking`, not `text`).
Fixed by changing the check to `block.thinking`.

### Upstream Error Diagnostics

The proxy now reads and logs upstream error response bodies in
`handleClaudeRequest` before throwing, making it possible to diagnose
API-level errors (e.g., DeepSeek returning 400 about thinking mode).

### DeepSeek Thinking Mode Compatibility

Some upstreams (e.g., DeepSeek's Anthropic-compatible API) internally
default models to thinking mode and require prior `content[].thinking`
blocks in the conversation even on the first request. The proxy now:

- Defaults `thinking` to `disabled` when the client doesn't set it
- Strips `thinking: { type: "enabled" }` when there are no prior
  assistant thinking blocks in the conversation history (avoids 400
  errors on first requests)

### Full Request Body Logging

Added debug-level logging of the full request body sent to upstreams in
`handleClaudeRequest` for easier troubleshooting.

### Thinking Signature Support & Streaming Improvements

- **Signature Delta Events**: Added full `signature_delta` support for
  thinking block verification in streaming
- **OpenAI-to-Claude Conversion**: Enhanced conversion of OpenAI's
  `reasoning_item_id` and `signature` to Claude's thinking format
- **Streaming Thinking Extraction**: Improved thinking content extraction
  from `<thinking>` markers and `reasoning_content` fields
- **Thinking Block Lifecycle**: Proper `content_block_start/delta/stop`
  events for thinking blocks in streaming

### Gemini `:countTokens` Endpoint

Added routing for `POST /v1beta/models/{model}:countTokens` and
`POST /v1/models/{model}:countTokens`. The request body is proxied as-is
to the upstream Gemini API and the raw JSON response (`totalTokens`) is
returned. Previously these paths fell through to an "Unsupported fixed
route" error (HTTP 500).

### OpenAI Handler Error Propagation Fix

`handleOpenAIRequest` previously threw a plain `Error` on upstream
non-2xx responses, which the outer error handler converted to HTTP 500
regardless of the actual upstream status. For streaming requests, it
silently returned HTTP 200 with the error wrapped in an SSE frame. Both
paths now use `handleTargetApiError()`, propagating the correct upstream
status code (401, 403, 429, etc.) to the client — matching the behavior
of the Claude and Gemini handlers.

---

## 2026-03-04 — ChatJimmy SDK Integration

**Optional, lazily-loaded submodule**: ChatJimmy SDK lives in
`submodules/chatjimmy` and is loaded at runtime via dynamic import only
when an `sdk://` model is requested. It is not required to build or run
the proxy.

**SDK Handler**: `src/utils/sdk-handler.ts` provides SDK-based request
handling:

- **SDK URL detection**: `sdk://` URLs use chatjimmy SDK clients instead
  of HTTP fetch
- **OpenAI-compatible mode**: `handleSdkOpenAIRequest()` uses
  `OpenAICompatibleClient`
- **Anthropic-compatible mode**: `handleSdkAnthropicRequest()` uses
  `OpenAICompatibleClient` as fallback
- **Streaming support**: SDK Anthropic stream is converted from OpenAI
  chunks to Claude SSE event format (`message_start`, `content_block_*`,
  `message_delta`, `message_stop`)
- **Streaming fallback**: If SDK stream is unavailable, falls back to
  non-stream response

---

## 2026-03-03 — Enhanced Thinking Configuration

- **Type Definitions**: Updated `ThinkingConfigParam` type to accept
  `boolean` values (`true`/`false`) in addition to string values
  (`"enabled"`/`"disabled"`)
- **Normalization Utility**: Added `normalizeThinkingConfig()` function to
  standardize thinking config across the codebase
- **Token Counting**: Updated token counting logic to handle boolean
  thinking types
- **Validation**: Enhanced validation to accept boolean values while
  maintaining backward compatibility

## 2026-03-03 — Thinking Signature Support

- **Signature Delta Events**: Added `"signature_delta"` to
  `ClaudeStreamEvent.delta.type` for streaming signature verification
- **Streaming Signature Emission**: Implemented `signature_delta` event
  emission before `content_block_stop` for thinking blocks
- **Signature Accumulation**: Accumulates signatures from multiple
  sources: `delta.signature`, `reasoning_item_id`, and `signature` fields
- **OpenAI-to-Claude Conversion**: Converts OpenAI's `reasoning_item_id`
  and `signature` to Claude's `signature_delta` format
- **Anthropic Pass-Through**: Passes through `signature_delta` events
  from Anthropic upstream unchanged
- **Non-Streaming Compatibility**: Includes signature in thinking block
  metadata for non-streaming responses

**Files modified** (covers the Model Response Time Tracking, Thinking
Signature Support, and adjacent changes):

- `src/utils/dashboard-stats.ts` — added `requestModelTimingStats` map,
  `recordModelTiming()`, `getRequestModelTimingStatsDesc()`
- `src/index.ts` — `recordModelTiming(attemptModelId, elapsedMs)` called
  inside `runAttempt()` for all requests
- `src/handlers/dashboard.ts` — `model_timings` in snapshot/API, 3 new
  columns (min/avg/max) in HTML model stats table and CSV export
- `src/tui.ts` — timing display (`[min/avg/maxs]`) in Custom Models
  section and Composite Aliases overlay
- `src/types/claude.ts` - Added `"signature_delta"` to stream event types
- `src/converters/streaming.ts` - Added signature accumulation and
  emission logic
- `src/converters/openai-to-claude.ts` - Enhanced signature extraction
  from response metadata

## 2026-03-03 — Gemini v1 Endpoint Support

- **Path Pattern Matching**: Updated regex patterns to support both
  `/v1beta/models/` and `/v1/models/` endpoints
- **URL Building**: Enhanced URL construction logic for both v1beta and
  v1 endpoints
- **Model Extraction**: Improved model ID extraction from both endpoint
  versions

## 2026-03-03 — API Key Management

- **Priority Logic**: Added intelligent API key priority based on
  upstream mode
- **Format Utility**: Created `formatApiKeyForUpstream()` function for
  consistent header formatting
- **Header Transformation**: Enhanced
  `transformAuthHeadersForUpstream()` to handle `Bearer` prefix stripping
- **Configuration Integration**: Better integration of config API keys
  with request processing

**Files modified** (covers the Enhanced Thinking Configuration, Gemini v1
Endpoint Support, and API Key Management changes):

- `src/converters/claude-to-gemini.ts` - Added boolean thinking support
  for Gemini conversion
- `src/converters/claude-to-openai.ts` - Added boolean thinking support
  for OpenAI conversion
- `src/index.ts` - Enhanced routing for v1 endpoints, API key priority
  logic
- `src/types/claude.ts` - Updated ThinkingConfigParam type definition
- `src/utils/routing.ts` - Added `formatApiKeyForUpstream()`, enhanced
  path matching
- `src/utils/thinking.ts` - Added normalization utility, updated all
  thinking functions
- `src/utils/token-counting.ts` - Updated to handle boolean thinking
  types
- `src/utils/validation.ts` - Enhanced validation for boolean thinking
  values

---

## 2026-02-28 — Gemini CLI Config Integration

Successfully tested proxy using **Gemini CLI configuration** from
`~/.gemini/.env`. All models work with the CLI's base URL and API key
settings.

**Gemini CLI Config Test Results:**

| Test Suite       | Models Tested | Passed | Success Rate |
|------------------|---------------|--------|--------------|
| Basic Models     | 10            | 9      | 90%          |
| Gemini Models    | 3             | 3      | 100%         |
| Claude Models    | 6             | 5      | 83.3%        |
| Thinking Models  | 10            | 7      | 70%          |
| **Total**        | **29**        | **24** | **82.8%**    |

**Basic Models (90% success):**

- deepseek/deepseek-v3.1
- deepseek-r1
- minimax/minimax-m2.1
- moonshotai/kimi-k2.5
- minimax/minimax-m2.5
- qwen3-32b
- deepseek/deepseek-v3.2-exp
- z-ai/glm-4.7
- moonshotai/kimi-k2-0905
- z-ai/glm-5 (upstream issue)

**Gemini Models (100% success):**

- gemini-2.5-flash
- gemini-3.1-pro-preview
- gemini-3.0-flash-preview

**Claude Models (83.3% success):**

- claude-4.6-sonnet
- claude-4.5-opus
- claude-4.5-haiku
- claude-4.0-sonnet
- claude-3.7-sonnet
- claude-4.1-sonnet (invalid request)

**Thinking Models (70% success):**

- deepseek/deepseek-v3.2-exp-thinking
- deepseek/deepseek-v3.1-terminus-thinking
- deepseek-r1-0528
- qwen3-30b-a3b-thinking-2507
- qwen3-next-80b-a3b-thinking
- doubao-1.5-thinking-pro
- moonshotai/kimi-k2-thinking
- qwen3-vl-30b-a3b-thinking (upstream unavailable)
- qwen3-235b-a22b-thinking-2507 (upstream unavailable)
- doubao-seed-1.6-thinking (upstream unavailable)

**Key Findings:**

- Proxy works seamlessly with Gemini CLI config (`~/.gemini/.env`)
- Uses `GOOGLE_GEMINI_BASE_URL` and `GEMINI_API_KEY` from CLI config
- 82.8% overall success rate across 29 models from 6+ providers
- All Gemini models (100%) and most Claude models (83.3%) working
- All thinking models show step-by-step reasoning
- SSE streaming: complete message boundaries guaranteed (fixed 2026-03-02)
- 5 failures: 1 upstream issue, 1 invalid request, 3 unavailable models

**Test scripts:**

- `test_gemini_cli.sh` - Basic models test (10 models)
- `test_gemini_models_cli.sh` - Gemini models test (3 models)
- `test_claude_models_cli.sh` - Claude models test (6 models)
- `test_thinking_cli.sh` - Thinking models test (10 models)

## 2026-02-28 — Unconfigured Models Validated

Successfully tested proxy with **no specific model IDs configured** in
`proxy_config.toml`. All models used fallback configuration from
`[models.default]` and `[upstream]` sections.

**Test Results: 100% Success (24/24 tests passed)**

| Test Suite      | Models | Tests | Passed | Success Rate |
|-----------------|--------|-------|--------|--------------|
| DeepSeek Models | 2      | 6     | 6      | 100%         |
| Thinking Models | 4      | 12    | 12     | 100%         |
| SSE Streaming   | 2      | 6     | 6      | 100%         |
| **Total**       | **8**  | **24**| **24** | **100%**     |

**Key Findings:**

- Unconfigured models work perfectly with default settings
- All 3 endpoints supported: `/v1/messages`, `/v1/interactions`,
  `generateContent`
- SSE streaming works for all endpoints
- Thinking/reasoning models work without special configuration
- Fallback chain validated: `[models.default]` → `[upstream]` →
  hardcoded defaults

See `docs/test_results_unconfigured_models.md` for complete details.

## 2026-02-28 — ENV Variables Removed

Removed `FIXED_ROUTE_TARGET_URL` and `FIXED_ROUTE_PATH_PREFIX` environment
variables. All configuration now in `proxy_config.toml`:

**Configuration hierarchy for unconfigured models:**

```
1. [models.default].upstream_mode / base_url / api_key
   ↓ (if missing)
2. [upstream].upstream_mode / default_base_url / default_api_key
   ↓ (if missing)
3. Configurable fallback: "openai-completions" / "https://api.qnaigc.com"
   (hardcoded in src/utils/config-loader.ts, src/index.ts, and src/tui.ts;
    override by setting [upstream].default_base_url or [models.default].base_url
    in proxy_config.toml — there is no env var to override this final fallback)
```

See `docs/config_env_removal.md` for migration guide.

## 2026-02-27 — Config Structure Updated

The routing logic and configuration structure have been revised to align
implementation with documentation:

- **Category-based config**: Models grouped by provider with inheritance
- **Array format**: `["model-alias", "base-url", "api-key"]` with empty
  string inheritance
- **Explicit upstream_mode**: `anthropic-messages`,
  `gemini-generatecontent`, `openai-completions`
- **No normalization**: Model names preserved as-is (e.g.,
  `"deepseek/deepseek-v3.2"`)

See `docs/routing_config_revision.md` for complete details.

## 2026-02-25 — Comprehensive Testing (Production Ready)

See [README.md § Testing](./README.md#-testing) for the consolidated test
result tables and provider success rates. Detailed per-suite breakdowns
live in `docs/test_results_*.md` and `docs/*_test_results.md`.
