/**
 * Unit tests for the request-transform engine.
 *
 * Run with:
 *   npx tsx --test tests/unit/request-transform.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runHook, buildEventTransformer, applyAfterUpstream, type HookContext, type HookBodyPayload } from '../../src/utils/request-transform.js';
import type { TransformSet, ModelRouteConfig } from '../../src/utils/config-loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoute(transforms: TransformSet[]): ModelRouteConfig {
  return {
    targetUrl: 'https://example.com',
    upstreamMode: 'openai-completions',
    transforms,
  };
}

function makeCtx(transforms: TransformSet[], hook: HookContext['hook'] = 'before_upstream'): HookContext {
  return {
    hook,
    route: makeRoute(transforms),
    upstreamMode: 'openai-completions',
    clientModel: 'test-model',
    requestId: 'req-1',
    streaming: false,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
  };
}

function payload(body: Record<string, unknown>, headers: Record<string, string> = {}): HookBodyPayload {
  return { body, headers };
}

// ---------------------------------------------------------------------------
// Tier-1: rename
// ---------------------------------------------------------------------------

describe('Tier-1 op: rename (top-level)', () => {
  const set: TransformSet = {
    name: 'rename_test',
    schema: 'openai-completions',
    before_upstream: {
      ops: [{ op: 'rename', path: 'max_tokens', to: 'max_completion_tokens' }],
    },
  };

  it('renames the field and removes the old one', () => {
    const result = runHook('before_upstream', payload({ max_tokens: 1000 }), makeCtx([set]));
    assert.equal(result.body['max_completion_tokens'], 1000);
    assert.equal('max_tokens' in result.body, false);
  });

  it('is a no-op when the field is absent', () => {
    const result = runHook('before_upstream', payload({ temperature: 0.7 }), makeCtx([set]));
    assert.equal('max_completion_tokens' in result.body, false);
    assert.equal(result.body['temperature'], 0.7);
  });
});

// ---------------------------------------------------------------------------
// Tier-1: set / default
// ---------------------------------------------------------------------------

describe('Tier-1 op: set and default', () => {
  const setOp: TransformSet = {
    name: 'set_test',
    schema: 'openai-completions',
    before_upstream: {
      ops: [{ op: 'set', path: 'temperature', value: 0.5 }],
    },
  };

  it('set forces a value even when already present', () => {
    const result = runHook('before_upstream', payload({ temperature: 1.0 }), makeCtx([setOp]));
    assert.equal(result.body['temperature'], 0.5);
  });

  const defaultOp: TransformSet = {
    name: 'default_test',
    schema: 'openai-completions',
    before_upstream: {
      ops: [{ op: 'default', path: 'temperature', value: 0.5 }],
    },
  };

  it('default sets the value only when absent', () => {
    const result = runHook('before_upstream', payload({}), makeCtx([defaultOp]));
    assert.equal(result.body['temperature'], 0.5);
  });

  it('default leaves the value if already set', () => {
    const result = runHook('before_upstream', payload({ temperature: 1.0 }), makeCtx([defaultOp]));
    assert.equal(result.body['temperature'], 1.0);
  });
});

// ---------------------------------------------------------------------------
// Tier-1: remove
// ---------------------------------------------------------------------------

describe('Tier-1 op: remove', () => {
  const set: TransformSet = {
    name: 'remove_test',
    schema: 'openai-completions',
    before_upstream: {
      ops: [{ op: 'remove', path: 'output_config' }],
    },
  };

  it('removes the field', () => {
    const result = runHook('before_upstream', payload({ output_config: { effort: 'high' }, model: 'x' }), makeCtx([set]));
    assert.equal('output_config' in result.body, false);
    assert.equal(result.body['model'], 'x');
  });

  it('is a no-op when field absent', () => {
    const result = runHook('before_upstream', payload({ model: 'x' }), makeCtx([set]));
    assert.equal(result.body['model'], 'x');
  });
});

// ---------------------------------------------------------------------------
// Tier-1: map_value
// ---------------------------------------------------------------------------

describe('Tier-1 op: map_value', () => {
  const set: TransformSet = {
    name: 'map_test',
    schema: 'openai-completions',
    before_upstream: {
      ops: [{
        op: 'map_value',
        path: 'messages[role=assistant].content',
        when_sibling: 'tool_calls',
        from: '',
        to: null,
      }],
    },
  };

  it('replaces "" with null on assistant messages that have tool_calls', () => {
    const body = {
      messages: [
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeCtx([set]));
    const msg = (result.body.messages as Record<string, unknown>[])[0];
    assert.equal(msg.content, null);
  });

  it('does not replace "" on assistant messages without tool_calls (when_sibling guard)', () => {
    const body = {
      messages: [
        { role: 'assistant', content: '' },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeCtx([set]));
    const msg = (result.body.messages as Record<string, unknown>[])[0];
    assert.equal(msg.content, '');
  });

  it('does not affect other roles', () => {
    const body = {
      messages: [
        { role: 'user', content: '', tool_calls: [{}] },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeCtx([set]));
    const msg = (result.body.messages as Record<string, unknown>[])[0];
    assert.equal(msg.content, '');
  });

  it('applies to all matching messages', () => {
    const body = {
      messages: [
        { role: 'assistant', content: '', tool_calls: [{}] },
        { role: 'assistant', content: 'hello', tool_calls: [{}] },
        { role: 'assistant', content: '', tool_calls: [{}] },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeCtx([set]));
    const msgs = result.body.messages as Record<string, unknown>[];
    assert.equal(msgs[0].content, null);
    assert.equal(msgs[1].content, 'hello');
    assert.equal(msgs[2].content, null);
  });
});

// ---------------------------------------------------------------------------
// Tier-2 built-in: lowercase_tool_schema_types
// ---------------------------------------------------------------------------

describe('Tier-2 builtin: lowercase_tool_schema_types', () => {
  const set: TransformSet = {
    name: 'lc_schema',
    schema: 'openai-completions',
    endpoint_readin: { builtins: ['lowercase_tool_schema_types'] },
  };

  it('lowercases type fields in tool parameters', () => {
    const body = {
      tools: [{
        function: {
          name: 'search',
          parameters: { type: 'OBJECT', properties: { q: { type: 'STRING' } } },
        },
      }],
    };
    const result = runHook('endpoint_readin', payload(body), makeCtx([set], 'endpoint_readin'));
    const params = ((result.body.tools as any)[0]).function.parameters;
    assert.equal(params.type, 'object');
    assert.equal(params.properties.q.type, 'string');
  });

  it('handles anthropic input_schema shape', () => {
    const body = {
      tools: [{
        input_schema: { type: 'OBJECT', properties: { n: { type: 'INTEGER' } } },
      }],
    };
    const result = runHook('endpoint_readin', payload(body), makeCtx([set], 'endpoint_readin'));
    const schema = ((result.body.tools as any)[0]).input_schema;
    assert.equal(schema.type, 'object');
    assert.equal(schema.properties.n.type, 'integer');
  });

  it('is a no-op when tools is absent', () => {
    const body = { model: 'x' };
    const result = runHook('endpoint_readin', payload(body), makeCtx([set], 'endpoint_readin'));
    assert.equal(result.body['model'], 'x');
  });
});

// ---------------------------------------------------------------------------
// Tier-2 built-in: recover_tool_message_name
// ---------------------------------------------------------------------------

describe('Tier-2 builtin: recover_tool_message_name', () => {
  const set: TransformSet = {
    name: 'recover_name',
    schema: 'openai-completions',
    before_upstream: { builtins: ['recover_tool_message_name'] },
  };

  it('fills missing tool message name from prior assistant tool_calls', () => {
    const body = {
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'result' },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeCtx([set]));
    const msgs = result.body.messages as Record<string, unknown>[];
    assert.equal(msgs[1].name, 'search');
  });

  it('does not overwrite existing name', () => {
    const body = {
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '' } }] },
        { role: 'tool', tool_call_id: 'c1', name: 'already', content: 'result' },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeCtx([set]));
    const msgs = result.body.messages as Record<string, unknown>[];
    assert.equal(msgs[1].name, 'already');
  });
});

// ---------------------------------------------------------------------------
// Header transforms
// ---------------------------------------------------------------------------

describe('header transforms', () => {
  const set: TransformSet = {
    name: 'hdr_test',
    schema: 'openai-completions',
    endpoint_writeout: {
      headers: { set: { 'x-proxy': 'v3' }, remove: ['openai-organization'] },
    },
  };

  it('sets and removes headers', () => {
    const result = runHook(
      'endpoint_writeout',
      payload({}, { 'openai-organization': 'org-1', 'content-type': 'application/json' }),
      makeCtx([set], 'endpoint_writeout'),
    );
    assert.equal(result.headers['x-proxy'], 'v3');
    assert.equal('openai-organization' in result.headers, false);
    assert.equal(result.headers['content-type'], 'application/json');
  });
});

// ---------------------------------------------------------------------------
// Multiple transform sets, fold order
// ---------------------------------------------------------------------------

describe('multiple transform sets fold left-to-right', () => {
  it('later set sees result of earlier set (rename then map_value)', () => {
    // Set A renames foo → bar. Set B removes bar.
    const setA: TransformSet = {
      name: 'a',
      schema: 'openai-completions',
      before_upstream: { ops: [{ op: 'rename', path: 'max_tokens', to: 'max_completion_tokens' }] },
    };
    const setB: TransformSet = {
      name: 'b',
      schema: 'openai-completions',
      before_upstream: { ops: [{ op: 'remove', path: 'max_completion_tokens' }] },
    };
    const result = runHook('before_upstream', payload({ max_tokens: 100 }), makeCtx([setA, setB]));
    assert.equal('max_tokens' in result.body, false);
    assert.equal('max_completion_tokens' in result.body, false);
  });
});

// ---------------------------------------------------------------------------
// No-op fast path
// ---------------------------------------------------------------------------

describe('runHook fast paths', () => {
  it('returns payload unchanged when no transforms', () => {
    const route = makeRoute([]);
    const ctx = makeCtx([]);
    ctx.route = route;
    const p = payload({ model: 'x' });
    const result = runHook('before_upstream', p, ctx);
    assert.equal(result, p);
  });
});

// ---------------------------------------------------------------------------
// buildEventTransformer
// ---------------------------------------------------------------------------

describe('buildEventTransformer', () => {
  it('returns null when no transforms declare the hook', () => {
    const set: TransformSet = {
      name: 'no_writeout',
      schema: 'openai-completions',
      before_upstream: { ops: [{ op: 'remove', path: 'output_config' }] },
    };
    const ctx = makeCtx([set], 'endpoint_writeout');
    assert.equal(buildEventTransformer('endpoint_writeout', ctx), null);
  });

  it('returns a transformer when transforms declare the hook', () => {
    const set: TransformSet = {
      name: 'has_writeout',
      schema: 'openai-completions',
      endpoint_writeout: { ops: [{ op: 'remove', path: 'model' }] },
    };
    const ctx = makeCtx([set], 'endpoint_writeout');
    const xf = buildEventTransformer('endpoint_writeout', ctx);
    assert.ok(xf !== null);
    const result = xf!({ model: 'x', id: '1' }, ctx);
    assert.ok(result !== null);
    assert.equal('model' in result!, false);
    assert.equal(result!['id'], '1');
  });
});

// ---------------------------------------------------------------------------
// applyAfterUpstream
// ---------------------------------------------------------------------------

function makeAfterCtx(transforms: TransformSet[]): HookContext {
  return {
    hook: 'after_upstream',
    route: makeRoute(transforms),
    upstreamMode: 'openai-completions',
    clientModel: 'test-model',
    requestId: 'req-1',
    streaming: false,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
  };
}

function makeJsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('applyAfterUpstream', () => {
  it('fast-path: returns the same Response object when no transforms are declared', async () => {
    const set: TransformSet = {
      name: 'no_after',
      schema: 'openai-completions',
      before_upstream: { ops: [{ op: 'remove', path: 'max_tokens' }] },
    };
    const ctx = makeAfterCtx([set]);
    const original = makeJsonResponse({ id: '1', model: 'x' });
    const result = await applyAfterUpstream(original, ctx);
    assert.equal(result, original, 'should return the exact same Response reference');
  });

  it('fast-path: returns the same Response when route has no transforms array', async () => {
    const ctx = makeAfterCtx([]);
    const original = makeJsonResponse({ id: '1' });
    const result = await applyAfterUpstream(original, ctx);
    assert.equal(result, original);
  });

  it('active-path: applies ops to JSON body and returns new Response', async () => {
    const set: TransformSet = {
      name: 'strip_model',
      schema: 'openai-completions',
      after_upstream: { ops: [{ op: 'remove', path: 'model' }] },
    };
    const ctx = makeAfterCtx([set]);
    const original = makeJsonResponse({ id: '1', model: 'x', choices: [] });
    const result = await applyAfterUpstream(original, ctx);
    assert.notEqual(result, original, 'should return a new Response');
    const body = await result.json() as Record<string, unknown>;
    assert.equal('model' in body, false, 'model should be removed');
    assert.equal(body['id'], '1');
  });

  it('active-path: renames a field in the response body', async () => {
    const set: TransformSet = {
      name: 'rename_field',
      schema: 'openai-completions',
      after_upstream: { ops: [{ op: 'rename', path: 'foo', to: 'bar' }] },
    };
    const ctx = makeAfterCtx([set]);
    const original = makeJsonResponse({ foo: 42 });
    const result = await applyAfterUpstream(original, ctx);
    const body = await result.json() as Record<string, unknown>;
    assert.equal('foo' in body, false);
    assert.equal(body['bar'], 42);
  });

  it('active-path: preserves response status code', async () => {
    const set: TransformSet = {
      name: 'strip_model',
      schema: 'openai-completions',
      after_upstream: { ops: [{ op: 'remove', path: 'model' }] },
    };
    const ctx = makeAfterCtx([set]);
    const original = makeJsonResponse({ model: 'x' }, 201);
    const result = await applyAfterUpstream(original, ctx);
    assert.equal(result.status, 201);
  });

  it('non-JSON passthrough: returns reconstructed Response with original text when body is not JSON', async () => {
    const set: TransformSet = {
      name: 'strip_model',
      schema: 'openai-completions',
      after_upstream: { ops: [{ op: 'remove', path: 'model' }] },
    };
    const ctx = makeAfterCtx([set]);
    const sseBody = 'data: {"type":"message_start"}\n\ndata: [DONE]\n\n';
    const original = new Response(sseBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    const result = await applyAfterUpstream(original, ctx);
    // A new Response is returned but the body text is preserved unchanged
    const text = await result.text();
    assert.equal(text, sseBody);
    assert.equal(result.status, 200);
  });
});
