# Transforms and Hooks — Analysis & UX Recommendations

## What they are (in plain terms)

**Hooks** = *five* well-defined seams in the request lifecycle where rewriting happens. Think of them as the 5 places in the pipe where someone might want to "touch" the body or headers, and each seam sees data in a *specific schema*:

| Hook | When | Schema seen | Side |
|------|------|--------------|------|
| `endpoint_readin` | after JSON parse, before routing | client | request |
| `before_conversion` | after routing, before format converter | client | request |
| `before_upstream` | after format conversion, before `fetch` | upstream | request |
| `after_upstream` | after `fetch`, before `!ok` check | upstream | response |
| `endpoint_writeout` | before `Response` returned to client | client | response |

**Transforms** = *declarative rules* declared per model in `proxy_config.toml`, organized as **named sets** (`[transforms.<name>]`), grouped into a **two-tier engine**:

- **Tier 1 — generic ops** (`rename`, `set`, `default`, `remove`, `map_value`) over **shallow paths** only: top-level fields, or `messages[role=X].<field>`, or `$response.<field>`
- **Tier 2 — named built-ins** (`lowercase_tool_schema_types`, `recover_tool_message_name`, `inject_missing_tool_results`) — for deep/cross-message logic that Tier 1 can't express

How a model gets them: **mode defaults → sector defaults → entry `transforms = "..."`**, concatenated left-to-right.

---

## What's already good

1. **Two-tier split** is a clean way to keep the engine small while still allowing fancier things — exactly the lesson the design doc cites ("a fully-generic rule DSL would be over-engineering").
2. **Hooks are named after lifecycle position**, not after internal mechanics — `before_upstream` is *immediately* understandable.
3. **Fast-path gates** (`hasHookOps`, `applyAfterUpstream` short-circuit) mean zero overhead when no transforms apply.
4. **Strict path validation at config load** is the right call — a misspelled path becomes a hard load error, not a silent no-op (per CLAUDE.md §8).
5. **Naming reused across models** avoids copy-paste (e.g. `deepseek_compat` shared between routes).
6. **`when_sibling` guard** on `map_value` is the kind of small thoughtful primitive that makes a config expressive without bloating the DSL.

---

## Pain points for users

### 1. Five hooks is a lot; the *split* between them isn't obvious

The split between `endpoint_readin` vs `before_conversion` (both client-schema!) and the placement of `before_conversion` between `endpoint_readin` and `before_upstream` is the most non-obvious part. Users will ask: "Why isn't there one `request` hook and one `response` hook?"

The naming also gives no hint about ordering — a reader has to consult the implementation doc to learn that `readin` runs before `before_conversion` runs before `before_upstream`.

### 2. The name `endpoint_readin`/`endpoint_writeout` is opaque

Other systems call these `pre-routing` / `post-response`, or `ingress` / `egress`. `endpoint_readin` is jargon only the engine author understands. Same for `before_conversion` — it really means "client-schema body, post-route, pre-format-conversion".

### 3. The `map_value` + `when_sibling` syntax is dense and easy to misplace

```toml
{ op = "map_value", path = "messages[role=assistant].content", when_sibling = "tool_calls", from = "", to = null }
```

This one op simultaneously encodes: role filter + sibling guard + from-value + to-value. A comma-quoted triple is hard to scan and easy to misread where `from` is empty (`""`) or `to` is `null`.

### 4. Path syntax is inconsistent-looking

Three shapes:
- top-level: `max_tokens`
- messages + role: `messages[role=assistant].content`
- response prefix: `$response.id`

`$response.*` looks like a magic prefix; new users won't know it exists or what it scopes to (shallow only, nested walks are a hard error per Step 13a).

### 5. Two-tier split is invisible in config

A user reading a set sees `builtins = [...]` and `ops = [...]` — they don't learn that one is "deep magic" and the other is "shallow rewrite." The order within a hook (`builtins` first, then `ops`) is documented but not enforced by naming.

### 6. Default-resolution order is implicit

A user seeing `transforms = "max_tokens_rename"` on a model entry won't know why `max_tokens` is being renamed unless they discover `[transform_defaults]` and learn it's bound to `upstream_mode`. The chain mode→sector→entry is invisible from any single file.

### 7. No "what runs for my model" introspection

If a model has multiple transforms applied (mode default + sector default + entry), there's no command/endpoint to list *the effective resolved set* with the per-hook op list. Users must reason from declarative sources.

### 8. Two config surface names for the same thing

`transforms` (singular field on a model) vs `[transforms.*]` (plural table of named sets). The same word means (a) "which transform sets apply to this route" and (b) "the namespace of reusable set definitions". Confusion amplified by `proxy_config.toml` examples using `transforms = "name"` (string) while the design doc says `transforms = ["name1", "name2"]` (list).

### 9. Built-ins are by-name only

`lowercase_tool_schema_types`, `recover_tool_message_name`, `inject_missing_tool_results` — descriptive names, but a user has no place that lists "all available built-ins" with one-liner descriptions and the schema they're gated to. They discover them by reading the engine source.

### 10. The `inline` and `defaults` naming conflicts with TOML mental model

`headers = { set = {…}, remove = […] }` uses `set` both as a TOML-table-key and as a transform-op name. A user reading `{set = {…}}` under `headers` may misread `set` as the `set` op. Subtle but real.

---

## Recommendations (no source changes — proposed)

### Naming / discoverability

- **Rename `endpoint_readin` → `request_ingress`** and `endpoint_writeout` → `response_egress`** (or `pre_route`, `post_response`) — words that signal the side and the time. Keep aliases for backwards compatibility.
- **Add a `docs/transforms-reference.md` "cheat sheet"** with three columns: hook name · *plain-English one-liner* · *what schema shape you'll see*. Half the friction is gone if users see "this hook fires *just before the upstream fetch, on the upstream-format body*" at a glance.
- **Add a `[transforms]` built-in registry table** (always-visible reference doc, not in config). List every `BuiltinName`, what it does in 1 line, which schemas it works under, and one example TOML using it.

### Config ergonomics

- **Make `transforms = "..."` (string) and `transforms = ["a","b"]` (list) both accepted** — already partly true, but document and normalize in one place. New users start with a string; complex users graduate to a list.
- **Group per-hook ops under explicit named keys, not just slot inference.** Some teams find `endpoint_readin.builtins` clearer if it could become a section with a `description = "..."` and a `when = "..."` field. Optional, but visible in editors and validators.
- **For `map_value`, allow a shorter form** for the common `when role=X with sibling Y, then map value`. Even something like `path = "messages[role=assistant,has=tool_calls].content"` keeps it inline. Or accept both legacy and sugar forms, mapping internally.
- **Consistently use `$response.` OR a separate `response.path` key** — pick one. The `$` prefix looks like a JSONPath reference and invites confusion about why nested arrays don't work.

### Visibility / introspection

- **`--show-effective-transforms <model>` (or `GET /__internal/transforms/<model>`)** — print the resolved per-hook op list with the source set name (mode/sector/entry). One line of relief for the "what runs for me?" question.
- **At log-emit time, one DEBUG line per request** like `transforms: readin=[deepseek_compat:builtins=1] before_upstream=[max_tokens_rename:ops=1, deepseek_compat:ops=1,builtins=1]`. Off by default; users opt in.
- **A `[transforms.<name>]._doc = "…"` field** in TOML (parsed but unused) for self-documenting config — has zero runtime cost, prints in `--show-effective-transforms`.

### Defaults documentation

- **Replace implicit `transform_defaults` resolution with explicit list on the entry.** Have `resolveModelRouteFromEntry` *also* output `[transforms]` showing the order, and warn if the same hook fires from more than one set without explicit ordering. Don't change behavior — just expose it.
- **A `claude`-style annotation in the example**: `[transforms.deepseek_compat]  # applied at before_upstream for deepseek-v4-{comp,anth}`.

### Schema authoring

- **Tier 1 + Tier 2 prefix in the config** so the split is visible: `tier1 = [...]` and `tier2 = [...]` instead of `ops` and `builtins`. Or accept either, normalize internally, surface as one.
- **A "preset" alias for built-in combinations.** The example has `deepseek_compat` *as a set* that *itself* lists built-ins (`lowercase_tool_schema_types`, `recover_tool_message_name`). Bundling common built-in combos under a higher-level name (`preset = "deepseek_v3_plus"`) saves three lines per new model.

### Validation feedback

- **Emitted error message when validation rejects a path** — today is presumably "unknown path"; a verbose error that says *"paths of shape `messages[role=X].field` are supported; `messages[].function.parameters` requires the `lowercase_tool_schema_types` builtin instead (see [docs link])"* turns a wall into a tutorial.
- **Validate at config load is good. Add a `npx model_proxy_v3 doctor --config <file>` to dry-run a config and dump validation errors without starting the server.**

### Docs structure

- Replace the deep design-doc-driven mental model with a layered doc set:
  1. **`docs/transforms-overview.md`** — 1 page. The mental model, the 5 hooks table, the 5 ops table. No rationale.
  2. **`docs/transforms-reference.md`** — the cheat sheet above.
  3. **`docs/transforms-builtins.md`** — one row per built-in.
  4. **`docs/transforms-design.md`** — the existing design doc, deferred reading.
- Currently the user has to read the design doc to learn the lifecycle ordering; that should be visible in 5 rows in a table.

---

## TL;DR

Most of the friction is **discoverability**, not design. The architecture (two tiers, five hooks, named sets + defaults) is sound. The problems are:

- The five hook names don't carry their plain meaning.
- Tier 1 / Tier 2 distinction is invisible in TOML.
- "What runs for my route" requires reading the engine to answer.
- `map_value` packs three concerns into one line.
- Built-ins, defaults, and ordering are all learnable but none are *lookable-upable*.

Most-impactful fixes per effort:
1. **Add a 1-page reference + a built-ins table** (highest leverage, zero code).
2. **Rename `endpoint_readin/writeout`** to plain names + aliases (medium effort, big clarity win).
3. **Add `--show-effective-transforms`** introspection (medium effort, removes a class of "why isn't my rule firing?" support).
4. **Tighten `map_value` ergonomics** with optional sugar syntax or `when = "role=assistant & has=tool_calls"` form.
