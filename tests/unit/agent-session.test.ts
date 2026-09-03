import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { loadStartupSkills, snapshotWorkDir, diffWorkDirSnapshots, parseBudget, formatBudget, DEFAULT_BUDGET, BUDGET_PROMPT_DEFAULT, buildModelPickerItems } from '../../src/agent-session.js';
import type { ProxyConfig } from '../../src/utils/config-loader.js';

/**
 * Unit tests for loadStartupSkills: loads skills from both the project-scoped
 * dir (workDir/.pi/skills) and a global dir (parameterized here instead of the
 * real ~/.pi/agent/skills, so tests don't touch the operator's actual machine
 * state), formatting each with formatSkillInvocation. Assertions check real
 * content (which skill names loaded, that formatted output contains the
 * skill body) not just "did not throw".
 */

let workDir: string;
let globalSkillsDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'agent-session-test-workdir-'));
  globalSkillsDir = mkdtempSync(join(tmpdir(), 'agent-session-test-global-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(globalSkillsDir, { recursive: true, force: true });
});

function writeSkill(dir: string, name: string, body: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: test skill ${name}\n---\n\n${body}\n`);
}

describe('loadStartupSkills', () => {
  it('returns an empty string when neither project nor global skills dir exists', async () => {
    const result = await loadStartupSkills(workDir, resolve(globalSkillsDir, 'does-not-exist'));
    assert.equal(result, '');
  });

  it('loads a skill from the global dir and formats it', async () => {
    writeSkill(globalSkillsDir, 'global-skill', 'Do the global thing.');

    const result = await loadStartupSkills(workDir, globalSkillsDir);

    assert.match(result, /name="global-skill"/);
    assert.match(result, /Do the global thing\./);
  });

  it('loads a skill from the project-scoped .pi/skills dir under workDir', async () => {
    writeSkill(resolve(workDir, '.pi/skills'), 'project-skill', 'Do the project thing.');

    const result = await loadStartupSkills(workDir, resolve(globalSkillsDir, 'does-not-exist'));

    assert.match(result, /name="project-skill"/);
    assert.match(result, /Do the project thing\./);
  });

  it('loads both project and global skills together, alongside one another', async () => {
    writeSkill(resolve(workDir, '.pi/skills'), 'project-skill', 'Project body.');
    writeSkill(globalSkillsDir, 'global-skill', 'Global body.');

    const result = await loadStartupSkills(workDir, globalSkillsDir);

    assert.match(result, /name="project-skill"/);
    assert.match(result, /Project body\./);
    assert.match(result, /name="global-skill"/);
    assert.match(result, /Global body\./);
  });
});

/**
 * Unit tests for snapshotWorkDir/diffWorkDirSnapshots: the before/after file
 * snapshot mechanism behind the post-task "files changed" summary. Assertions
 * check actual map contents/classification, not just "did not throw".
 */
describe('snapshotWorkDir', () => {
  it('maps every file under workDir to its mtime', async () => {
    writeFileSync(join(workDir, 'a.txt'), 'a');
    mkdirSync(join(workDir, 'sub'));
    writeFileSync(join(workDir, 'sub', 'b.txt'), 'b');

    const snapshot = await snapshotWorkDir(workDir);

    assert.deepEqual([...snapshot.keys()].sort(), ['a.txt', join('sub', 'b.txt')]);
    for (const mtime of snapshot.values()) {
      assert.equal(typeof mtime, 'number');
      assert.ok(mtime > 0);
    }
  });

  it('skips .git and node_modules subdirectories', async () => {
    writeFileSync(join(workDir, 'kept.txt'), 'kept');
    mkdirSync(join(workDir, '.git'));
    writeFileSync(join(workDir, '.git', 'HEAD'), 'ref: refs/heads/main');
    mkdirSync(join(workDir, 'node_modules'));
    writeFileSync(join(workDir, 'node_modules', 'pkg.js'), 'module.exports = {};');

    const snapshot = await snapshotWorkDir(workDir);

    assert.deepEqual([...snapshot.keys()], ['kept.txt']);
  });

  it('returns an empty map for a directory with no files', async () => {
    const snapshot = await snapshotWorkDir(workDir);
    assert.deepEqual([...snapshot.keys()], []);
  });
});

describe('diffWorkDirSnapshots', () => {
  it('classifies a path only in "after" as created', () => {
    const before = new Map<string, number>();
    const after = new Map([['new.txt', 1000]]);

    assert.deepEqual(diffWorkDirSnapshots(before, after), { created: ['new.txt'], modified: [] });
  });

  it('classifies a path with a changed mtime as modified', () => {
    const before = new Map([['changed.txt', 1000]]);
    const after = new Map([['changed.txt', 2000]]);

    assert.deepEqual(diffWorkDirSnapshots(before, after), { created: [], modified: ['changed.txt'] });
  });

  it('excludes a path with an unchanged mtime from both lists', () => {
    const before = new Map([['same.txt', 1000]]);
    const after = new Map([['same.txt', 1000]]);

    assert.deepEqual(diffWorkDirSnapshots(before, after), { created: [], modified: [] });
  });

  it('does not report a path removed in "after" (deletions are not tracked)', () => {
    const before = new Map([['removed.txt', 1000]]);
    const after = new Map<string, number>();

    assert.deepEqual(diffWorkDirSnapshots(before, after), { created: [], modified: [] });
  });

  it('returns created and modified lists sorted for stable output', () => {
    const before = new Map([['z-changed.txt', 1000], ['a-changed.txt', 1000]]);
    const after = new Map([
      ['z-changed.txt', 2000],
      ['a-changed.txt', 2000],
      ['z-new.txt', 1000],
      ['a-new.txt', 1000],
    ]);

    assert.deepEqual(diffWorkDirSnapshots(before, after), {
      created: ['a-new.txt', 'z-new.txt'],
      modified: ['a-changed.txt', 'z-changed.txt'],
    });
  });

  it('reflects a real mtime change on disk via snapshotWorkDir + utimesSync', async () => {
    const filePath = join(workDir, 'real.txt');
    writeFileSync(filePath, 'v1');
    const before = await snapshotWorkDir(workDir);

    const newTime = new Date(Date.now() + 10_000);
    utimesSync(filePath, newTime, newTime);
    const after = await snapshotWorkDir(workDir);

    assert.deepEqual(diffWorkDirSnapshots(before, after), { created: [], modified: ['real.txt'] });
  });
});

/**
 * Unit tests for parseBudget/formatBudget/DEFAULT_BUDGET: the budget-prompt
 * parser (single-kind, explicit input) and the combined default applied when
 * the prompt is left blank (both a token and a turn limit; whichever hits
 * first stops the run — see startAgentSession's turn_end handler).
 */
describe('parseBudget', () => {
  it('parses a bare integer as a turn budget', () => {
    assert.deepEqual(parseBudget('20'), { turns: 20 });
  });

  it('parses a k-suffixed value as a token budget', () => {
    assert.deepEqual(parseBudget('50k'), { tokens: 50_000 });
    assert.deepEqual(parseBudget('50K'), { tokens: 50_000 });
  });

  it('parses an m-suffixed value as a token budget', () => {
    assert.deepEqual(parseBudget('2m'), { tokens: 2_000_000 });
    assert.deepEqual(parseBudget('2M'), { tokens: 2_000_000 });
  });

  it('rounds fractional token values', () => {
    assert.deepEqual(parseBudget('1.5k'), { tokens: 1_500 });
  });

  it('rejects a fractional turn value (no suffix)', () => {
    assert.equal(parseBudget('1.5'), null);
  });

  it('rejects zero, negative, and non-numeric input', () => {
    assert.equal(parseBudget('0'), null);
    assert.equal(parseBudget('-5'), null);
    assert.equal(parseBudget('abc'), null);
    assert.equal(parseBudget(''), null);
  });
});

describe('DEFAULT_BUDGET', () => {
  it('is a combined 5,000,000-token / 100-turn budget', () => {
    assert.deepEqual(DEFAULT_BUDGET, { tokens: 5_000_000, turns: 100 });
  });

  // The prompt compares the submitted value against BUDGET_PROMPT_DEFAULT to
  // detect "took the default"; if the two drift apart, submitting the prefill
  // silently falls through to parseBudget and loses the turn cap.
  it('keeps BUDGET_PROMPT_DEFAULT in sync with its token count', () => {
    assert.deepEqual(parseBudget(BUDGET_PROMPT_DEFAULT), { tokens: DEFAULT_BUDGET.tokens });
  });

  // Turns must be a backstop, not the binding limit — at a realistic ~30k
  // tokens/turn the token budget should run out first (see the comment on
  // DEFAULT_BUDGET). Guards against reintroducing the old 10-turn cap, which
  // made the 5m token limit unreachable in practice.
  it('sizes turns so the token budget is the limit that normally trips first', () => {
    const realisticTokensPerTurn = 30_000;
    assert.ok(
      DEFAULT_BUDGET.turns! * realisticTokensPerTurn > DEFAULT_BUDGET.tokens! / 2,
      `${DEFAULT_BUDGET.turns} turns caps a typical run well below the ${DEFAULT_BUDGET.tokens}-token budget`,
    );
  });
});

describe('formatBudget', () => {
  it('formats a turns-only budget', () => {
    assert.equal(formatBudget({ turns: 20 }), '20 turns');
  });

  it('formats a tokens-only budget', () => {
    assert.equal(formatBudget({ tokens: 50_000 }), '50,000 tokens');
  });

  it('formats a combined budget as "tokens / turns"', () => {
    assert.equal(formatBudget(DEFAULT_BUDGET), '5,000,000 tokens / 100 turns');
  });
});

describe('buildModelPickerItems', () => {
  // getConfiguredModelIds returns target models first, then composite, then
  // schedule aliases — the picker inverts that, so pass them in that original
  // order to prove the reordering actually happens.
  const config: ProxyConfig = {
    models: {
      claude: { base_url: 'https://x', 'target-a': ['target-a', '', ''] } as any,
      gemini: { base_url: 'https://y', 'target-b': ['target-b', '', ''] } as any,
    },
    composite: {
      'cmp-share': { 'target-a': { share: 1 } },
      'cmp-fusion': { 'target-a': { role: 'panel' }, 'target-b': { role: 'judge' } },
    },
    schedule: { 'sched-1': { 'target-a': [] } },
  };
  const inputOrder = ['target-a', 'target-b', 'cmp-share', 'cmp-fusion', 'sched-1'];

  it('lists composite aliases first, then schedule, then target models last', () => {
    const items = buildModelPickerItems(inputOrder, config);
    assert.deepEqual(
      items.map((i) => i.value),
      ['cmp-share', 'cmp-fusion', 'sched-1', 'target-a', 'target-b'],
    );
  });

  it('labels each item with its kind, not the composite mode', () => {
    const items = buildModelPickerItems(inputOrder, config);
    const byValue = Object.fromEntries(items.map((i) => [i.value, i.description]));
    // Both composites get the same label regardless of their differing modes
    // (cmp-fusion is a fusion alias, cmp-share a share alias).
    assert.equal(byValue['cmp-fusion'], 'composite');
    assert.equal(byValue['cmp-share'], 'composite');
    assert.equal(byValue['sched-1'], 'schedule');
    assert.equal(byValue['target-a'], 'target model');
  });

  it('preserves each group\'s relative input order', () => {
    const items = buildModelPickerItems(['target-b', 'target-a', 'cmp-fusion', 'cmp-share'], config);
    assert.deepEqual(
      items.map((i) => i.value),
      ['cmp-fusion', 'cmp-share', 'target-b', 'target-a'],
    );
  });

  it('keeps value and label equal to the alias id so selection still resolves', () => {
    const items = buildModelPickerItems(inputOrder, config);
    for (const item of items) {
      assert.equal(item.label, item.value);
    }
  });

  it('treats an alias absent from composite/schedule as a target model', () => {
    const items = buildModelPickerItems(['unknown-alias'], {});
    assert.deepEqual(items, [{ value: 'unknown-alias', label: 'unknown-alias', description: 'target model' }]);
  });

  it('returns [] for no aliases', () => {
    assert.deepEqual(buildModelPickerItems([], config), []);
  });
});
