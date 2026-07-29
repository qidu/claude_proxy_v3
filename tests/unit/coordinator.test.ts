/**
 * Unit tests for the coordinator composite mode.
 *
 * Run with:
 *   npx tsx --test tests/unit/coordinator.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectCoordinatorStage } from '../../src/utils/coordinator.js';
import {
  getCompositeAliasMode,
  resolveCoordinatorPlan,
  COORDINATOR_DEFAULT_TRIGGER_TOOLS,
} from '../../src/utils/config-loader.js';
import type { ProxyConfig } from '../../src/utils/config-loader.js';

// ---------------------------------------------------------------------------
// Minimal ProxyConfig factory
// ---------------------------------------------------------------------------

function makeConfig(composite: Record<string, unknown>): ProxyConfig {
  return {
    models: {
      free: { base_url: 'https://api.example.com', api_key: 'key-free' },
      default: { base_url: 'https://api.example.com', api_key: 'key-default' },
    },
    composite: composite as ProxyConfig['composite'],
    schedule: {},
    transforms: {},
  } as unknown as ProxyConfig;
}

// ---------------------------------------------------------------------------
// detectCoordinatorStage
// ---------------------------------------------------------------------------

describe('detectCoordinatorStage', () => {
  it('returns planning when messages is empty', () => {
    assert.equal(detectCoordinatorStage([], new Set(['ExitPlanMode'])), 'planning');
  });

  it('returns planning when no tool_use blocks exist', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'thinking...' }] },
    ];
    assert.equal(detectCoordinatorStage(messages, new Set(['ExitPlanMode'])), 'planning');
  });

  it('returns executing when trigger tool appears in last assistant turn', () => {
    const messages = [
      { role: 'user', content: [] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'ExitPlanMode', id: '1', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: '' }] },
    ];
    assert.equal(detectCoordinatorStage(messages, new Set(['ExitPlanMode'])), 'executing');
  });

  it('returns executing when Edit appears in trigger set', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', id: '2', input: {} }] },
    ];
    assert.equal(detectCoordinatorStage(messages, new Set(['Edit', 'Write'])), 'executing');
  });

  it('returns planning when tool_use name is NOT in trigger set', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', id: '3', input: {} }] },
    ];
    assert.equal(detectCoordinatorStage(messages, new Set(['ExitPlanMode', 'Edit', 'Write'])), 'planning');
  });

  it('returns executing on any tool_use when triggerTools is null', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', id: '4', input: {} }] },
    ];
    assert.equal(detectCoordinatorStage(messages, null), 'executing');
  });

  it('ignores tool_use in user turns', () => {
    const messages = [
      // tool_result in a user turn — should not trigger
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: '5', content: '' }] },
    ];
    assert.equal(detectCoordinatorStage(messages, new Set(['ExitPlanMode'])), 'planning');
  });

  it('only scans up to tailLimit assistant messages', () => {
    // Trigger tool is in an old assistant turn beyond tailLimit
    const messages: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push({ role: 'user', content: [] });
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', name: 'ExitPlanMode', id: `${i}`, input: {} }] });
    }
    // Recent turns have no trigger
    messages.push({ role: 'user', content: [] });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] });

    // tailLimit=1 → only the last assistant message scanned → no trigger → planning
    assert.equal(detectCoordinatorStage(messages, new Set(['ExitPlanMode']), 1), 'planning');
    // tailLimit=10 → older turns scanned → executing
    assert.equal(detectCoordinatorStage(messages, new Set(['ExitPlanMode']), 10), 'executing');
  });

  it('handles string content (non-array) without throwing', () => {
    const messages = [
      { role: 'assistant', content: 'some text response' },
    ];
    assert.equal(detectCoordinatorStage(messages, new Set(['ExitPlanMode'])), 'planning');
  });
});

// ---------------------------------------------------------------------------
// getCompositeAliasMode — coordinator detection
// ---------------------------------------------------------------------------

describe('getCompositeAliasMode — coordinator', () => {
  it('returns coordinator when any entry has coord > 0', () => {
    const config = makeConfig({
      'smart-coder': {
        'opus': { coord: 1, role: 'planner' },
        'flash': { coord: 1, role: 'executor' },
      },
    });
    assert.equal(getCompositeAliasMode('smart-coder', config), 'coordinator');
  });

  it('returns coordinator before fusion even when fusion entries also present (conflict caught later)', () => {
    const config = makeConfig({
      'mixed': {
        'a': { coord: 1, role: 'planner' },
        'b': { fusion: 1, role: 'panel' },
      },
    });
    // getCompositeAliasMode returns coordinator (conflict is validated in resolveCoordinatorPlan)
    assert.equal(getCompositeAliasMode('mixed', config), 'coordinator');
  });

  it('returns fusion for a fusion alias', () => {
    const config = makeConfig({
      'fuse': {
        'a': { fusion: 1, role: 'panel' },
        'b': { role: 'synth' },
      },
    });
    assert.equal(getCompositeAliasMode('fuse', config), 'fusion');
  });

  it('returns undefined for unknown alias', () => {
    const config = makeConfig({});
    assert.equal(getCompositeAliasMode('unknown', config), undefined);
  });
});

// ---------------------------------------------------------------------------
// resolveCoordinatorPlan
// ---------------------------------------------------------------------------

function baseCoordConfig() {
  return makeConfig({
    'smart-coder': {
      'deepseek-v4-pro':   { coord: 1, role: 'planner' },
      'deepseek-v4-flash': { coord: 1, role: 'executor' },
    },
    'smart-coder-exit-only': {
      'deepseek-v4-pro':   { coord: 1, role: 'planner' },
      'deepseek-v4-flash': { coord: 1, role: 'executor' },
      toolset: ['ExitPlanMode'],
    },
    'smart-coder-any-tool': {
      'deepseek-v4-pro':   { coord: 1, role: 'planner' },
      'deepseek-v4-flash': { coord: 1, role: 'executor' },
      toolset: [],
    },
  });
}

describe('resolveCoordinatorPlan', () => {
  it('returns undefined for non-coordinator alias', () => {
    const config = makeConfig({ 'share-a': { 'x': { share: 50 }, 'y': { share: 50 } } });
    assert.equal(resolveCoordinatorPlan('share-a', config), undefined);
  });

  it('returns undefined for unknown alias', () => {
    assert.equal(resolveCoordinatorPlan('nope', makeConfig({})), undefined);
  });

  it('resolves planner and executor names', () => {
    const plan = resolveCoordinatorPlan('smart-coder', baseCoordConfig());
    assert.ok(plan);
    assert.equal(plan.alias, 'smart-coder');
    assert.equal(plan.plannerName, 'deepseek-v4-pro');
    assert.equal(plan.executorName, 'deepseek-v4-flash');
  });

  it('applies default trigger tools when toolset is absent', () => {
    const plan = resolveCoordinatorPlan('smart-coder', baseCoordConfig());
    assert.ok(plan);
    assert.ok(plan.triggerTools instanceof Set);
    assert.ok(plan.triggerTools.has('ExitPlanMode'));
    assert.ok(plan.triggerTools.has('Edit'));
    assert.deepEqual(plan.triggerTools, new Set(COORDINATOR_DEFAULT_TRIGGER_TOOLS));
  });

  it('applies custom toolset when provided', () => {
    const plan = resolveCoordinatorPlan('smart-coder-exit-only', baseCoordConfig());
    assert.ok(plan);
    assert.ok(plan.triggerTools instanceof Set);
    assert.ok(plan.triggerTools.has('ExitPlanMode'));
    assert.equal(plan.triggerTools.has('Edit'), false);
  });

  it('sets triggerTools to null when toolset is empty array', () => {
    const plan = resolveCoordinatorPlan('smart-coder-any-tool', baseCoordConfig());
    assert.ok(plan);
    assert.equal(plan.triggerTools, null);
  });

  it('throws when planner role is missing', () => {
    const config = makeConfig({
      'bad': { 'a': { coord: 1, role: 'executor' }, 'b': { coord: 1, role: 'executor' } },
    });
    assert.throws(
      () => resolveCoordinatorPlan('bad', config),
      /missing a target with role = "planner"/,
    );
  });

  it('throws when executor role is missing', () => {
    const config = makeConfig({
      'bad': { 'a': { coord: 1, role: 'planner' }, 'b': { coord: 1, role: 'planner' } },
    });
    assert.throws(
      () => resolveCoordinatorPlan('bad', config),
      /missing a target with role = "executor"/,
    );
  });

  it('throws when multiple planners are present', () => {
    const config = makeConfig({
      'bad': {
        'a': { coord: 1, role: 'planner' },
        'b': { coord: 1, role: 'planner' },
        'c': { coord: 1, role: 'executor' },
      },
    });
    assert.throws(
      () => resolveCoordinatorPlan('bad', config),
      /multiple planner targets/,
    );
  });

  it('throws when coord and fusion entries are mixed', () => {
    const config = makeConfig({
      'mixed': {
        'a': { coord: 1, role: 'planner' },
        'b': { coord: 1, role: 'executor' },
        'c': { fusion: 1, role: 'panel' },
      },
    });
    assert.throws(
      () => resolveCoordinatorPlan('mixed', config),
      /mixes coord and fusion/,
    );
  });
});

// ---------------------------------------------------------------------------
// Config parsing round-trip: toolset and coord fields survive sanitize
// ---------------------------------------------------------------------------

describe('coordinator config round-trip', () => {
  it('toolset array is preserved through sanitize (absent → default tools)', () => {
    const plan = resolveCoordinatorPlan('smart-coder', baseCoordConfig());
    assert.ok(plan?.triggerTools instanceof Set);
    assert.ok(plan.triggerTools.has('ExitPlanMode'));
    assert.ok(plan.triggerTools.has('Edit'));
  });

  it('toolset = ["ExitPlanMode"] is preserved (custom set)', () => {
    const plan = resolveCoordinatorPlan('smart-coder-exit-only', baseCoordConfig());
    assert.ok(plan?.triggerTools instanceof Set);
    assert.deepEqual(plan.triggerTools, new Set(['ExitPlanMode']));
  });

  it('toolset = [] is preserved as null (any tool)', () => {
    const plan = resolveCoordinatorPlan('smart-coder-any-tool', baseCoordConfig());
    assert.equal(plan?.triggerTools, null);
  });

  it('coord field survives through resolveCoordinatorPlan (planner/executor detected)', () => {
    const plan = resolveCoordinatorPlan('smart-coder', baseCoordConfig());
    assert.equal(plan?.plannerName, 'deepseek-v4-pro');
    assert.equal(plan?.executorName, 'deepseek-v4-flash');
  });
});
