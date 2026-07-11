/**
 * Claude thinking → OpenAI reasoning_effort Conversion Unit Tests
 *
 * The proxy converts Claude-style `thinking: {type: 'enabled', budget_tokens: N}`
 * into OpenAI `reasoning_effort: 'low'|'medium'|'high'|'max'` on the
 * openai-completions path. The conversion lives in
 * src/converters/claude-to-openai.ts and is wired into the live request
 * path at src/handlers/messages.ts:132-134 and
 * src/converters/claude-to-openai.ts:341-342.
 *
 * This suite exercises the two exported functions directly so the
 * budget→effort mapping is verified independently of upstream availability:
 *   - convertClaudeThinkingToOpenAI (line 136)
 *   - budgetToReasoningEffort       (line 193)
 *
 * Legacy cutoffs (no thresholds configured): 4096 → high, 2048 → medium.
 * Custom thresholds: budget >= high → high; budget >= medium → medium; else low.
 * Special case: budget_to_effort_high === 0 → always high ("force high").
 */

const path = require('path');
const {
  assert,
  runTestSuite,
} = require('../utils/test_helpers');

let convertClaudeThinkingToOpenAI, budgetToReasoningEffort;

async function loadModule() {
  const mod = await import(path.join(process.cwd(), 'dist/converters/claude-to-openai.js'));
  convertClaudeThinkingToOpenAI = mod.convertClaudeThinkingToOpenAI;
  budgetToReasoningEffort = mod.budgetToReasoningEffort;
}

// ---------------------------------------------------------------------------
// TC2901–TC2903: legacy cutoffs (no thresholds) via budgetToReasoningEffort
// ---------------------------------------------------------------------------

async function testLegacyHighBudget() {
  const effort = budgetToReasoningEffort(8192);
  assert(effort === 'high', `expected 'high' for budget 8192, got '${effort}'`);
}

async function testLegacyMediumBudget() {
  const effort = budgetToReasoningEffort(2048);
  assert(effort === 'medium', `expected 'medium' for budget 2048, got '${effort}'`);
}

async function testLegacyLowBudget() {
  const effort = budgetToReasoningEffort(1024);
  assert(effort === 'low', `expected 'low' for budget 1024, got '${effort}'`);
}

// ---------------------------------------------------------------------------
// TC2904: explicit_reasoning_effort overrides thresholds
// ---------------------------------------------------------------------------

async function testExplicitEffortOverrides() {
  const result = convertClaudeThinkingToOpenAI(
    { type: 'enabled', budget_tokens: 8192 },
    { explicit_reasoning_effort: 'max' }
  );
  assert(
    result.reasoning_effort === 'max',
    `expected 'max' from explicit override, got '${result.reasoning_effort}'`
  );
}

// ---------------------------------------------------------------------------
// TC2905: disabled thinking → no reasoning_effort
// ---------------------------------------------------------------------------

async function testDisabledThinkingNoEffort() {
  const result = convertClaudeThinkingToOpenAI({ type: 'disabled' });
  assert(
    result.reasoning_effort === undefined,
    'disabled thinking should not produce reasoning_effort'
  );
  assert(
    result.thinking && result.thinking.enabled === false,
    'disabled thinking should produce thinking.enabled=false'
  );
}

// ---------------------------------------------------------------------------
// TC2906: undefined thinking → empty result
// ---------------------------------------------------------------------------

async function testUndefinedThinkingEmpty() {
  const result = convertClaudeThinkingToOpenAI(undefined);
  assert(
    Object.keys(result).length === 0,
    `undefined thinking should return {}, got ${JSON.stringify(result)}`
  );
}

// ---------------------------------------------------------------------------
// TC2907: custom thresholds
// ---------------------------------------------------------------------------

async function testCustomThresholds() {
  const opts = { budget_to_effort_high: 10000, budget_to_effort_medium: 5000 };
  assert(
    budgetToReasoningEffort(12000, opts) === 'high',
    '12000 >= 10000 should be high'
  );
  assert(
    budgetToReasoningEffort(7000, opts) === 'medium',
    '7000 >= 5000 should be medium'
  );
  assert(
    budgetToReasoningEffort(3000, opts) === 'low',
    '3000 < 5000 should be low'
  );
}

// ---------------------------------------------------------------------------
// TC2908: budget_to_effort_high === 0 → force high
// ---------------------------------------------------------------------------

async function testForceHighSpecialCase() {
  const opts = { budget_to_effort_high: 0 };
  assert(
    budgetToReasoningEffort(100, opts) === 'high',
    'budget_to_effort_high=0 should force high even for small budget'
  );
  assert(
    budgetToReasoningEffort(1, opts) === 'high',
    'budget_to_effort_high=0 should force high for budget=1'
  );
}

// ---------------------------------------------------------------------------
// TC2909: adaptive type behaves like enabled
// ---------------------------------------------------------------------------

async function testAdaptiveLikeEnabled() {
  const result = convertClaudeThinkingToOpenAI(
    { type: 'adaptive', budget_tokens: 8192 },
    { budget_to_effort_high: 4096, budget_to_effort_medium: 2048 }
  );
  assert(
    result.reasoning_effort === 'high',
    `adaptive with budget 8192 should produce 'high', got '${result.reasoning_effort}'`
  );
  assert(
    result.thinking && result.thinking.enabled === true,
    'adaptive should produce thinking.enabled=true'
  );
}

// ---------------------------------------------------------------------------
// TC2910: convertClaudeThinkingToOpenAI with budget but no thresholds
// returns thinking only (no reasoning_effort) — the hasThresholds gate
// at claude-to-openai.ts:161-168 skips the budgetToReasoningEffort call.
// ---------------------------------------------------------------------------

async function testNoThresholdsReturnsThinkingOnly() {
  const result = convertClaudeThinkingToOpenAI(
    { type: 'enabled', budget_tokens: 8192 }
    // no options → no thresholds
  );
  assert(
    result.thinking && result.thinking.enabled === true,
    'should still produce thinking.enabled=true'
  );
  assert(
    result.reasoning_effort === undefined,
    `no thresholds → no reasoning_effort, got '${result.reasoning_effort}'`
  );
}

module.exports = {
  testLegacyHighBudget,
  testLegacyMediumBudget,
  testLegacyLowBudget,
  testExplicitEffortOverrides,
  testDisabledThinkingNoEffort,
  testUndefinedThinkingEmpty,
  testCustomThresholds,
  testForceHighSpecialCase,
  testAdaptiveLikeEnabled,
  testNoThresholdsReturnsThinkingOnly,
};

if (require.main === module) {
  loadModule().then(() =>
    runTestSuite('reasoning_effort Conversion', [
      { name: 'TC2901: legacy high budget (8192)', fn: testLegacyHighBudget },
      { name: 'TC2902: legacy medium budget (2048)', fn: testLegacyMediumBudget },
      { name: 'TC2903: legacy low budget (1024)', fn: testLegacyLowBudget },
      { name: 'TC2904: explicit effort overrides', fn: testExplicitEffortOverrides },
      { name: 'TC2905: disabled → no effort', fn: testDisabledThinkingNoEffort },
      { name: 'TC2906: undefined → empty', fn: testUndefinedThinkingEmpty },
      { name: 'TC2907: custom thresholds', fn: testCustomThresholds },
      { name: 'TC2908: force-high special case', fn: testForceHighSpecialCase },
      { name: 'TC2909: adaptive like enabled', fn: testAdaptiveLikeEnabled },
      { name: 'TC2910: no thresholds → thinking only', fn: testNoThresholdsReturnsThinkingOnly },
    ])
  );
}
