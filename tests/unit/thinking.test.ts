/**
 * Unit tests for the pure thinking-config helpers in src/utils/thinking.ts.
 *
 * These functions are branch-heavy and previously had no direct unit coverage
 * (they were only exercised indirectly via converters). Here we test the
 * normalization, validation, budget, and merge logic directly.
 *
 * Run with: npx tsx --test tests/unit/thinking.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeOpenAIToClaudeThinking,
  normalizeThinkingConfig,
  validateThinkingBudget,
  getEffectiveThinkingBudget,
  isThinkingEnabled,
  createDefaultThinkingConfig,
  adjustThinkingBudget,
  estimateThinkingTokens,
  mergeThinkingConfigs,
  createThinkingBlock,
  validateThinkingForTokenCounting,
} from '../../src/utils/thinking.js';

// ---------------------------------------------------------------------------
// normalizeOpenAIToClaudeThinking
// ---------------------------------------------------------------------------

describe('normalizeOpenAIToClaudeThinking', () => {
  it('converts { enabled: true, budget_tokens } to Claude enabled shape', () => {
    assert.deepEqual(
      normalizeOpenAIToClaudeThinking({ enabled: true, budget_tokens: 2000 }),
      { type: 'enabled', budget_tokens: 2000 },
    );
  });

  it('converts { enabled: false } to Claude disabled shape (drops budget)', () => {
    assert.deepEqual(
      normalizeOpenAIToClaudeThinking({ enabled: false, budget_tokens: 2000 }),
      { type: 'disabled', budget_tokens: 2000 },
    );
  });

  it('omits budget_tokens when not provided', () => {
    assert.deepEqual(
      normalizeOpenAIToClaudeThinking({ enabled: true }),
      { type: 'enabled' },
    );
  });

  it('returns undefined when already in Claude format (has type)', () => {
    assert.equal(
      normalizeOpenAIToClaudeThinking({ type: 'enabled', budget_tokens: 100 }),
      undefined,
    );
  });

  it('returns undefined for non-object / empty input', () => {
    assert.equal(normalizeOpenAIToClaudeThinking(null), undefined);
    assert.equal(normalizeOpenAIToClaudeThinking(undefined), undefined);
    assert.equal(normalizeOpenAIToClaudeThinking('enabled'), undefined);
    assert.equal(normalizeOpenAIToClaudeThinking(42), undefined);
  });

  it('returns undefined when enabled is not a boolean', () => {
    assert.equal(normalizeOpenAIToClaudeThinking({ enabled: 'yes' }), undefined);
    assert.equal(normalizeOpenAIToClaudeThinking({ budget_tokens: 100 }), undefined);
  });
});

// ---------------------------------------------------------------------------
// normalizeThinkingConfig
// ---------------------------------------------------------------------------

describe('normalizeThinkingConfig', () => {
  it('maps boolean true to enabled, preserving budget_tokens', () => {
    assert.deepEqual(
      normalizeThinkingConfig({ type: true, budget_tokens: 500 }),
      { type: 'enabled', budget_tokens: 500 },
    );
  });

  it('maps boolean true with no budget to enabled with undefined budget', () => {
    assert.deepEqual(
      normalizeThinkingConfig({ type: true }),
      { type: 'enabled', budget_tokens: undefined },
    );
  });

  it('maps boolean false to disabled', () => {
    assert.deepEqual(normalizeThinkingConfig({ type: false }), { type: 'disabled' });
  });

  it('passes through string "disabled"', () => {
    assert.deepEqual(normalizeThinkingConfig({ type: 'disabled' }), { type: 'disabled' });
  });

  it('passes through "enabled" with budget_tokens', () => {
    assert.deepEqual(
      normalizeThinkingConfig({ type: 'enabled', budget_tokens: 1234 }),
      { type: 'enabled', budget_tokens: 1234 },
    );
  });

  it('passes through "adaptive" with budget_tokens', () => {
    assert.deepEqual(
      normalizeThinkingConfig({ type: 'adaptive', budget_tokens: 800 }),
      { type: 'adaptive', budget_tokens: 800 },
    );
  });

  it('returns undefined when type is missing', () => {
    assert.equal(normalizeThinkingConfig({ budget_tokens: 100 }), undefined);
  });

  it('returns undefined for unknown string type', () => {
    assert.equal(normalizeThinkingConfig({ type: 'bogus' }), undefined);
  });

  it('returns undefined for non-object / empty input', () => {
    assert.equal(normalizeThinkingConfig(null), undefined);
    assert.equal(normalizeThinkingConfig(undefined), undefined);
    assert.equal(normalizeThinkingConfig('enabled'), undefined);
  });
});

// ---------------------------------------------------------------------------
// validateThinkingBudget
// ---------------------------------------------------------------------------

describe('validateThinkingBudget', () => {
  it('does nothing for undefined / disabled config', () => {
    assert.doesNotThrow(() => validateThinkingBudget(undefined));
    assert.doesNotThrow(() => validateThinkingBudget({ type: 'disabled' }));
  });

  it('accepts a valid enabled budget', () => {
    assert.doesNotThrow(() => validateThinkingBudget({ type: 'enabled', budget_tokens: 5000 }));
  });

  it('throws when enabled has no budget_tokens', () => {
    assert.throws(
      () => validateThinkingBudget({ type: 'enabled' } as any),
      /budget_tokens is required when type is "enabled"/,
    );
  });

  it('allows adaptive without budget_tokens', () => {
    assert.doesNotThrow(() => validateThinkingBudget({ type: 'adaptive' } as any));
  });

  it('throws when budget_tokens < 1', () => {
    assert.throws(
      () => validateThinkingBudget({ type: 'enabled', budget_tokens: 0 }),
      /must be at least 1/,
    );
  });

  it('throws when budget_tokens > 100000', () => {
    assert.throws(
      () => validateThinkingBudget({ type: 'enabled', budget_tokens: 100001 }),
      /cannot exceed 100,000/,
    );
  });

  it('accepts boundary budgets 1 and 100000', () => {
    assert.doesNotThrow(() => validateThinkingBudget({ type: 'enabled', budget_tokens: 1 }));
    assert.doesNotThrow(() => validateThinkingBudget({ type: 'enabled', budget_tokens: 100000 }));
  });

  it('throws when budget_tokens exceeds max_tokens', () => {
    assert.throws(
      () => validateThinkingBudget({ type: 'enabled', budget_tokens: 5000 }, 4000),
      /cannot exceed max_tokens/,
    );
  });

  it('accepts budget_tokens equal to max_tokens', () => {
    assert.doesNotThrow(() => validateThinkingBudget({ type: 'enabled', budget_tokens: 4000 }, 4000));
  });
});

// ---------------------------------------------------------------------------
// getEffectiveThinkingBudget
// ---------------------------------------------------------------------------

describe('getEffectiveThinkingBudget', () => {
  it('returns budget_tokens for enabled', () => {
    assert.equal(getEffectiveThinkingBudget({ type: 'enabled', budget_tokens: 3000 }), 3000);
  });

  it('returns undefined for disabled', () => {
    assert.equal(getEffectiveThinkingBudget({ type: 'disabled' }), undefined);
  });

  it('returns undefined for adaptive (only enabled returns a budget)', () => {
    assert.equal(getEffectiveThinkingBudget({ type: 'adaptive', budget_tokens: 3000 }), undefined);
  });

  it('returns undefined for undefined input', () => {
    assert.equal(getEffectiveThinkingBudget(undefined), undefined);
  });
});

// ---------------------------------------------------------------------------
// isThinkingEnabled
// ---------------------------------------------------------------------------

describe('isThinkingEnabled', () => {
  it('true for enabled', () => {
    assert.equal(isThinkingEnabled({ type: 'enabled', budget_tokens: 1 }), true);
  });

  it('true for boolean true (normalized to enabled)', () => {
    assert.equal(isThinkingEnabled({ type: true } as any), true);
  });

  it('false for adaptive, disabled, and undefined', () => {
    assert.equal(isThinkingEnabled({ type: 'adaptive', budget_tokens: 1 }), false);
    assert.equal(isThinkingEnabled({ type: 'disabled' }), false);
    assert.equal(isThinkingEnabled(undefined), false);
  });
});

// ---------------------------------------------------------------------------
// createDefaultThinkingConfig
// ---------------------------------------------------------------------------

describe('createDefaultThinkingConfig', () => {
  it('defaults to disabled', () => {
    assert.deepEqual(createDefaultThinkingConfig(), { type: 'disabled' });
  });

  it('enabled uses default budget 10000', () => {
    assert.deepEqual(createDefaultThinkingConfig(true), { type: 'enabled', budget_tokens: 10000 });
  });

  it('enabled respects a custom budget', () => {
    assert.deepEqual(createDefaultThinkingConfig(true, 2048), { type: 'enabled', budget_tokens: 2048 });
  });
});

// ---------------------------------------------------------------------------
// adjustThinkingBudget
// ---------------------------------------------------------------------------

describe('adjustThinkingBudget', () => {
  it('keeps budget when it fits within available tokens', () => {
    assert.deepEqual(
      adjustThinkingBudget({ type: 'enabled', budget_tokens: 1000 }, 5000),
      { type: 'enabled', budget_tokens: 1000 },
    );
  });

  it('clamps budget down to available tokens when it overflows but meets minimum', () => {
    assert.deepEqual(
      adjustThinkingBudget({ type: 'enabled', budget_tokens: 8000 }, 3000),
      { type: 'enabled', budget_tokens: 3000 },
    );
  });

  it('disables thinking when available tokens are below minimum', () => {
    assert.deepEqual(
      adjustThinkingBudget({ type: 'enabled', budget_tokens: 8000 }, 50),
      { type: 'disabled' },
    );
  });

  it('respects a custom minimum budget threshold', () => {
    // available (150) >= min (100) but < current budget -> clamp
    assert.deepEqual(
      adjustThinkingBudget({ type: 'enabled', budget_tokens: 8000 }, 150, 100),
      { type: 'enabled', budget_tokens: 150 },
    );
    // available (80) < min (100) -> disable
    assert.deepEqual(
      adjustThinkingBudget({ type: 'enabled', budget_tokens: 8000 }, 80, 100),
      { type: 'disabled' },
    );
  });

  it('returns undefined for disabled / undefined input', () => {
    assert.equal(adjustThinkingBudget({ type: 'disabled' }, 5000), undefined);
    assert.equal(adjustThinkingBudget(undefined, 5000), undefined);
  });
});

// ---------------------------------------------------------------------------
// estimateThinkingTokens
// ---------------------------------------------------------------------------

describe('estimateThinkingTokens', () => {
  it('returns 0 for disabled / undefined', () => {
    assert.equal(estimateThinkingTokens({ type: 'disabled' }), 0);
    assert.equal(estimateThinkingTokens(undefined), 0);
  });

  it('returns 0 for adaptive (only enabled is estimated)', () => {
    assert.equal(estimateThinkingTokens({ type: 'adaptive', budget_tokens: 5000 }), 0);
  });

  it('caps the estimate at the default when budget is high', () => {
    assert.equal(estimateThinkingTokens({ type: 'enabled', budget_tokens: 50000 }), 1000);
  });

  it('uses the budget when below the default cap', () => {
    assert.equal(estimateThinkingTokens({ type: 'enabled', budget_tokens: 300 }), 300);
  });

  it('respects a custom default estimate', () => {
    assert.equal(estimateThinkingTokens({ type: 'enabled', budget_tokens: 50000 }, 2000), 2000);
    assert.equal(estimateThinkingTokens({ type: 'enabled', budget_tokens: 500 }, 2000), 500);
  });

  it('falls back to the default estimate when enabled has no budget', () => {
    assert.equal(estimateThinkingTokens({ type: 'enabled' } as any, 1500), 1500);
  });
});

// ---------------------------------------------------------------------------
// mergeThinkingConfigs
// ---------------------------------------------------------------------------

describe('mergeThinkingConfigs', () => {
  it('prefers primary when both are defined', () => {
    assert.deepEqual(
      mergeThinkingConfigs(
        { type: 'enabled', budget_tokens: 100 },
        { type: 'enabled', budget_tokens: 999 },
      ),
      { type: 'enabled', budget_tokens: 100 },
    );
  });

  it('falls back to secondary when primary is undefined', () => {
    assert.deepEqual(
      mergeThinkingConfigs(undefined, { type: 'disabled' }),
      { type: 'disabled' },
    );
  });

  it('falls back to secondary when primary normalizes to undefined (invalid)', () => {
    assert.deepEqual(
      mergeThinkingConfigs({ type: 'bogus' } as any, { type: 'enabled', budget_tokens: 5 }),
      { type: 'enabled', budget_tokens: 5 },
    );
  });

  it('returns undefined when both are undefined', () => {
    assert.equal(mergeThinkingConfigs(undefined, undefined), undefined);
  });
});

// ---------------------------------------------------------------------------
// createThinkingBlock
// ---------------------------------------------------------------------------

describe('createThinkingBlock', () => {
  it('builds a thinking_delta block with default index 0', () => {
    assert.deepEqual(createThinkingBlock('pondering'), {
      type: 'thinking_delta',
      delta: { type: 'thinking_delta', text: 'pondering', index: 0 },
    });
  });

  it('uses the provided index', () => {
    assert.deepEqual(createThinkingBlock('step', 3), {
      type: 'thinking_delta',
      delta: { type: 'thinking_delta', text: 'step', index: 3 },
    });
  });
});

// ---------------------------------------------------------------------------
// validateThinkingForTokenCounting
// ---------------------------------------------------------------------------

describe('validateThinkingForTokenCounting', () => {
  it('does nothing for undefined / disabled / adaptive', () => {
    assert.doesNotThrow(() => validateThinkingForTokenCounting(undefined));
    assert.doesNotThrow(() => validateThinkingForTokenCounting({ type: 'disabled' }));
    assert.doesNotThrow(() => validateThinkingForTokenCounting({ type: 'adaptive', budget_tokens: 5 }));
  });

  it('allows enabled with budget 0 (treated as unset)', () => {
    assert.doesNotThrow(() => validateThinkingForTokenCounting({ type: 'enabled', budget_tokens: 0 }));
  });

  it('allows enabled with no budget_tokens (defaults to 0)', () => {
    assert.doesNotThrow(() => validateThinkingForTokenCounting({ type: 'enabled' } as any));
  });

  it('throws when enabled budget exceeds 100000', () => {
    assert.throws(
      () => validateThinkingForTokenCounting({ type: 'enabled', budget_tokens: 100001 }),
      /cannot exceed 100,000 for token counting/,
    );
  });

  it('accepts a valid enabled budget', () => {
    assert.doesNotThrow(() => validateThinkingForTokenCounting({ type: 'enabled', budget_tokens: 5000 }));
  });
});
