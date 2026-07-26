/**
 * Request/response transform engine.
 *
 * Implements the two-tier transform system from design_request_transform_hooks.md:
 *   Tier 1 — generic ops (rename / set / default / remove / map_value) over shallow paths
 *   Tier 2 — named built-in ops for cases requiring deep recursion or cross-message lookup
 *
 * Entry point: runHook(hook, payload, ctx)
 */

import type { TransformSet, TransformOp, BuiltinName } from './config-loader.js';
import type { ModelRouteConfig } from './config-loader.js';
import type { Logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HookPoint =
  | 'endpoint_readin'
  | 'before_conversion'
  | 'before_upstream'
  | 'after_upstream'
  | 'endpoint_writeout';

export interface HookContext {
  hook: HookPoint;
  route: ModelRouteConfig;
  upstreamMode: string;
  clientModel: string;
  requestId: string;
  streaming: boolean;
  logger: Logger;
  /** Upstream HTTP status — set on after_upstream / endpoint_writeout only. */
  status?: number;
}

export interface HookBodyPayload {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** Transform a single SSE event object; return null to drop the event. */
export type EventTransformer = (
  event: Record<string, unknown>,
  ctx: HookContext,
) => Record<string, unknown> | null;

// ---------------------------------------------------------------------------
// Tier-2 built-in implementations
// ---------------------------------------------------------------------------

/**
 * Recursively lowercases every `type` field within a JSON-Schema object.
 * Ports the inline logic from chat-completions.ts:20-36 and openai.ts:88.
 */
function lowercaseSchemaTypes(schema: Record<string, unknown>): void {
  if (typeof schema.type === 'string') {
    schema.type = schema.type.toLowerCase();
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const v of Object.values(schema.properties as Record<string, unknown>)) {
      if (v && typeof v === 'object') lowercaseSchemaTypes(v as Record<string, unknown>);
    }
  }
  if (Array.isArray(schema.items)) {
    for (const item of schema.items) {
      if (item && typeof item === 'object') lowercaseSchemaTypes(item as Record<string, unknown>);
    }
  } else if (schema.items && typeof schema.items === 'object') {
    lowercaseSchemaTypes(schema.items as Record<string, unknown>);
  }
}

function applyBuiltin(name: BuiltinName, body: Record<string, unknown>): void {
  if (name === 'lowercase_tool_schema_types') {
    if (!Array.isArray(body.tools)) return;
    for (const tool of body.tools as Record<string, unknown>[]) {
      // OpenAI-completions shape: tool.function.parameters
      const fn = tool.function as Record<string, unknown> | undefined;
      if (fn?.parameters && typeof fn.parameters === 'object') {
        lowercaseSchemaTypes(fn.parameters as Record<string, unknown>);
      }
      // Anthropic-messages shape: tool.input_schema
      if (tool.input_schema && typeof tool.input_schema === 'object') {
        lowercaseSchemaTypes(tool.input_schema as Record<string, unknown>);
      }
    }
    return;
  }

  if (name === 'recover_tool_message_name') {
    // Ports chat-completions.ts:94-110.
    // Build an index of tool_call_id → function.name from assistant turns.
    if (!Array.isArray(body.messages)) return;
    const msgs = body.messages as Record<string, unknown>[];
    const toolCallIndex = new Map<string, string>();
    for (const msg of msgs) {
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls as Record<string, unknown>[]) {
          const id = tc.id as string | undefined;
          const fnName = (tc.function as Record<string, unknown> | undefined)?.name as string | undefined;
          if (id && fnName) toolCallIndex.set(id, fnName);
        }
      }
      if (msg.role === 'tool' && !msg.name) {
        const name = toolCallIndex.get(msg.tool_call_id as string);
        if (name) msg.name = name;
      }
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// Tier-1 path resolution helpers
// ---------------------------------------------------------------------------

/** Splits a path into (kind, field, roleFilter | null). */
function parsePath(path: string): {
  kind: 'top' | 'messages' | 'response';
  field: string;
  roleFilter: string | null;
} {
  // messages[].field  or  messages[role=X].field
  const msgMatch = path.match(/^messages\[(?:role=(\w+))?\]\.(.+)$/);
  if (msgMatch) {
    return { kind: 'messages', field: msgMatch[2], roleFilter: msgMatch[1] ?? null };
  }
  // $response.<field> — response-side path, applied to the body root (the
  // response schema mirrors the request schema, so we just rewrite a top-level
  // field of the same shape). Bracket suffixes like `choices[].message.role`
  // are not yet supported; the validator accepts them but they will fall back
  // to literal-key assignment until path-walk is added.
  if (path.startsWith('$response.')) {
    return { kind: 'response', field: path.slice('$response.'.length), roleFilter: null };
  }
  // top-level single segment (no dots, no brackets)
  return { kind: 'top', field: path, roleFilter: null };
}

function applyOpToBody(op: TransformOp, body: Record<string, unknown>): void {
  const parsed = parsePath(op.path);

  if (parsed.kind === 'top' || parsed.kind === 'response') {
    // Both 'top' and 'response' rewrite a top-level field of the body. The
    // distinction exists only for the parsePath API so callers can tell what
    // side they're touching; the body shape is the same.
    applyOpToObject(op, body, parsed.field);
    return;
  }

  if (parsed.kind === 'messages' && Array.isArray(body.messages)) {
    const msgs = body.messages as Record<string, unknown>[];
    for (const msg of msgs) {
      if (parsed.roleFilter && msg.role !== parsed.roleFilter) continue;
      applyOpToObject(op, msg, parsed.field);
    }
  }
}

function applyOpToObject(op: TransformOp, obj: Record<string, unknown>, field: string): void {
  switch (op.op) {
    case 'rename': {
      if (field in obj) {
        obj[op.to] = obj[field];
        delete obj[field];
      }
      break;
    }
    case 'set': {
      obj[field] = op.value;
      break;
    }
    case 'default': {
      if (!(field in obj) || obj[field] === undefined) {
        obj[field] = op.value;
      }
      break;
    }
    case 'remove': {
      delete obj[field];
      break;
    }
    case 'map_value': {
      // If when_sibling guard is set, only apply when that sibling key exists
      if (op.when_sibling && !(op.when_sibling in obj)) break;
      if (obj[field] === op.from) {
        obj[field] = op.to;
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Header transforms
// ---------------------------------------------------------------------------

function applyHeaderTransforms(
  headers: Record<string, string>,
  headerSpec: { set?: Record<string, string>; remove?: string[] } | undefined,
): Record<string, string> {
  if (!headerSpec) return headers;
  const result = { ...headers };
  for (const [k, v] of Object.entries(headerSpec.set ?? {})) {
    result[k] = v;
  }
  for (const k of headerSpec.remove ?? []) {
    delete result[k];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Core: apply one transform set at one hook
// ---------------------------------------------------------------------------

function applyTransformSet(
  set: TransformSet,
  hook: HookPoint,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): { body: Record<string, unknown>; headers: Record<string, string> } {
  const slot = set[hook];
  if (!slot) return { body, headers };

  // Tier-2 built-ins first
  for (const b of slot.builtins ?? []) {
    applyBuiltin(b, body);
  }

  // Tier-1 ops in declared order
  for (const op of slot.ops ?? []) {
    applyOpToBody(op, body);
  }

  // Header transforms (before_upstream / endpoint_writeout only)
  const headerSpec = (slot as { headers?: { set?: Record<string, string>; remove?: string[] } }).headers;
  headers = applyHeaderTransforms(headers, headerSpec);

  return { body, headers };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all transforms declared for `hook` across the resolved transform list.
 * Folds left-to-right: each set sees the output of the previous.
 */
export function runHook(
  hook: HookPoint,
  payload: HookBodyPayload,
  ctx: HookContext,
): HookBodyPayload {
  const transforms = ctx.route.transforms;
  if (!transforms || transforms.length === 0) return payload;

  let { body, headers } = payload;
  for (const set of transforms) {
    ({ body, headers } = applyTransformSet(set, hook, body, headers));
  }
  return { body, headers };
}

/**
 * Apply `after_upstream` transforms to a raw upstream Response.
 *
 * Fast-path: if no transforms declare ops at `after_upstream`, returns the
 * original Response object unchanged (no buffering, no overhead).
 *
 * Active path: buffers the response body as JSON, applies all declared ops,
 * and returns a new Response with the modified JSON body (same status/headers).
 * If the body is not valid JSON, it is passed through unchanged.
 *
 * Call this immediately after `fetch()`, before any `if (!response.ok)` check:
 *   const response = await fetch(...);
 *   const transformed = await applyAfterUpstream(response, ctx);
 *   if (!transformed.ok) { ... }
 */
export async function applyAfterUpstream(
  response: Response,
  ctx: HookContext,
): Promise<Response> {
  const transforms = ctx.route.transforms;
  if (!transforms || transforms.length === 0) return response;

  const activeSets = transforms.filter(s => s['after_upstream'] !== undefined);
  if (activeSets.length === 0) return response;

  // Buffer body and parse JSON.
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON — reconstruct original response and return unchanged.
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  // Apply ops (status available in ctx).
  const hookCtx: HookContext = { ...ctx, status: response.status };
  let headers: Record<string, string> = {};
  for (const set of activeSets) {
    ({ body, headers } = applyTransformSet(set, 'after_upstream', body, headers));
    void headers; // header ops not supported on after_upstream (response headers come from fetch)
  }

  const responseHeaders = new Headers(response.headers);
  return new Response(JSON.stringify(body), {
    status: hookCtx.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

/**
 * Build an EventTransformer for streaming responses at `hook`.
 * Returns null if no transforms declare ops at this hook (fast path).
 */
export function buildEventTransformer(
  hook: HookPoint,
  ctx: HookContext,
): EventTransformer | null {
  const transforms = ctx.route.transforms;
  if (!transforms || transforms.length === 0) return null;

  const activeSets = transforms.filter(s => s[hook] !== undefined);
  if (activeSets.length === 0) return null;

  return (event, _ctx) => {
    let body = event;
    let headers: Record<string, string> = {};
    for (const set of activeSets) {
      ({ body, headers } = applyTransformSet(set, hook, body, headers));
      void headers; // headers not used on stream events
    }
    return body;
  };
}

/**
 * Check whether any declared transform set has ops at `hook` — used as a fast-path
 * gate by `applyWriteoutBody` and `pipeEventTransformer` to avoid cloning/buffering
 * when no rules fire.
 */
export function hasHookOps(hook: HookPoint, transforms: TransformSet[] | undefined): boolean {
  if (!transforms || transforms.length === 0) return false;
  return transforms.some(s => s[hook] !== undefined);
}

/**
 * Apply `endpoint_writeout` body transforms to a final client Response.
 *
 * - Fast-path: when no transforms declare `endpoint_writeout` ops, returns the
 *   original Response unchanged (no buffering).
 * - Buffered JSON: buffers the body, applies ops, returns a new Response with
 *   the rewritten JSON body (status/headers preserved).
 * - Non-JSON bodies (including SSE streams): passed through unchanged.
 *
 * Streaming transform support lives in `pipeEventTransformer` — call sites that
 * want per-event SSE rewriting for the writeout hook wrap their stream with it.
 *
 * Mirror of `applyAfterUpstream` but on the client-schema response.
 */
export async function applyWriteoutBody(
  response: Response,
  ctx: HookContext,
): Promise<Response> {
  if (!hasHookOps('endpoint_writeout', ctx.route.transforms)) return response;

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) return response;

  // Buffer body and parse JSON.
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  // Apply ops.
  const hookCtx: HookContext = { ...ctx, status: response.status };
  let headers: Record<string, string> = {};
  for (const set of ctx.route.transforms!) {
    const slot = set['endpoint_writeout'];
    if (!slot) continue;
    ({ body, headers } = applyTransformSet(set, 'endpoint_writeout', body, headers));
    void headers; // header ops on endpoint_writeout run in index.ts central wrap
  }
  void hookCtx;

  const responseHeaders = new Headers(response.headers);
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

/**
 * Wrap an SSE byte stream so each `data: {...}\n\n` event passes through the
 * writeout hook's per-event transformer before being written to the new stream.
 *
 * Returns the original stream body unchanged when no transforms declare
 * `endpoint_writeout` ops (fast path). Events whose transformer returns null are
 * dropped. Other events are re-emitted as `data: <json>\n\n`. Non-data lines and
 * blank-line-terminated comments are passed through verbatim.
 */
export function pipeEventTransformer(
  responseBody: ReadableStream<Uint8Array>,
  ctx: HookContext,
): ReadableStream<Uint8Array> | null {
  const transformer = buildEventTransformer('endpoint_writeout', ctx);
  if (!transformer) return null;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  return new ReadableStream({
    async start(controller) {
      const reader = responseBody.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE events are delimited by blank line.
          const events = buffer.split('\n\n');
          buffer = events.pop() ?? '';
          for (const ev of events) {
            if (!ev.trim()) continue;
            const transformed = transformSseEvent(ev, transformer, ctx, controller, encoder);
            if (transformed === null) continue; // dropped
            // `transformSseEvent` already pushed bytes when applicable
          }
        }
        // flush trailing buffer
        if (buffer.trim()) {
          transformSseEvent(buffer, transformer, ctx, controller, encoder);
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

function transformSseEvent(
  eventText: string,
  transformer: EventTransformer,
  ctx: HookContext,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): null | undefined {
  // Find the data: line(s); multi-data events are concatenated as a JSON array by spec
  // but most providers use one data: line per event. We treat single-line events.
  const lines = eventText.split('\n');
  const dataParts: string[] = [];
  const otherLines: string[] = [];
  let terminated = false;
  for (const line of lines) {
    if (line.startsWith('data:')) {
      // data: payload (no space) or "data: payload" (single space).
      const payload = line.startsWith('data: ') ? line.slice(6) : line.slice(5);
      if (payload === '[DONE]') {
        // Sentinel — always pass through unchanged so clients terminate cleanly.
        controller.enqueue(encoder.encode(`${line}\n\n`));
        continue;
      }
      dataParts.push(payload);
    } else if (line === '') {
      terminated = true;
    } else {
      otherLines.push(line);
    }
  }
  if (dataParts.length === 0) {
    // Comments / event: / id: lines — pass through verbatim
    controller.enqueue(encoder.encode(`${eventText}\n\n`));
    return undefined;
  }
  // Parse the data payload (assume JSON; non-JSON falls through unchanged).
  const json = dataParts.join('\n');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json);
  } catch {
    controller.enqueue(encoder.encode(`${eventText}\n\n`));
    return undefined;
  }
  const next = transformer(parsed, ctx);
  if (next === null) return null; // dropped
  const reSerialized = `data: ${JSON.stringify(next)}`;
  controller.enqueue(encoder.encode(`${reSerialized}\n\n`));
  void terminated;
  void otherLines;
  return undefined;
}
