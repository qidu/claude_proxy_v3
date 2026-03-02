/**
 * Thinking utility functions for Claude Proxy v3
 *
 * Provides extended thinking support functionality
 */

import { ThinkingConfigParam } from '../types/claude.js';

/**
 * Normalize thinking configuration to standard string format
 * Converts boolean values to string equivalents
 */
export function normalizeThinkingConfig(
  thinking: any
): ThinkingConfigParam | undefined {
  if (!thinking || typeof thinking !== 'object') {
    return undefined;
  }

  if (thinking.type === undefined) {
    return undefined;
  }

  // Handle boolean true
  if (thinking.type === true) {
    return {
      type: 'enabled',
      budget_tokens: thinking.budget_tokens
    };
  }

  // Handle boolean false
  if (thinking.type === false) {
    return {
      type: 'disabled'
    };
  }

  // Already in string format, return as-is
  if (thinking.type === 'enabled' || thinking.type === 'disabled') {
    return thinking as ThinkingConfigParam;
  }

  return undefined;
}

/**
 * Validate thinking budget tokens
 */
export function validateThinkingBudget(
  thinking: ThinkingConfigParam | undefined,
  maxTokens?: number
): void {
  const normalizedThinking = thinking ? normalizeThinkingConfig(thinking) : undefined;
  if (!normalizedThinking || normalizedThinking.type === 'disabled') {
    return;
  }

  if (normalizedThinking.type === 'enabled') {
    const budgetTokens = normalizedThinking.budget_tokens;

    // Validate budget tokens
    if (budgetTokens < 1) {
      throw new Error('thinking.budget_tokens must be at least 1');
    }

    if (budgetTokens > 100000) {
      throw new Error('thinking.budget_tokens cannot exceed 100,000');
    }

    // Validate against max_tokens if provided
    if (maxTokens !== undefined && budgetTokens > maxTokens) {
      throw new Error('thinking.budget_tokens cannot exceed max_tokens');
    }
  }
}

/**
 * Calculate effective thinking budget
 * Returns the thinking budget tokens, or undefined if thinking is disabled
 */
export function getEffectiveThinkingBudget(
  thinking: ThinkingConfigParam | undefined
): number | undefined {
  const normalizedThinking = thinking ? normalizeThinkingConfig(thinking) : undefined;
  if (!normalizedThinking || normalizedThinking.type === 'disabled') {
    return undefined;
  }

  if (normalizedThinking.type === 'enabled') {
    return normalizedThinking.budget_tokens;
  }

  return undefined;
}

/**
 * Check if thinking is enabled
 */
export function isThinkingEnabled(
  thinking: ThinkingConfigParam | undefined
): boolean {
  const normalizedThinking = thinking ? normalizeThinkingConfig(thinking) : undefined;
  return !!(normalizedThinking && normalizedThinking.type === 'enabled');
}

/**
 * Create default thinking configuration
 */
export function createDefaultThinkingConfig(
  enabled: boolean = false,
  budgetTokens: number = 10000
): ThinkingConfigParam {
  if (enabled) {
    return {
      type: 'enabled',
      budget_tokens: budgetTokens,
    };
  } else {
    return {
      type: 'disabled',
    };
  }
}

/**
 * Adjust thinking budget based on available tokens
 * Returns adjusted thinking config or undefined if thinking should be disabled
 */
export function adjustThinkingBudget(
  thinking: ThinkingConfigParam | undefined,
  availableTokens: number,
  minBudgetTokens: number = 100
): ThinkingConfigParam | undefined {
  const normalizedThinking = thinking ? normalizeThinkingConfig(thinking) : undefined;
  if (!normalizedThinking || normalizedThinking.type === 'disabled') {
    return undefined;
  }

  if (normalizedThinking.type === 'enabled') {
    const currentBudget = normalizedThinking.budget_tokens;

    // If current budget is within available tokens, keep it
    if (currentBudget <= availableTokens) {
      return normalizedThinking;
    }

    // If we can allocate at least minBudgetTokens, adjust budget
    if (availableTokens >= minBudgetTokens) {
      return {
        type: 'enabled',
        budget_tokens: Math.min(currentBudget, availableTokens),
      };
    }

    // Not enough tokens for thinking, disable it
    return {
      type: 'disabled',
    };
  }

  return undefined;
}

/**
 * Estimate thinking token usage
 * Returns estimated tokens for thinking based on configuration
 */
export function estimateThinkingTokens(
  thinking: ThinkingConfigParam | undefined,
  defaultEstimate: number = 1000
): number {
  const normalizedThinking = thinking ? normalizeThinkingConfig(thinking) : undefined;
  if (!normalizedThinking || normalizedThinking.type === 'disabled') {
    return 0;
  }

  if (normalizedThinking.type === 'enabled') {
    // Use budget tokens as estimate, but cap at default if budget is very high
    return Math.min(normalizedThinking.budget_tokens, defaultEstimate);
  }

  return 0;
}

/**
 * Merge thinking configurations
 * Returns a merged thinking config, prioritizing first config
 */
export function mergeThinkingConfigs(
  primary: ThinkingConfigParam | undefined,
  secondary: ThinkingConfigParam | undefined
): ThinkingConfigParam | undefined {
  // Normalize both configs
  const normalizedPrimary = primary ? normalizeThinkingConfig(primary) : undefined;
  const normalizedSecondary = secondary ? normalizeThinkingConfig(secondary) : undefined;

  // If primary is defined, use it
  if (normalizedPrimary) {
    return normalizedPrimary;
  }

  // Otherwise use secondary if defined
  if (normalizedSecondary) {
    return normalizedSecondary;
  }

  return undefined;
}

/**
 * Create thinking block for streaming response
 */
export function createThinkingBlock(
  text: string,
  index: number = 0
): any {
  return {
    type: 'thinking_delta',
    delta: {
      type: 'thinking_delta',
      text,
      index,
    },
  };
}

/**
 * Validate thinking configuration for token counting
 */
export function validateThinkingForTokenCounting(
  thinking: ThinkingConfigParam | undefined
): void {
  const normalizedThinking = thinking ? normalizeThinkingConfig(thinking) : undefined;
  if (!normalizedThinking) {
    return;
  }

  if (normalizedThinking.type === 'enabled') {
    const budgetTokens = normalizedThinking.budget_tokens;

    // For token counting, budget tokens should be reasonable
    if (budgetTokens < 1) {
      throw new Error('thinking.budget_tokens must be at least 1 for token counting');
    }

    if (budgetTokens > 100000) {
      throw new Error('thinking.budget_tokens cannot exceed 100,000 for token counting');
    }
  }
}