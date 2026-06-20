/**
 * Tool Blocklist Erasure Test
 *
 * Unit-style test for `eraseBlockedTools()` from `src/utils/tool-blocklist.ts`.
 * Runs without a live proxy — exercises the helper directly with sample bodies
 * in Claude / OpenAI / Gemini shapes.
 *
 * Usage:
 *   npx tsx tests/test_tool_blocklist_erasure.ts
 */

import { blockTool, unblockTool } from '../src/utils/dashboard-stats.js';
import { eraseBlockedTools } from '../src/utils/tool-blocklist.js';

type Test = { name: string; pass: boolean; detail?: string };
const results: Test[] = [];

function assert(name: string, cond: boolean, detail?: string): void {
  results.push({ name, pass: cond, detail });
}

// Reset blocklist between tests
function reset(): void {
  for (const t of ['erase_me', 'blocked_tool', 'gemini_blocked', 'all_blocked', 'forced_choice']) {
    unblockTool(t);
  }
}

// ── Claude shape ──────────────────────────────────────────────────────────────
reset();
blockTool('erase_me');

{
  const body = {
    model: 'claude-3',
    tools: [
      { name: 'keep_me', input_schema: { type: 'object' } },
      { name: 'erase_me', input_schema: { type: 'object' } },
    ],
  };
  const r = eraseBlockedTools(body, undefined, 'rid-claude');
  const tools = body.tools as Array<{ name: string }>;
  assert('claude: blocked tool removed', r.erasedNames.includes('erase_me') && tools.length === 1 && tools[0].name === 'keep_me');
  assert('claude: surviving tool preserved', tools.length === 1 && tools[0].name === 'keep_me');
}

// ── OpenAI shape ──────────────────────────────────────────────────────────────
reset();
blockTool('erase_me');

{
  const body = {
    model: 'gpt-4',
    tools: [
      { type: 'function', function: { name: 'keep_me', parameters: {} } },
      { type: 'function', function: { name: 'erase_me', parameters: {} } },
      { type: 'file_search' }, // non-function tool — not blockable, must pass through
    ],
  };
  const r = eraseBlockedTools(body, undefined, 'rid-openai');
  const tools = body.tools as Array<{ function?: { name: string } }>;
  assert('openai: blocked tool removed', r.erasedNames.includes('erase_me'));
  assert('openai: non-function tool preserved', tools.some((t) => (t as { type?: string }).type === 'file_search'));
  assert('openai: surviving function preserved', tools.some((t) => t.function?.name === 'keep_me'));
}

// ── Gemini native shape ───────────────────────────────────────────────────────
reset();
blockTool('gemini_blocked');

{
  const body = {
    contents: [],
    tools: [
      {
        functionDeclarations: [
          { name: 'keep_me', parameters: {} },
          { name: 'gemini_blocked', parameters: {} },
        ],
      },
    ],
  };
  const r = eraseBlockedTools(body, undefined, 'rid-gemini');
  const tools = body.tools as Array<{ functionDeclarations: Array<{ name: string }> }>;
  assert('gemini: blocked declaration removed from inner array', r.erasedNames.includes('gemini_blocked'));
  assert('gemini: surviving declaration preserved', tools[0].functionDeclarations.length === 1 && tools[0].functionDeclarations[0].name === 'keep_me');
  assert('gemini: wrapper kept when some declarations survive', tools.length === 1);
}

// ── Gemini: all declarations in wrapper blocked → wrapper dropped ──────────────
reset();
blockTool('gemini_blocked');

{
  const body = {
    contents: [],
    tools: [
      { functionDeclarations: [{ name: 'gemini_blocked', parameters: {} }] },
    ],
  };
  eraseBlockedTools(body, undefined, 'rid-gemini-all');
  const tools = body.tools as unknown[];
  assert('gemini-all: wrapper dropped when all declarations blocked', tools === undefined);
}

// ── All tools blocked → field deleted, not [] ─────────────────────────────────
reset();
blockTool('all_blocked');

{
  const body = {
    tools: [
      { name: 'all_blocked', input_schema: {} },
    ],
  };
  eraseBlockedTools(body, undefined, 'rid-all');
  assert('all-blocked: tools field deleted, not []', !('tools' in body));
}

// ── Empty / missing tools → no crash ──────────────────────────────────────────
reset();
{
  const body: Record<string, unknown> = { model: 'x' };
  const r = eraseBlockedTools(body, undefined, 'rid-empty');
  assert('empty: no crash on missing tools', r.erasedNames.length === 0 && !('tools' in body));
}

{
  const body: Record<string, unknown> = { tools: [] };
  eraseBlockedTools(body, undefined, 'rid-empty-array');
  assert('empty: no crash on empty tools array', Array.isArray(body.tools));
}

// ── tool_choice reset ─────────────────────────────────────────────────────────
reset();
blockTool('forced_choice');

{
  const body = {
    tools: [{ name: 'keep_me', input_schema: {} }],
    tool_choice: { type: 'tool', name: 'forced_choice' },
  };
  const r = eraseBlockedTools(body, undefined, 'rid-tc-claude');
  assert('tool_choice-claude: reset to auto when blocking a forced tool', r.toolChoiceReset && body.tool_choice === 'auto');
}

reset();
blockTool('forced_choice');

{
  const body = {
    tools: [{ type: 'function', function: { name: 'keep_me' } }],
    tool_choice: { type: 'function', function: { name: 'forced_choice' } },
  };
  const r = eraseBlockedTools(body, undefined, 'rid-tc-openai');
  assert('tool_choice-openai: reset to auto when blocking a forced tool', r.toolChoiceReset && body.tool_choice === 'auto');
}

// ── tool_choice NOT reset when not referencing a blocked tool ──────────────────
reset();
{
  const body = {
    tools: [{ name: 'a', input_schema: {} }],
    tool_choice: 'auto',
  };
  const r = eraseBlockedTools(body, undefined, 'rid-tc-keep');
  assert('tool_choice: not reset when string "auto"', !r.toolChoiceReset && body.tool_choice === 'auto');
}

reset();
{
  const body = {
    tools: [{ name: 'a', input_schema: {} }],
    tool_choice: { type: 'tool', name: 'not_blocked' },
  };
  const r = eraseBlockedTools(body, undefined, 'rid-tc-keep2');
  assert('tool_choice: not reset when forcing a non-blocked tool', !r.toolChoiceReset && (body.tool_choice as { name: string }).name === 'not_blocked');
}

// ── Report ────────────────────────────────────────────────────────────────────
reset();

let passed = 0;
let failed = 0;
for (const r of results) {
  if (r.pass) {
    passed++;
    console.log(`  ✅ ${r.name}`);
  } else {
    failed++;
    console.log(`  ❌ ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);