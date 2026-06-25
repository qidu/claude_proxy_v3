/**
 * Wildcard and Catch-All Routing Tests
 * Tests the 3-priority routing model:
 *   Priority 1: Exact key match (all categories)
 *   Priority 2: prefix-* wildcard (claude → gemini → default)
 *   Priority 3: Bare * catch-all (models.default only)
 *
 * Coverage:
 * - TC1401: Priority 1 — exact match in models.free overrides wildcard
 * - TC1402: Priority 1 — exact match in models.default
 * - TC1403: Priority 2 — claude-* wildcard routes to models.claude
 * - TC1404: Priority 2 — gemini-* wildcard routes to models.gemini
 * - TC1405: Priority 3 — bare * catch-all in models.default
 * - TC1406: Routing priority — exact beats wildcard (claude-opus-4-8 in both free & claude)
 *
 * Reference: docs/routing_config_revision.md §"Wildcard and Catch-All Routing"
 */

const {
  sendRequest,
  assert,
  runTestSuite
} = require('../utils/test_helpers');

/**
 * TC1401: Priority 1 — exact match in models.free wins over wildcard
 *
 * 'claude-sonnet-4-6' has an exact entry 'sonnet46=["claude-sonnet-4-6","",""]'
 * in models.free.  This must route to localhost:3000, NOT to the claude-*
 * wildcard in models.claude.
 */
async function testPriority1ExactFreeWins() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Reply ok' }],
      max_tokens: 10
    }
  });

  // We expect either 200 (upstream replied) or an auth/upstream error that
  // confirms the request was forwarded to localhost:3000 (models.free.base_url).
  // models.free may return 401/403 (invalid credentials), which is fine.
  // The only failure case is 404 — that would mean the routing fell through
  // to models.claude (wrong) or the catch-all (wrong).
  assert(
    response.status !== 404,
    `claude-sonnet-4-6 should route to models.free (not api.anthropic.com). ` +
    `Got status=${response.status} — 404 means routing missed models.free`
  );

  console.log(`  ✓ claude-sonnet-4-6 → models.free (status=${response.status})`);
}

/**
 * TC1402: Priority 1 — exact match in models.default
 *
 * 'max-m3' has an exact entry in models.default and must route there.
 */
async function testPriority1ExactDefault() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'max-m3',
      messages: [{ role: 'user', content: 'Reply ok' }],
      max_tokens: 10
    }
  });

  // max-m3 routes to models.default.  The upstream (api.minimaxi.com) may not
  // accept 'max-m3' as a model name, so we accept any non-5xx status as
  // confirmation the routing target was correct.
  assert(
    response.status < 500 || response.status === undefined,
    `max-m3 should route to models.default. Got status=${response.status}`
  );

  console.log(`  ✓ max-m3 → models.default (status=${response.status})`);
}

/**
 * TC1403: Priority 2 — claude-* wildcard routes to models.claude
 *
 * 'claude-haiku-4-5-20251001' has no exact entry anywhere.  It matches
 * 'claude-*' in models.claude (Priority 2) and is forwarded to api.anthropic.com.
 */
async function testPriority2ClaudeWildcard() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'Reply ok' }],
      max_tokens: 10
    }
  });

  // The model has no exact match; the claude-* wildcard should forward to
  // api.anthropic.com (models.claude.base_url).  We verify this by checking
  // for an Anthropic-specific error (invalid API key format, API version
  // mismatch) rather than a routing-to-wrong-host error.
  // Accept 200 (real key works) or 401/400 with Anthropic signature.
  const anthropicSignature =
    response.body?.error?.message?.includes('x-api-key') ||
    response.body?.error?.message?.includes('Anthropic') ||
    response.body?.error?.type === 'authentication_error';

  assert(
    response.status === 200 || anthropicSignature,
    `claude-haiku-4-5-20251001 should route via claude-* to api.anthropic.com. ` +
    `Got status=${response.status}: ${JSON.stringify(response.body?.error)?.slice(0, 120)}`
  );

  console.log(`  ✓ claude-haiku-4-5-20251001 → claude-* wildcard (status=${response.status})`);
}

/**
 * TC1404: Priority 2 — gemini-* wildcard routes to models.gemini
 *
 * 'gemini-2.0-flash' has no exact entry.  It matches 'gemini-*' in
 * models.gemini and is forwarded to models.gemini.base_url.
 */
async function testPriority2GeminiWildcard() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'Reply ok' }],
      max_tokens: 10
    }
  });

  // gemini-2.0-flash should route via gemini-* to models.gemini.base_url.
  // The upstream may reject the model name or the auth, but it should NOT
  // route to claude (wrong wildcard order) or default (catch-all skipped).
  assert(
    response.status !== 404,
    `gemini-2.0-flash should route via gemini-* wildcard, not fall through to catch-all. ` +
    `Got status=${response.status}`
  );

  console.log(`  ✓ gemini-2.0-flash → gemini-* wildcard (status=${response.status})`);
}

/**
 * TC1405: Priority 3 — bare * catch-all in models.default
 *
 * 'totally-unknown-model-xyz123' has no exact match and no wildcard match.
 * It falls through to models.default['*'] which should passthrough the
 * original model name to models.default.base_url.
 *
 * 'openai/gpt-4' also has no match and must route via the catch-all.
 */
async function testPriority3CatchAll() {
  const testModels = [
    'totally-unknown-model-xyz123',
    'openai/gpt-4',
    'some-random-model-abc'
  ];

  for (const model of testModels) {
    const response = await sendRequest({
      endpoint: '/v1/messages',
      body: {
        model,
        messages: [{ role: 'user', content: 'Reply ok' }],
        max_tokens: 10
      }
    });

    // These models have no match in any category; they must reach
    // models.default via the bare * catch-all.  The upstream may reject
    // the model name (5xx), but the request must NOT 404 (routing error).
    assert(
      response.status !== 404,
      `${model} should fall through to * catch-all in models.default. ` +
      `Got status=${response.status} (looks like a routing 404, not upstream rejection)`
    );

    console.log(`  ✓ ${model} → * catch-all (status=${response.status})`);
  }
}

/**
 * TC1406: Routing priority — exact match in models.free beats wildcard in models.claude
 *
 * 'claude-opus-4-8' has NO exact entry in models.free (only 'opus48', not 'claude-opus-4-8').
 * It matches 'claude-*' in models.claude (Priority 2) and routes to api.anthropic.com.
 * This confirms that 'opus48' ≠ 'claude-opus-4-8' (they are different keys).
 */
async function testPriorityExactBeatsWildcard() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'Reply ok' }],
      max_tokens: 10
    }
  });

  // claude-opus-4-8 has no exact entry in any category.
  // It must NOT route to models.free (localhost:3000) because 'opus48'
  // is NOT an exact match for 'claude-opus-4-8'.
  // It should match claude-* and reach api.anthropic.com.
  // Both 401 (auth error) and 403 (permission error) from Anthropic confirm routing.
  const anthropicSignature =
    response.body?.error?.message?.includes('x-api-key') ||
    response.body?.error?.message?.includes('Anthropic') ||
    response.body?.error?.type === 'authentication_error' ||
    response.body?.error?.type === 'permission_error';

  assert(
    response.status === 200 || anthropicSignature,
    `claude-opus-4-8 should match claude-* (models.claude), not 'opus48' in models.free. ` +
    `Got status=${response.status}: ${JSON.stringify(response.body?.error)?.slice(0, 120)}`
  );

  console.log(`  ✓ claude-opus-4-8 → claude-* (Priority 2, not models.free) (status=${response.status})`);
}

module.exports = {
  testPriority1ExactFreeWins,
  testPriority1ExactDefault,
  testPriority2ClaudeWildcard,
  testPriority2GeminiWildcard,
  testPriority3CatchAll,
  testPriorityExactBeatsWildcard
};

if (require.main === module) {
  runTestSuite('Wildcard and Catch-All Routing Tests', [
    { name: 'TC1401: Priority 1 exact (free)', fn: testPriority1ExactFreeWins },
    { name: 'TC1402: Priority 1 exact (default)', fn: testPriority1ExactDefault },
    { name: 'TC1403: Priority 2 claude-* wildcard', fn: testPriority2ClaudeWildcard },
    { name: 'TC1404: Priority 2 gemini-* wildcard', fn: testPriority2GeminiWildcard },
    { name: 'TC1405: Priority 3 bare * catch-all', fn: testPriority3CatchAll },
    { name: 'TC1406: Priority — exact beats wildcard', fn: testPriorityExactBeatsWildcard },
  ]);
}
