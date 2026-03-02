// Test boolean thinking type support

import { validateThinkingConfig } from './dist/utils/validation.js';
import { normalizeThinkingConfig, isThinkingEnabled, getEffectiveThinkingBudget } from './dist/utils/thinking.js';

console.log('=== Testing Boolean Thinking Support ===\n');

// Test 1: Validate boolean true thinking
console.log('Test 1: Validate thinking with type: true');
try {
  const thinkingTrue = {
    type: true,
    budget_tokens: 2048
  };
  validateThinkingConfig(thinkingTrue);
  console.log('✅ Valid thinking config with type: true');
} catch (error) {
  console.log(`❌ Error: ${error.message}`);
}

// Test 2: Validate boolean false thinking
console.log('\nTest 2: Validate thinking with type: false');
try {
  const thinkingFalse = {
    type: false
  };
  validateThinkingConfig(thinkingFalse);
  console.log('✅ Valid thinking config with type: false');
} catch (error) {
  console.log(`❌ Error: ${error.message}`);
}

// Test 3: Validate string enabled thinking
console.log('\nTest 3: Validate thinking with type: "enabled"');
try {
  const thinkingEnabled = {
    type: 'enabled',
    budget_tokens: 4096
  };
  validateThinkingConfig(thinkingEnabled);
  console.log('✅ Valid thinking config with type: "enabled"');
} catch (error) {
  console.log(`❌ Error: ${error.message}`);
}

// Test 4: Validate string disabled thinking
console.log('\nTest 4: Validate thinking with type: "disabled"');
try {
  const thinkingDisabled = {
    type: 'disabled'
  };
  validateThinkingConfig(thinkingDisabled);
  console.log('✅ Valid thinking config with type: "disabled"');
} catch (error) {
  console.log(`❌ Error: ${error.message}`);
}

// Test 5: Normalize boolean thinking
console.log('\nTest 5: Normalize thinking config');
const testCases = [
  { type: true, budget_tokens: 1024 },
  { type: false },
  { type: 'enabled', budget_tokens: 2048 },
  { type: 'disabled' }
];

testCases.forEach((thinking, i) => {
  const normalized = normalizeThinkingConfig(thinking);
  console.log(`\nCase ${i + 1}: ${JSON.stringify(thinking)}`);
  console.log(`Normalized: ${JSON.stringify(normalized)}`);
  console.log(`Is thinking enabled: ${isThinkingEnabled(thinking)}`);
  if (thinking.type === true || thinking.type === 'enabled') {
    console.log(`Effective budget: ${getEffectiveThinkingBudget(thinking)}`);
  }
});

// Test 6: Invalid thinking type
console.log('\nTest 6: Invalid thinking type');
try {
  const invalidThinking = {
    type: 'invalid'
  };
  validateThinkingConfig(invalidThinking);
  console.log('❌ Should have thrown error for invalid type');
} catch (error) {
  console.log(`✅ Correctly rejected invalid type: ${error.message}`);
}

// Test 7: Missing budget_tokens for enabled thinking
console.log('\nTest 7: Missing budget_tokens for enabled thinking');
try {
  const missingBudget = {
    type: true
  };
  validateThinkingConfig(missingBudget);
  console.log('❌ Should have thrown error for missing budget_tokens');
} catch (error) {
  console.log(`✅ Correctly rejected missing budget_tokens: ${error.message}`);
}

console.log('\n=== Test Complete ===');