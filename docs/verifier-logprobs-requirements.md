# Verifier scorer: logprobs request parameters and backend requirements

The `verifier` composite alias mode (see
[`plan-llm-as-a-verifier-plugin.md`](./plan-llm-as-a-verifier-plugin.md)) ranks
its N sampled candidates with a Probabilistic Pivot Tournament whose scores come
from **token-level logprobs**. The `role = "scorer"` route must therefore resolve
to a backend that actually returns them.

This document records the exact request parameters the sidecar sends, why each
one is load-bearing, and which backends satisfy them — the last part because a
backend that *accepts* `logprobs: true` and silently drops it looks identical to
a working one until every comparison ties 0.5/0.5.

Source of truth: `llm_verifier/fine_grained_reward.py` in the
[`llm-as-a-verifier`](https://github.com/llm-as-a-verifier/llm-as-a-verifier)
repo (`call_openai`, `_score_tags_by_prefill`, `call_deepseek`, `call_gemini`).

---

## Two calls per scored pair

Scoring one candidate pair is **not** a single request. The OpenAI-compatible
path issues an analysis call, then one prefill call per score tag.

### Call 1 — analysis pass

`call_openai`, `fine_grained_reward.py:417`.

```json
{
  "model": "<resolved model>",
  "messages": [{"role": "user", "content": "<pairwise prompt>"}],
  "max_tokens": 4096,
  "temperature": 1.0,
  "logprobs": true,
  "top_logprobs": 20
}
```

On the first attempt this is sent with an additional `extra_body` merged into
the JSON body:

```json
"chat_template_kwargs": {"enable_thinking": false}
```

If that request raises, it is retried **without** `chat_template_kwargs`
(`fine_grained_reward.py:425-431`). The flag skips hybrid-thinking on
vLLM/SGLang so the score tags arrive without a long reasoning preamble; a server
that rejects the unknown field still works via the retry.

`top_logprobs: 20` is the default (`top_logprobs=20` parameter) and is also the
OpenAI API's documented ceiling.

### Call 2 — prefill pass (the one that harvests the distribution)

`_score_tags_by_prefill`, `fine_grained_reward.py:485`. Runs **once per score
tag** present in the prompt — normally `<score_A>` and `<score_B>`, so two calls.

```json
{
  "model": "<same model>",
  "messages": [
    "...original messages...",
    {"role": "assistant", "content": "<analysis>\n<score_A>"}
  ],
  "max_tokens": 1,
  "temperature": 1.0,
  "logprobs": true,
  "top_logprobs": 20
}
```

with `extra_body`:

```json
{
  "add_generation_prompt": false,
  "continue_final_message": true,
  "structured_outputs": {
    "choice": ["A", "B", "...", "T", " A", " B", "...", " T"]
  }
}
```

The `choice` list holds **40 entries**: the 20 scale letters (`GRANULARITY`),
each in bare and leading-space form (`fine_grained_reward.py:479-480`). Both
spellings are allowed because some models (e.g. Qwen VL) put nearly all their
mass on the letter *with* a leading space after the prefilled `>`; omitting the
space variants would mask the real distribution.

---

## Why each parameter is load-bearing

| Parameter | Role |
|---|---|
| `logprobs: true` + `top_logprobs: 20` | The distribution itself. Without it, `extract_score` finds nothing and every score falls back to `0.5` (`fine_grained_reward.py:707`). |
| `continue_final_message: true` + `add_generation_prompt: false` | Makes the server **continue** the prefilled assistant turn instead of starting a new one, so response token position 0 *is* the score letter. |
| `structured_outputs: {"choice": [...]}` | Constrains that position to the scale letters, so the returned top-logprobs are the renormalized distribution over the scale rather than over the whole vocabulary. |
| `max_tokens: 1` | Only the single letter position is needed. |

The `add_generation_prompt` / `continue_final_message` / `structured_outputs`
trio is **vLLM/SGLang-specific**. This is precisely why the upstream README
names vLLM and SGLang as the supported self-hosted backends.

### Graceful degradation

`_score_tags_by_prefill` wraps its call in `try/except` and, on any exception,
returns tag-less results (`fine_grained_reward.py:497-498`) — scores then fall
back to `0.5`. A server that rejects the prefill parameters therefore **does not
error**; it quietly produces ties. That silent path is the motivation for the
startup probe below.

---

## Non-OpenAI backends

Two backends take different paths and do **not** use the prefill trick.

**DeepSeek** (`call_deepseek`, `fine_grained_reward.py:525`) emits the score tags
itself and lacks the prefill parameters, so the prefill pass is skipped entirely
(guarded by `_llm_verifier_deepseek`, `fine_grained_reward.py:454`). It sends
`logprobs: true` + `top_logprobs: 20` plus reasoning params from
`deepseek_reasoning_params()`. A response whose reasoning consumed the whole
output budget — leaving no answer logprobs — **raises** rather than silently
scoring a tie (`fine_grained_reward.py:566-572`).

**Vertex AI Gemini** (`call_gemini`, `fine_grained_reward.py:588`) uses
`google-genai` with `GenerateContentConfig(response_logprobs=True,
logprobs=top_logprobs, thinking_config=ThinkingConfig(thinking_budget=0))`.
Vertex only — the plain Gemini API does not expose token-level logprobs
(`fine_grained_reward.py:109-118`).

---

## Supported backends

Per `create_openai_client` / `create_deepseek_client` / `create_gemini_client`
(`fine_grained_reward.py:125-176`) and the upstream README:

| Backend | How | Prefill trick |
|---|---|---|
| **vLLM / SGLang** (self-hosted) | `OPENAI_BASE_URL=http://localhost:8000/v1`, e.g. `vllm serve Qwen/Qwen3.5-9B` | Yes |
| **DeepSeek** (hosted) | `DEEPSEEK_API_KEY`, `https://api.deepseek.com` | No — emits tags itself |
| **Vertex AI Gemini** | `VERTEX_API_KEY` (Vertex only, not the plain Gemini API) | No — native logprobs config |

Client selection order in `create_client` (`fine_grained_reward.py:167-176`):
`OPENAI_BASE_URL`, then `DEEPSEEK_API_KEY`, then `VERTEX_API_KEY`.

---

## Verifying a candidate scorer

Because an unsupported backend degrades silently, check before wiring one in.

`serve.py --probe-model <model>` runs a one-shot `logprobs=True` startup check
and refuses to serve when the backend returns none
(`serve.py:262-280`, `serve.py:397-408`), and `GET /health` reports the cached
result alongside `version` and the configured `base_url`:

```json
{"status": "ok", "version": "...", "logprobs_ok": true, "base_url": "..."}
```

`logprobs_ok` is `true`, `false`, or `"unchecked"` when no probe ran.

To probe by hand:

```bash
curl -s "$BASE_URL/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"model":"<model>","messages":[{"role":"user","content":"Say OK."}],
       "max_tokens":50,"logprobs":true,"top_logprobs":5}' \
  | python3 -c "import json,sys; c=json.load(sys.stdin)['choices'][0]; print('logprobs:', bool(c.get('logprobs')))"
```

A backend is only usable as a scorer if `choices[0].logprobs.content` is
present and populated.

Two useful follow-up probes distinguish "ignored" from "supported":

- Send `top_logprobs: 999`, far above the API cap of 20. A backend that
  validates the parameter rejects it; one that silently accepts is discarding it.
- Send a prefill (`{"role":"assistant","content":"analysis\n<score_A>"}`) with
  `continue_final_message: true`. A supporting backend continues that turn; a
  non-supporting one starts a fresh reply, which is what breaks scoring.

### Observed results

Probed 2026-08-24 while bringing up the end-to-end integration test:

| Backend | `logprobs` returned |
|---|---|
| All 12 models behind the local gateway on `:8788` (`code-small`, `codestrong`, `codelite`, `codesmall`, `smarter`, `forclaw`, `auditor`, `glm-5.2-anth`, `glm-5.2-comp`, `glm-5.3-anth`, `glm-5.3-comp`, `qwen3.8`) | No |
| `glm-5.3` direct on `open.bigmodel.cn` | No |

`qwen3.8` is explicit — `"logprobs is not supported for chat completions"`
(`code: unsupported_parameter`). The rest accept the parameter and omit the
field from the response. `glm-5.3` on bigmodel.cn additionally accepted
`top_logprobs: 999` without complaint and ignored `continue_final_message`
(starting a fresh reasoning trace rather than continuing the prefilled tag), so
neither the direct nor the prefill route yields a distribution there.

None of these are usable as a `role = "scorer"` route. A scorer needs one of the
three supported backends above.
