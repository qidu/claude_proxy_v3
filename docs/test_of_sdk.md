# Multi-SDK Test (`tests/multi-sdk-test.ts`)

## Running

```sh
# list available models / SDKs / prompts without running
npx tsx tests/multi-sdk-test.ts

# simple smoke — all models × all SDKs × all 20 prompts
npx tsx tests/multi-sdk-test.ts --all

# feature matrix (Vercel AI SDK only: plain / tools / reasoning / multiturn)
npx tsx tests/multi-sdk-test.ts --features

# simple smoke, model 1, SDK 1 (vercel-ai), prompt 5
npx tsx tests/multi-sdk-test.ts 1 1 5

# feature matrix, model 2, feature 3 (reasoning)
npx tsx tests/multi-sdk-test.ts 2 3 --features
```

## Prerequisites

- Proxy running locally on `PORT=7777` with `DEV_NO_KEY=true`.
- `API_KEY` env var set (any non-empty string, e.g. `export API_KEY=sk-hi`).
- The following packages installed (they are **not** in `package.json` — install
  separately so they don't become build-time deps):

  ```sh
  npm i ai @ai-sdk/anthropic @google/genai
  npm i @anthropic-ai/claude-agent-sdk
  npm i @openai/codex-sdk
  npm i @earendil-works/pi-agent-core @earendil-works/pi-ai
  ```

## SDK coverage

| # | Name | Package | Wire format |
|---|---|---|---|
| 1 | `vercel-ai` | `ai` + `@ai-sdk/anthropic` | POST `/v1/messages` via `customProvider` |
| 2 | `claude` | `@anthropic-ai/claude-agent-sdk` | POST `/v1/messages` via `ANTHROPIC_BASE_URL` |
| 3 | `gemini` | `@google/genai` | POST `/v1/models/{model}:generateContent` via `httpOptions.baseUrl` |
| 4 | `codex` | `@openai/codex-sdk` | POST `/v1/responses` via `~/.codex/config.toml base_url` |
| 5 | `pi` | `@earendil-works/pi-agent-core` | POST `/v1/messages` via `provider.baseUrl` |

---

## Dig 1 — Why `@ai-sdk/anthropic` errors on a missing `signature` but `@anthropic-ai/claude-agent-sdk` does not

### Background

When the proxy routes to a non-Anthropic upstream (e.g. `glm-5.2`, DeepSeek)
via `openai-completions`, it converts reasoning back to a Claude `thinking`
content block. Anthropic's spec marks `signature` as REQUIRED on thinking
blocks. Non-Anthropic upstreams never emit a signature, so the proxy
synthesizes a constant placeholder (`SYNTHETIC_THINKING_SIGNATURE = "synthetic"`).

Before that fix was in place, `vercel-ai` (SDK #1) threw:

```
AI SDK Warning (anthropic.messages / glm-5.2-anth): TypeValidationError: Invalid JSON response
```

…while `claude` (SDK #2) produced the correct answer silently.

### Root cause

The two SDKs parse the `/v1/messages` HTTP response differently:

**`@ai-sdk/anthropic`** (`node_modules/@ai-sdk/anthropic/dist/index.js`)

On the non-streaming path it calls:
```js
successfulResponseHandler: createJsonResponseHandler(anthropicResponseSchema)
```
`createJsonResponseHandler` (from `@ai-sdk/provider-utils`) runs
`safeParseJSON` against the Zod schema. The thinking-block branch is:
```js
z3.object({
  type: z3.literal("thinking"),
  thinking: z3.string(),
  signature: z3.string()   // REQUIRED — not .optional()
})
```
A thinking block without `signature` fails this parse and throws
`TypeValidationError`.

**`@anthropic-ai/sdk`** (used by `@anthropic-ai/claude-agent-sdk`, `node_modules/@anthropic-ai/sdk/internal/parse.js:9-55`)

```js
async function defaultParseResponse(client, props) {
    ...
    const json = await response.json();
    return addRequestID(json, response);   // attaches non-enumerable _request_id only
}
```
Plain `JSON.parse`, no schema, no validation. `ThinkingBlock.signature: string`
in `@anthropic-ai/sdk` is a TypeScript `interface` — erased at runtime.  A
missing `signature` becomes `undefined` on the returned object; no error thrown.

### Summary

| SDK | Response parsing | `signature` enforcement | Missing signature |
|---|---|---|---|
| `@ai-sdk/anthropic` | Zod `safeParseJSON` against `anthropicResponseSchema` | Runtime-required (`z3.string()`) | **Throws `TypeValidationError`** |
| `@anthropic-ai/sdk` (claude-agent-sdk) | Bare `response.json()` | TypeScript `interface` only (erased) | **Silently `undefined`** |

The synthetic constant `"synthetic"` satisfies `z3.string()` — no format or
crypto check is performed by the SDK. Both the strict and lenient consumers
accept it.

---

## Dig 2 — `@ai-sdk/anthropic` does not depend on `@anthropic-ai/sdk`
(refer to 'SYNTHETIC_THINKING_SIGNATURE' or '### Fix: synthesize a `signature` on signature-less thinking blocks' in CHANGELOG.md)

They are **independent implementations** with no shared code:

```json
// node_modules/@ai-sdk/anthropic/package.json — dependencies
{
  "dependencies": {
    "@ai-sdk/provider": "4.0.5",
    "@ai-sdk/provider-utils": "5.0.21"
  },
  "peerDependencies": {
    "zod": "^3.25.76 || ^4.1.8"
  }
}
```

`@anthropic-ai/sdk` does not appear anywhere. `@ai-sdk/anthropic` is Vercel's
own reimplementation of the Anthropic wire protocol, built on top of the Vercel
AI SDK's provider primitives. It shares nothing at runtime with Anthropic's
official SDK.

`@anthropic-ai/claude-agent-sdk` takes the opposite approach — it has no HTTP
client of its own and requires `@anthropic-ai/sdk >=0.93.0` as a peer dep,
delegating all HTTP parsing to it.

The stricter Zod validation that triggered the signature error is therefore a
property of Vercel's independent reimplementation, not a version constraint or
shared code path between the two SDKs.

---

## Scope of `SYNTHETIC_THINKING_SIGNATURE`

The constant only applies to the **Claude→OpenAI→Claude conversion paths**:

- `openai-completions` / `openai-responses` upstreams (via `messages.ts`)
- `sdk://` handler (via `sdk-handler.ts` → `convertOpenAIToClaudeResponse`)

On these paths the reverse converter (`claude-to-openai.ts`) round-trips
reasoning via `reasoning_content` and **drops** the signature entirely before
the upstream call, so the placeholder is never seen by any verifier.

For `upstream_mode = "anthropic-messages"` the proxy is a **pure pass-through**
and does not synthesize anything:

- Client sends prior thinking blocks with a valid Anthropic-issued signature →
  forwarded as-is; real Anthropic/Bedrock verifies and accepts it. ✓
- Client sends prior thinking blocks with a missing or garbage signature →
  forwarded as-is; real Anthropic/Bedrock rejects with HTTP 400. The proxy is
  a faithful courier — the signature contract is between the client and
  Anthropic, not the proxy's responsibility.
