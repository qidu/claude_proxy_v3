/**
 * Unit tests for config-loader.ts
 *
 * Covers: parseHumanTokenLimit, formatTokenLimit, normalizeHookAlias,
 * parseSimpleToml (sections + edge cases), getModelConfig (exact/wildcard/
 * default inheritance), getModelRouteConfig (composite + default fallback),
 * validateProxyConfig, validateTransformSet, getModelNamesInConfig,
 * findAliasNameConflicts, stripConflictingAliases,
 * findSelfReferencingCompositeTargets, getConfiguredModelIds,
 * getAllowedHostsFromConfig.
 *
 * Run with: npx tsx --test tests/unit/config-loader.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseHumanTokenLimit,
  formatTokenLimit,
  normalizeHookAlias,
  parseSimpleToml,
  validateTransformSet,
  validateAllTransforms,
  validateProxyConfig,
  getModelConfig,
  getModelRouteConfig,
  getModelNamesInConfig,
  findAliasNameConflicts,
  stripConflictingAliases,
  findSelfReferencingCompositeTargets,
  stripSelfReferencingCompositeTargets,
  getConfiguredModelIds,
  getAllowedHostsFromConfig,
  getCompositeAliasMode,
  resolveScheduleTarget,
  isScheduleAlias,
  type ProxyConfig,
  type TransformSet,
} from '../../src/utils/config-loader.js';

// ---------------------------------------------------------------------------
// parseHumanTokenLimit
// ---------------------------------------------------------------------------

describe('parseHumanTokenLimit', () => {
  it('parses raw number with duration', () => {
    assert.deepEqual(parseHumanTokenLimit('50000 1d'), { num: 50000, duration: '1d' });
  });

  it('parses k suffix', () => {
    assert.deepEqual(parseHumanTokenLimit('50k 1h'), { num: 50000, duration: '1h' });
  });

  it('parses M suffix (case-insensitive)', () => {
    assert.deepEqual(parseHumanTokenLimit('1.5M 1w'), { num: 1_500_000, duration: '1w' });
    assert.deepEqual(parseHumanTokenLimit('1.5m 1w'), { num: 1_500_000, duration: '1w' });
  });

  it('parses B and T suffixes', () => {
    assert.deepEqual(parseHumanTokenLimit('2B 1m'), { num: 2_000_000_000, duration: '1m' });
    assert.deepEqual(parseHumanTokenLimit('1T 1d'), { num: 1_000_000_000_000, duration: '1d' });
  });

  it('returns null for empty input', () => {
    assert.equal(parseHumanTokenLimit(''), null);
    assert.equal(parseHumanTokenLimit('   '), null);
  });

  it('returns null for missing duration', () => {
    assert.equal(parseHumanTokenLimit('50000'), null);
  });

  it('returns null for invalid duration unit', () => {
    assert.equal(parseHumanTokenLimit('50k 1y'), null);
  });

  it('returns null for negative numbers', () => {
    assert.equal(parseHumanTokenLimit('-50k 1d'), null);
  });

  it('accepts all four valid durations', () => {
    for (const d of ['1h', '1d', '1w', '1m'] as const) {
      const r = parseHumanTokenLimit(`100 ${d}`);
      assert.equal(r?.duration, d);
    }
  });
});

// ---------------------------------------------------------------------------
// formatTokenLimit
// ---------------------------------------------------------------------------

describe('formatTokenLimit', () => {
  it('formats values under 1000 as raw number', () => {
    assert.equal(formatTokenLimit(500), '500');
    assert.equal(formatTokenLimit(0), '0');
  });

  it('formats thousands with K', () => {
    assert.equal(formatTokenLimit(1000), '1K');
    assert.equal(formatTokenLimit(50000), '50K');
  });

  it('strips trailing .0', () => {
    assert.equal(formatTokenLimit(1000), '1K'); // not "1.0K"
  });

  it('formats millions with M', () => {
    assert.equal(formatTokenLimit(1_500_000), '1.5M');
  });

  it('formats billions and trillions', () => {
    assert.equal(formatTokenLimit(2_500_000_000), '2.5B');
    assert.equal(formatTokenLimit(1_000_000_000_000), '1T');
  });
});

// ---------------------------------------------------------------------------
// normalizeHookAlias
// ---------------------------------------------------------------------------

describe('normalizeHookAlias', () => {
  it('maps legacy endpoint_readin to request_ingress', () => {
    assert.equal(normalizeHookAlias('endpoint_readin'), 'request_ingress');
  });

  it('maps legacy endpoint_writeout to response_egress', () => {
    assert.equal(normalizeHookAlias('endpoint_writeout'), 'response_egress');
  });

  it('passes canonical names through unchanged', () => {
    assert.equal(normalizeHookAlias('request_ingress'), 'request_ingress');
    assert.equal(normalizeHookAlias('before_upstream'), 'before_upstream');
  });

  it('passes unknown names through unchanged', () => {
    assert.equal(normalizeHookAlias('not_a_hook'), 'not_a_hook');
  });
});

// ---------------------------------------------------------------------------
// parseSimpleToml
// ---------------------------------------------------------------------------

describe('parseSimpleToml', () => {
  it('parses [general] section with string and boolean values', () => {
    const cfg = parseSimpleToml(`
      [general]
      auth_url = "https://auth.example.com"
      auth_with_model = "true"
      global_token_limit = "50k 1d"
    `);
    assert.equal(cfg.general?.auth_url, 'https://auth.example.com');
    assert.equal(cfg.general?.auth_with_model, true);
    assert.equal(cfg.general?.global_token_limit, '50k 1d');
  });

  it('parses [default_upstream] section', () => {
    const cfg = parseSimpleToml(`
      [default_upstream]
      upstream_mode = "openai-completions"
      default_base_url = "https://api.openai.com"
      default_api_key = "sk-key"
    `);
    assert.equal(cfg.default_upstream?.upstream_mode, 'openai-completions');
    assert.equal(cfg.default_upstream?.default_base_url, 'https://api.openai.com');
    assert.equal(cfg.default_upstream?.default_api_key, 'sk-key');
  });

  it('coerces budget_to_effort_* values to numbers', () => {
    const cfg = parseSimpleToml(`
      [default_upstream]
      budget_to_effort_low = "4000"
      budget_to_effort_high = "20000"
    `);
    assert.equal(cfg.default_upstream?.budget_to_effort_low, 4000);
    assert.equal(cfg.default_upstream?.budget_to_effort_high, 20000);
  });

  it('parses [models.gemini] category with inline-table entries', () => {
    const cfg = parseSimpleToml(`
      [models.gemini]
      base_url = "https://generativelanguage.googleapis.com"
      api_key = "gem-key"
      "gem-2.5-flash" = {target = "gemini-2.5-flash", base_url = "", api_key = "", mode = "gemini-generatecontent"}
    `);
    const cat = cfg.models?.gemini as Record<string, unknown>;
    assert.equal(cat.base_url, 'https://generativelanguage.googleapis.com');
    const entry = cat['gem-2.5-flash'] as string[];
    assert.deepEqual(entry, ['gemini-2.5-flash', '', '', 'gemini-generatecontent']);
  });

  it('parses array-form model entry (3 elements)', () => {
    const cfg = parseSimpleToml(`
      [models.claude]
      base_url = "https://api.anthropic.com"
      "claude-sonnet" = ["claude-sonnet-4", "", ""]
    `);
    const entry = (cfg.models?.claude as Record<string, unknown>)['claude-sonnet'];
    assert.deepEqual(entry, ['claude-sonnet-4', '', '']);
  });

  it('defaults missing target to the alias key in inline table', () => {
    const cfg = parseSimpleToml(`
      [models.claude]
      base_url = "https://api.anthropic.com"
      "claude-sonnet" = {base_url = "", api_key = ""}
    `);
    const entry = (cfg.models?.claude as Record<string, unknown>)['claude-sonnet'] as string[];
    assert.equal(entry[0], 'claude-sonnet'); // target defaults to alias key
  });

  it('parses inline-table entry with transforms CSV (5 elements)', () => {
    const cfg = parseSimpleToml(`
      [models.claude]
      "claude-sonnet" = {base_url = "https://x", api_key = "k", mode = "", transforms = "t1,t2"}
    `);
    const entry = (cfg.models?.claude as Record<string, unknown>)['claude-sonnet'] as string[];
    assert.equal(entry.length, 5);
    assert.equal(entry[4], 't1,t2');
  });

  it('accepts upstream_mode / url / key aliases in inline-table entries', () => {
    const cfg = parseSimpleToml(`
      [models.free]
      upstream_mode = "openai-completions"
      base_url = "https://default.example"
      api_key = "default-key"
      "glm-5.2-a" = {target = "glm-5.2", upstream_mode = "anthropic-messages", url = "https://open.bigmodel.cn/api/anthropic", key = "bigmodel-key"}
    `);
    const entry = (cfg.models?.free as Record<string, unknown>)['glm-5.2-a'] as string[];
    assert.deepEqual(entry, ['glm-5.2', 'https://open.bigmodel.cn/api/anthropic', 'bigmodel-key', 'anthropic-messages']);
  });

  it('canonical upstream_mode/base_url/api_key win over short aliases when both present', () => {
    const cfg = parseSimpleToml(`
      [models.free]
      "m" = {upstream_mode = "anthropic-messages", mode = "openai-completions", base_url = "https://canonical", url = "https://short", api_key = "ck", key = "sk"}
    `);
    const entry = (cfg.models?.free as Record<string, unknown>)['m'] as string[];
    assert.equal(entry[1], 'https://canonical');
    assert.equal(entry[2], 'ck');
    assert.equal(entry[3], 'anthropic-messages');
  });


  it('parses [composite] section with target config objects', () => {
    const cfg = parseSimpleToml(`
      [composite]
      "alias-1" = {"model-a" = {share = 2}, "model-b" = {share = 1, fallback = 1}}
    `);
    const targets = cfg.composite?.['alias-1'] as Record<string, unknown>;
    assert.deepEqual(targets['model-a'], { share: 2 });
    assert.deepEqual(targets['model-b'], { share: 1, fallback: 1 });
  });

  it('parses composite with token_limit object', () => {
    const cfg = parseSimpleToml(`
      [composite]
      "alias-1" = {token_limit = {num = 50000, duration = "1d"}, "model-a" = {share = 1}}
    `);
    const targets = cfg.composite?.['alias-1'] as any;
    assert.deepEqual(targets.token_limit, { num: 50000, duration: '1d' });
  });

  it('parses composite with primary target', () => {
    const cfg = parseSimpleToml(`
      [composite]
      "alias-1" = {"model-a" = {primary = true}, "model-b" = {fallback = 1}}
    `);
    const targets = cfg.composite?.['alias-1'] as any;
    assert.equal(targets['model-a'].primary, true);
  });

  it('parses [schedule] section with time windows', () => {
    const cfg = parseSimpleToml(`
      [schedule]
      "saver" = {"day-model" = [{from = 9, to = 17, days = "weekday"}], "night-model" = []}
    `);
    const sched = cfg.schedule?.saver as any;
    assert.deepEqual(sched['day-model'], [{ from: 9, to: 17, days: 'weekday' }]);
    assert.deepEqual(sched['night-model'], []);
  });

  it('parses [schedule] with array days', () => {
    const cfg = parseSimpleToml(`
      [schedule]
      "x" = {"t" = [{from = 0, to = 24, days = ["mon", "wed"]}]}
    `);
    const sched = cfg.schedule?.x as any;
    assert.deepEqual(sched.t[0].days, ['mon', 'wed']);
  });

  it('parses [transforms.<name>] section with ops and builtins', () => {
    const cfg = parseSimpleToml(`
      [transforms.myset]
      schema = "anthropic-messages"
      before_upstream.ops = [{op="rename", path="model", to="gpt-4"}]
      before_upstream.builtins = ["lowercase_tool_schema_types"]
    `);
    const set = cfg.transforms?.myset as TransformSet;
    assert.equal(set.schema, 'anthropic-messages');
    assert.equal(set.before_upstream?.ops?.length, 1);
    assert.deepEqual(set.before_upstream?.ops?.[0], { op: 'rename', path: 'model', to: 'gpt-4' });
    assert.deepEqual(set.before_upstream?.builtins, ['lowercase_tool_schema_types']);
  });

  it('accepts legacy hook aliases in transforms', () => {
    const cfg = parseSimpleToml(`
      [transforms.legacy]
      schema = "anthropic-messages"
      endpoint_readin.builtins = ["filter_anthropic_beta"]
    `);
    const set = cfg.transforms?.legacy as TransformSet;
    assert.ok(set.request_ingress, 'legacy endpoint_readin should normalize to request_ingress');
    assert.deepEqual(set.request_ingress?.builtins, ['filter_anthropic_beta']);
  });

  it('parses anthropic_beta_map with empty-string→null mapping', () => {
    const cfg = parseSimpleToml(`
      [transforms.betamap]
      schema = "anthropic-messages"
      anthropic_beta_map = {"header-a" = "mapped", "header-b" = ""}
    `);
    const set = cfg.transforms?.betamap as TransformSet;
    assert.deepEqual(set.anthropic_beta_map, { 'header-a': 'mapped', 'header-b': null });
  });

  it('ignores comments and blank lines', () => {
    const cfg = parseSimpleToml(`
      # a comment

      [general]
      # inline-ish
      auth_url = "https://x"  # trailing comment
    `);
    assert.equal(cfg.general?.auth_url, 'https://x');
  });

  it('handles inline comment after value containing # (no preceding space is preserved)', () => {
    const cfg = parseSimpleToml(`
      [default_upstream]
      default_api_key = "abc#def"
    `);
    // '#' with no preceding space stays in the value
    assert.equal(cfg.default_upstream?.default_api_key, 'abc#def');
  });

  it('parses [privacy_filter] numeric and string fields', () => {
    const cfg = parseSimpleToml(`
      [privacy_filter]
      filter_mode = "local"
      entropy_threshold = 4.5
      max_chars = 1000
      timeout_ms = 500
    `);
    assert.equal(cfg.privacy_filter?.filter_mode, 'local');
    assert.equal(cfg.privacy_filter?.entropy_threshold, 4.5);
    assert.equal(cfg.privacy_filter?.max_chars, 1000);
    assert.equal(cfg.privacy_filter?.timeout_ms, 500);
  });

  it('parses [privacy_filter] whitelist_add array', () => {
    const cfg = parseSimpleToml(`
      [privacy_filter]
      whitelist_add = ["deadbeef", "cafef00d"]
    `);
    assert.deepEqual(cfg.privacy_filter?.whitelist_add, ['deadbeef', 'cafef00d']);
  });

  it('parses [dashboard] and [model_usage] sections', () => {
    const cfg = parseSimpleToml(`
      [dashboard]
      api_key = "dash-key"

      [model_usage]
      record_url = "https://record.example.com"
    `);
    assert.equal(cfg.dashboard?.api_key, 'dash-key');
    assert.equal(cfg.model_usage?.record_url, 'https://record.example.com');
  });

  it('folds multi-line array values into one logical line', () => {
    const cfg = parseSimpleToml(`
      [transforms.ml]
      schema = "anthropic-messages"
      before_upstream.ops = [
        {op="set", path="model", value="x"},
        {op="remove", path="top_k"}
      ]
    `);
    const set = cfg.transforms?.ml as TransformSet;
    assert.equal(set.before_upstream?.ops?.length, 2);
  });

  it('parses transform_defaults section', () => {
    const cfg = parseSimpleToml(`
      [transform_defaults]
      openai-completions = ["set_a", "set_b"]
    `);
    assert.deepEqual(cfg.transform_defaults?.['openai-completions'], ['set_a', 'set_b']);
  });

  it('attaches _validationErrors on the returned config', () => {
    const cfg = parseSimpleToml(`[general]`) as any;
    assert.ok(Array.isArray(cfg._validationErrors));
  });

  it('returns empty config for empty input (with validation metadata attached)', () => {
    const cfg = parseSimpleToml('') as any;
    assert.equal(cfg.general, undefined);
    assert.equal(cfg.models, undefined);
    assert.equal(cfg.composite, undefined);
    assert.ok(Array.isArray(cfg._validationErrors));
    assert.ok(Array.isArray(cfg._validationWarnings));
  });
});

// ---------------------------------------------------------------------------
// validateTransformSet
// ---------------------------------------------------------------------------

describe('validateTransformSet', () => {
  it('returns no errors for a valid set with legal path', () => {
    const set: TransformSet = {
      name: 's',
      schema: 'anthropic-messages',
      before_upstream: { ops: [{ op: 'rename', path: 'model', to: 'x' }] },
    };
    const errs = validateTransformSet('s', set);
    assert.equal(errs.length, 0);
  });

  it('rejects unknown schema', () => {
    const set = { name: 's', schema: 'not-a-schema' } as unknown as TransformSet;
    const errs = validateTransformSet('s', set);
    assert.ok(errs.some(e => e.message.includes('unknown schema')));
  });

  it('rejects op path not in the schema path set', () => {
    const set: TransformSet = {
      name: 's',
      schema: 'anthropic-messages',
      before_upstream: { ops: [{ op: 'set', path: 'not_a_real_field', value: 'x' }] },
    };
    const errs = validateTransformSet('s', set);
    assert.ok(errs.some(e => e.message.includes('unknown path')));
  });

  it('rejects engine-unwalkable nested path', () => {
    const set: TransformSet = {
      name: 's',
      schema: 'openai-completions',
      before_upstream: { ops: [{ op: 'set', path: '$response.choices[].message.content', value: 'x' }] },
    };
    const errs = validateTransformSet('s', set);
    assert.ok(errs.some(e => e.message.includes('cannot walk')));
  });

  it('rejects unknown builtin', () => {
    const set: TransformSet = {
      name: 's',
      schema: 'anthropic-messages',
      before_upstream: { builtins: ['not_a_builtin' as any] },
    };
    const errs = validateTransformSet('s', set);
    assert.ok(errs.some(e => e.message.includes('unknown builtin')));
  });

  it('accepts valid builtin names', () => {
    const set: TransformSet = {
      name: 's',
      schema: 'anthropic-messages',
      request_ingress: { builtins: ['lowercase_tool_schema_types', 'filter_anthropic_beta'] },
    };
    assert.equal(validateTransformSet('s', set).length, 0);
  });

  it('validates anthropic_beta_map values', () => {
    const set = {
      name: 's',
      schema: 'anthropic-messages',
      anthropic_beta_map: { ok: 'mapped', bad: 42 as unknown as string },
    } as unknown as TransformSet;
    const errs = validateTransformSet('s', set);
    assert.ok(errs.some(e => e.message.includes('must be a string or null')));
  });

  it('accepts null values in anthropic_beta_map (drop entry)', () => {
    const set: TransformSet = {
      name: 's',
      schema: 'anthropic-messages',
      anthropic_beta_map: { 'drop-me': null },
    };
    assert.equal(validateTransformSet('s', set).length, 0);
  });
});

// ---------------------------------------------------------------------------
// validateAllTransforms
// ---------------------------------------------------------------------------

describe('validateAllTransforms', () => {
  it('flags transform_defaults referencing undefined set', () => {
    const cfg: ProxyConfig = {
      transform_defaults: { 'openai-completions': ['missing-set'] },
    };
    const errs = validateAllTransforms(cfg);
    assert.ok(errs.some(e => e.set === 'transform_defaults.openai-completions' && e.message.includes('undefined')));
  });

  it('flags per-model entry transform referencing undefined set', () => {
    const cfg: ProxyConfig = {
      transforms: {},
      models: {
        claude: {
          'm1': ['m1', '', '', '', 'missing-set'],
        } as any,
      },
    };
    const errs = validateAllTransforms(cfg);
    assert.ok(errs.some(e => e.set === 'models.claude.m1'));
  });

  it('passes when all references resolve', () => {
    const cfg: ProxyConfig = {
      transforms: { s1: { name: 's1', schema: 'anthropic-messages' } },
      transform_defaults: { 'anthropic-messages': ['s1'] },
    };
    assert.equal(validateAllTransforms(cfg).length, 0);
  });
});

// ---------------------------------------------------------------------------
// getModelConfig
// ---------------------------------------------------------------------------

describe('getModelConfig', () => {
  it('exact match wins across categories', () => {
    const cfg: ProxyConfig = {
      models: {
        claude: { 'm1': ['c-target', '', ''] } as any,
        gemini: { 'm1': ['g-target', '', ''] } as any,
      },
    };
    // First-declared wins (claude iterated first)
    const r = getModelConfig(cfg, 'm1');
    assert.equal(r?.category, 'claude');
    assert.deepEqual(r?.entry, ['c-target', '', '']);
  });

  it('prefix wildcard matches in provider category', () => {
    const cfg: ProxyConfig = {
      models: {
        claude: { 'claude-*': ['claude-alias', '', ''] } as any,
      },
    };
    const r = getModelConfig(cfg, 'claude-sonnet-4-6');
    assert.equal(r?.category, 'claude');
    assert.deepEqual(r?.entry, ['claude-alias', '', '']);
  });

  it('catch-all * in models.default matches any unmatched name', () => {
    const cfg: ProxyConfig = {
      models: {
        default: { '*': ['*', '', ''] } as any,
      },
    };
    const r = getModelConfig(cfg, 'anything-at-all');
    assert.equal(r?.category, 'default');
  });

  it('returns undefined when nothing matches and no default.*', () => {
    const cfg: ProxyConfig = {
      models: { claude: { 'm1': ['x', '', ''] } as any },
    };
    assert.equal(getModelConfig(cfg, 'nope'), undefined);
  });

  it('skips array-typed category (models.list)', () => {
    const cfg: ProxyConfig = {
      models: {
        list: [['x', 'url', 'key']] as any,
        claude: { 'm1': ['c', '', ''] } as any,
      },
    };
    const r = getModelConfig(cfg, 'm1');
    assert.equal(r?.category, 'claude');
  });

  it('exact match in default category overrides catch-all', () => {
    const cfg: ProxyConfig = {
      models: {
        default: {
          '*': ['star-target', '', ''],
          'specific': ['specific-target', '', ''],
        } as any,
      },
    };
    assert.equal(getModelConfig(cfg, 'specific')?.entry[0], 'specific-target');
    assert.equal(getModelConfig(cfg, 'other')?.entry[0], 'star-target');
  });
});

// ---------------------------------------------------------------------------
// getModelRouteConfig — composite, direct, default fallback
// ---------------------------------------------------------------------------

describe('getModelRouteConfig', () => {
  it('resolves a direct model entry inheriting category base_url', () => {
    const cfg: ProxyConfig = {
      default_upstream: { upstream_mode: 'openai-completions' },
      models: {
        claude: {
          base_url: 'https://api.anthropic.com',
          api_key: 'sk-cat',
          'm1': ['m1-alias', '', ''],
        } as any,
      },
    };
    const r = getModelRouteConfig('m1', cfg);
    assert.equal(r.targetUrl, 'https://api.anthropic.com');
    assert.equal(r.apiKey, 'sk-cat');
    assert.equal(r.upstreamMode, 'openai-completions');
    assert.equal(r.modelAlias, 'm1-alias');
  });

  it('uses per-entry overrides when provided', () => {
    const cfg: ProxyConfig = {
      models: {
        claude: {
          base_url: 'https://cat.default',
          'm1': ['m1-alias', 'https://override', 'sk-override', 'anthropic-messages'],
        } as any,
      },
    };
    const r = getModelRouteConfig('m1', cfg);
    assert.equal(r.targetUrl, 'https://override');
    assert.equal(r.apiKey, 'sk-override');
    assert.equal(r.upstreamMode, 'anthropic-messages');
  });

  it('falls back to default model route when no entry matches', () => {
    const cfg: ProxyConfig = {
      default_upstream: { upstream_mode: 'openai-completions', default_base_url: 'https://def' },
      models: { default: { '*': ['*', '', ''] } as any },
    };
    const r = getModelRouteConfig('unknown', cfg);
    assert.equal(r.targetUrl, 'https://def');
  });

  it('parses "x-api-key: sk-..." format api_key', () => {
    const cfg: ProxyConfig = {
      models: {
        claude: {
          base_url: 'https://x',
          'm1': ['m1', '', 'x-api-key: sk-extracted'],
        } as any,
      },
    };
    const r = getModelRouteConfig('m1', cfg);
    assert.equal(r.apiKey, 'sk-extracted');
  });

  it('resolves composite alias to a target route', () => {
    const cfg: ProxyConfig = {
      models: {
        claude: {
          base_url: 'https://x',
          'm1': ['m1', '', ''],
          'm2': ['m2', '', ''],
        } as any,
      },
      composite: { 'alias-1': { 'm1': { share: 1 }, 'm2': { share: 1 } } },
    };
    const r = getModelRouteConfig('alias-1', cfg);
    // Weighted — should resolve to one of m1/m2
    assert.ok(r.modelAlias === 'm1' || r.modelAlias === 'm2');
  });

  it('resolves schedule alias to its target', () => {
    const cfg: ProxyConfig = {
      models: {
        claude: {
          base_url: 'https://x',
          'day-model': ['day-target', '', ''],
        } as any,
      },
      schedule: { 'saver': { 'day-model': [{ from: 0, to: 24 }] } },
    };
    const r = getModelRouteConfig('saver', cfg);
    assert.equal(r.modelAlias, 'day-target');
  });

  it('throws on a routing cycle between composite aliases', () => {
    const cfg: ProxyConfig = {
      models: { claude: { base_url: 'https://x', 'm1': ['m1', '', ''] } as any },
      composite: {
        'a': { 'b': { share: 1 } },
        'b': { 'a': { share: 1 } },
      },
    };
    assert.throws(() => getModelRouteConfig('a', cfg), /Routing cycle detected/);
  });

  it('prefix wildcard model entry substitutes the matched name', () => {
    const cfg: ProxyConfig = {
      models: {
        claude: {
          base_url: 'https://x',
          'claude-*': ['claude-*', '', ''],
        } as any,
      },
    };
    const r = getModelRouteConfig('claude-sonnet-4-6', cfg);
    // Wildcard entry resolves prefix + suffix; alias should reflect the requested name
    assert.ok(r.modelAlias?.startsWith('claude'));
  });
});

// ---------------------------------------------------------------------------
// validateProxyConfig
// ---------------------------------------------------------------------------

describe('validateProxyConfig', () => {
  it('flags model entry with invalid length (2 elements)', () => {
    const cfg: ProxyConfig = {
      models: { claude: { base_url: 'https://x', 'm1': ['a', 'b'] } as any },
    };
    const r = validateProxyConfig(cfg);
    assert.ok(r.errors.some(e => e.path === 'models.claude.m1'));
    assert.equal(r.valid, false);
  });

  it('flags 1-element entry with no category base_url', () => {
    const cfg: ProxyConfig = {
      models: { claude: { 'm1': ['target'] } as any },
    };
    const r = validateProxyConfig(cfg);
    assert.ok(r.errors.some(e => e.path === 'models.claude.m1' && e.message.includes('base_url')));
  });

  it('accepts 1-element entry when category base_url is set', () => {
    const cfg: ProxyConfig = {
      models: { claude: { base_url: 'https://x', 'm1': ['target'] } as any },
    };
    const r = validateProxyConfig(cfg);
    assert.ok(!r.errors.some(e => e.path === 'models.claude.m1'));
  });

  it('flags non-array model value', () => {
    const cfg: ProxyConfig = {
      models: { claude: { base_url: 'https://x', 'm1': 'not-an-array' } as any },
    };
    const r = validateProxyConfig(cfg);
    assert.ok(r.errors.some(e => e.path === 'models.claude.m1' && e.message.includes('must be')));
  });

  it('flags composite self-reference', () => {
    const cfg: ProxyConfig = {
      models: { claude: { base_url: 'https://x', 'm1': ['m1', '', ''] } as any },
      composite: { 'selfref': { 'selfref': { share: 1 } } },
    };
    const r = validateProxyConfig(cfg);
    assert.ok(r.errors.some(e => e.path === 'composite.selfref.selfref'));
  });

  it('warns when schedule has no fallback target', () => {
    const cfg: ProxyConfig = {
      models: { claude: { base_url: 'https://x', 'm1': ['m1', '', ''] } as any },
      schedule: { 'saver': { 'm1': [{ from: 9, to: 17 }] } },
    };
    const r = validateProxyConfig(cfg);
    assert.ok(r.warnings.some(w => w.path === 'schedule.saver' && w.message.includes('fallback')));
  });

  it('flags invalid base_url (bad protocol)', () => {
    const cfg: ProxyConfig = {
      default_upstream: { default_base_url: 'ftp://bad' },
    };
    const r = validateProxyConfig(cfg);
    assert.ok(r.errors.some(e => e.path === 'default_upstream.default_base_url'));
  });

  it('accepts sdk:// base_url (rewritten to https at request time)', () => {
    const cfg: ProxyConfig = {
      models: { free: { base_url: 'https://x', llama3: ['llama3.1-8B', 'sdk://chatjimmy.ai/api', '-'] } as any },
    };
    const r = validateProxyConfig(cfg);
    assert.ok(!r.errors.some(e => e.path.includes('llama3') && e.message.includes('sdk')));
  });

  it('flags unparseable base_url', () => {
    const cfg: ProxyConfig = {
      default_upstream: { default_base_url: 'not a url at all' },
    };
    const r = validateProxyConfig(cfg);
    assert.ok(r.errors.some(e => e.message.includes('not a valid URL')));
  });

  it('flags schedule window with from >= to', () => {
    const cfg: ProxyConfig = {
      models: { claude: { base_url: 'https://x', 'm1': ['m1', '', ''] } as any },
      schedule: { 'saver': { 'm1': [{ from: 17, to: 9 }], 'fb': [] } },
    };
    const r = validateProxyConfig(cfg);
    assert.ok(r.errors.some(e => e.message.includes('from must be less than to')));
  });

  it('flags alias/model name conflict', () => {
    const cfg: ProxyConfig = {
      models: { claude: { base_url: 'https://x', 'shared-name': ['x', '', ''] } as any },
      composite: { 'shared-name': { 'x': { share: 1 } } },
    };
    const r = validateProxyConfig(cfg);
    assert.ok(r.errors.some(e => e.path === 'composite.shared-name' && e.message.includes('conflicts')));
  });

  it('passes a clean config with valid: true', () => {
    const cfg: ProxyConfig = {
      default_upstream: { default_base_url: 'https://api.x.com', upstream_mode: 'openai-completions' },
      models: { claude: { base_url: 'https://api.x.com', 'm1': ['m1', '', ''] } as any },
    };
    const r = validateProxyConfig(cfg);
    assert.equal(r.valid, true, `expected valid, got errors: ${JSON.stringify(r.errors)}`);
  });
});

// ---------------------------------------------------------------------------
// getModelNamesInConfig
// ---------------------------------------------------------------------------

describe('getModelNamesInConfig', () => {
  it('collects concrete model keys, skipping reserved + internal', () => {
    const cfg: ProxyConfig = {
      models: {
        claude: { base_url: 'https://x', api_key: 'k', 'm1': ['m1', '', ''], 'm2': ['m2', '', ''], _comment: 'skip' } as any,
        gemini: { base_url: 'https://y', 'g1': ['g1', '', ''] } as any,
        list: [['x', 'url', 'key']] as any,
      },
    };
    const names = getModelNamesInConfig(cfg);
    assert.ok(names.has('m1'));
    assert.ok(names.has('m2'));
    assert.ok(names.has('g1'));
    assert.ok(!names.has('base_url'));
    assert.ok(!names.has('api_key'));
    assert.ok(!names.has('_comment'));
    assert.equal(names.size, 3);
  });

  it('returns empty set when no models defined', () => {
    assert.equal(getModelNamesInConfig({}).size, 0);
  });
});

// ---------------------------------------------------------------------------
// findAliasNameConflicts + stripConflictingAliases
// ---------------------------------------------------------------------------

describe('findAliasNameConflicts / stripConflictingAliases', () => {
  it('detects composite + schedule conflicts', () => {
    const cfg: ProxyConfig = {
      models: { claude: { base_url: 'https://x', 'collide': ['c', '', ''] } as any },
      composite: { 'collide': { 'x': { share: 1 } }, 'safe': { 'x': { share: 1 } } },
      schedule: { 'collide': { 'x': [] } },
    };
    const c = findAliasNameConflicts(cfg);
    assert.deepEqual(c.composite, ['collide']);
    assert.deepEqual(c.schedule, ['collide']);
  });

  it('stripConflictingAliases removes the colliding alias from in-memory config', () => {
    const cfg: ProxyConfig = {
      models: { claude: { base_url: 'https://x', 'collide': ['c', '', ''] } as any },
      composite: { 'collide': { 'x': { share: 1 } }, 'safe': { 'x': { share: 1 } } },
    };
    const { config: stripped, stripped: info } = stripConflictingAliases(cfg);
    assert.deepEqual(info.composite, ['collide']);
    assert.ok(stripped.composite?.safe);
    assert.equal(stripped.composite?.collide, undefined);
  });

  it('no-op when there are no conflicts', () => {
    const cfg: ProxyConfig = {
      models: { claude: { base_url: 'https://x', 'm1': ['m1', '', ''] } as any },
      composite: { 'alias-1': { 'm1': { share: 1 } } },
    };
    const { config: stripped, stripped: info } = stripConflictingAliases(cfg);
    assert.equal(info.composite.length, 0);
    assert.equal(stripped, cfg); // same reference
  });

  it('deletes composite key entirely when all aliases conflict', () => {
    const cfg: ProxyConfig = {
      models: { claude: { base_url: 'https://x', 'collide': ['c', '', ''] } as any },
      composite: { 'collide': { 'x': { share: 1 } } },
    };
    const { config: stripped } = stripConflictingAliases(cfg);
    assert.equal(stripped.composite, undefined);
  });
});

// ---------------------------------------------------------------------------
// findSelfReferencingCompositeTargets / stripSelfReferencingCompositeTargets
// ---------------------------------------------------------------------------

describe('findSelfReferencingCompositeTargets / strip', () => {
  it('detects alias listing itself as a target', () => {
    const cfg: ProxyConfig = {
      models: { claude: { base_url: 'https://x', 'm1': ['m1', '', ''] } as any },
      composite: { 'for-claw': { 'for-claw': { share: 1 }, 'm1': { share: 1 } } },
    };
    const r = findSelfReferencingCompositeTargets(cfg);
    assert.deepEqual(r['for-claw'], ['for-claw']);
  });

  it('strip removes only the bad target, keeps the alias', () => {
    const cfg: ProxyConfig = {
      models: { claude: { base_url: 'https://x', 'm1': ['m1', '', ''] } as any },
      composite: { 'for-claw': { 'for-claw': { share: 1 }, 'm1': { share: 1 } } },
    };
    const { config: stripped } = stripSelfReferencingCompositeTargets(cfg);
    assert.ok(stripped.composite?.['for-claw']);
    assert.equal(stripped.composite?.['for-claw']?.['for-claw'], undefined);
    assert.ok(stripped.composite?.['for-claw']?.['m1']);
  });

  it('no-op when there are no self-references', () => {
    const cfg: ProxyConfig = {
      composite: { 'a': { 'b': { share: 1 } } },
    };
    const { config: stripped, stripped: s } = stripSelfReferencingCompositeTargets(cfg);
    assert.equal(Object.keys(s).length, 0);
    assert.equal(stripped, cfg);
  });
});

// ---------------------------------------------------------------------------
// getConfiguredModelIds
// ---------------------------------------------------------------------------

describe('getConfiguredModelIds', () => {
  it('includes model names + composite + schedule aliases', () => {
    const cfg: ProxyConfig = {
      models: {
        claude: { base_url: 'https://x', 'm1': ['m1', '', ''] } as any,
        gemini: { base_url: 'https://y', 'g1': ['g1', '', ''] } as any,
      },
      composite: { 'cmp-1': { 'm1': { share: 1 } } },
      schedule: { 'sched-1': { 'm1': [] } },
    };
    const ids = new Set(getConfiguredModelIds(cfg));
    assert.ok(ids.has('m1'));
    assert.ok(ids.has('g1'));
    assert.ok(ids.has('cmp-1'));
    assert.ok(ids.has('sched-1'));
  });

  it('excludes reserved category keys', () => {
    const cfg: ProxyConfig = {
      models: { claude: { base_url: 'https://x', 'm1': ['m1', '', ''] } as any },
    };
    const ids = new Set(getConfiguredModelIds(cfg));
    assert.ok(!ids.has('base_url'));
    assert.ok(!ids.has('upstream_mode'));
  });

  it('returns [] when no models defined', () => {
    assert.deepEqual(getConfiguredModelIds({}), []);
  });
});

// ---------------------------------------------------------------------------
// getAllowedHostsFromConfig
// ---------------------------------------------------------------------------

describe('getAllowedHostsFromConfig', () => {
  it('collects hosts from default_upstream + category base_url + per-entry override', () => {
    const cfg: ProxyConfig = {
      default_upstream: { default_base_url: 'https://api.default.com' },
      models: {
        claude: {
          base_url: 'https://api.cat.com',
          'm1': ['m1', 'https://api.override.com:8443', 'k'],
        } as any,
      },
    };
    const hosts = new Set(getAllowedHostsFromConfig(cfg));
    assert.ok(hosts.has('api.default.com'));
    assert.ok(hosts.has('api.cat.com'));
    assert.ok(hosts.has('api.override.com:8443'));
  });

  it('skips invalid URLs silently', () => {
    const cfg: ProxyConfig = {
      default_upstream: { default_base_url: 'not-a-url' },
      models: { claude: { base_url: 'https://ok.com', 'm1': ['m1', 'also-bad', ''] } as any },
    };
    const hosts = getAllowedHostsFromConfig(cfg);
    assert.ok(hosts.includes('ok.com'));
    assert.ok(!hosts.some(h => h.includes('not-a-url') || h.includes('also-bad')));
  });
});

// ---------------------------------------------------------------------------
// getCompositeAliasMode
// ---------------------------------------------------------------------------

describe('getCompositeAliasMode', () => {
  it('returns coordinator when coord > 0 present', () => {
    const cfg: ProxyConfig = {
      models: { claude: { base_url: 'https://x', 'p': ['p', '', ''], 'e': ['e', '', ''] } as any },
      composite: { 'c': { 'p': { coord: 1, role: 'planner' }, 'e': { coord: 1, role: 'executor' } } },
    };
    assert.equal(getCompositeAliasMode('c', cfg), 'coordinator');
  });

  it('returns fusion when role=panel/judge/synth present', () => {
    const cfg: ProxyConfig = {
      models: { claude: { base_url: 'https://x', 'a': ['a', '', ''], 'b': ['b', '', ''] } as any },
      composite: { 'f': { 'a': { role: 'panel' }, 'b': { role: 'synth' } } },
    };
    assert.equal(getCompositeAliasMode('f', cfg), 'fusion');
  });

  it('returns fallback when primary/fallback set', () => {
    const cfg: ProxyConfig = {
      models: { claude: { base_url: 'https://x', 'a': ['a', '', ''], 'b': ['b', '', ''] } as any },
      composite: { 'fb': { 'a': { primary: true }, 'b': { fallback: 1 } } },
    };
    assert.equal(getCompositeAliasMode('fb', cfg), 'fallback');
  });

  it('returns share otherwise', () => {
    const cfg: ProxyConfig = {
      models: { claude: { base_url: 'https://x', 'a': ['a', '', ''], 'b': ['b', '', ''] } as any },
      composite: { 'sh': { 'a': { share: 1 }, 'b': { share: 1 } } },
    };
    assert.equal(getCompositeAliasMode('sh', cfg), 'share');
  });

  it('returns undefined for non-alias', () => {
    assert.equal(getCompositeAliasMode('nope', {}), undefined);
  });
});

// ---------------------------------------------------------------------------
// resolveScheduleTarget / isScheduleAlias
// ---------------------------------------------------------------------------

describe('resolveScheduleTarget / isScheduleAlias', () => {
  it('isScheduleAlias detects schedule aliases', () => {
    const cfg: ProxyConfig = { schedule: { 'saver': {} } };
    assert.equal(isScheduleAlias('saver', cfg), true);
    assert.equal(isScheduleAlias('other', cfg), false);
  });

  it('returns undefined for non-schedule alias', () => {
    assert.equal(resolveScheduleTarget('nope', {}), undefined);
  });

  it('returns matching window target by hour', () => {
    const cfg: ProxyConfig = {
      schedule: { 'saver': { 'day': [{ from: 9, to: 17 }], 'night': [] } },
    };
    const noon = new Date('2026-01-01T12:00:00');
    assert.equal(resolveScheduleTarget('saver', cfg, noon), 'day');
  });

  it('falls back to empty-window target when no window matches', () => {
    const cfg: ProxyConfig = {
      schedule: { 'saver': { 'day': [{ from: 9, to: 17 }], 'fallback': [] } },
    };
    const midnight = new Date('2026-01-01T00:00:00');
    assert.equal(resolveScheduleTarget('saver', cfg, midnight), 'fallback');
  });

  it('weekday filter matches Mon-Fri', () => {
    const cfg: ProxyConfig = {
      schedule: { 'saver': { 'wd': [{ from: 0, to: 24, days: 'weekday' }] } },
    };
    // 2026-01-05 is a Monday
    const monday = new Date('2026-01-05T10:00:00');
    const sunday = new Date('2026-01-04T10:00:00');
    assert.equal(resolveScheduleTarget('saver', cfg, monday), 'wd');
    assert.equal(resolveScheduleTarget('saver', cfg, sunday), undefined);
  });

  it('weekend filter matches Sat/Sun', () => {
    const cfg: ProxyConfig = {
      schedule: { 'saver': { 'we': [{ from: 0, to: 24, days: 'weekend' }] } },
    };
    const saturday = new Date('2026-01-03T10:00:00'); // Sat
    const monday = new Date('2026-01-05T10:00:00');
    assert.equal(resolveScheduleTarget('saver', cfg, saturday), 'we');
    assert.equal(resolveScheduleTarget('saver', cfg, monday), undefined);
  });
});
