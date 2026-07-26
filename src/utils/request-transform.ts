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

/** Splits a path into (field, roleFilter | null, isMessages). */
function parsePath(path: string): {
  isTopLevel: boolean;
  isMessages: boolean;
  field: string;
  roleFilter: string | null;
} {
  // messages[].field  or  messages[role=X].field
  const msgMatch = path.match(/^messages\[(?:role=(\w+))?\]\.(.+)$/);
  if (msgMatch) {
    return { isTopLevel: false, isMessages: true, roleFilter: msgMatch[1] ?? null, field: msgMatch[2] };
  }
  // top-level single segment (no dots, no brackets)
  return { isTopLevel: true, isMessages: false, roleFilter: null, field: path };
}

function applyOpToBody(op: TransformOp, body: Record<string, unknown>): void {
  const parsed = parsePath(op.path);

  if (parsed.isTopLevel) {
    applyOpToObject(op, body, parsed.field);
    return;
  }

  if (parsed.isMessages && Array.isArray(body.messages)) {
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
