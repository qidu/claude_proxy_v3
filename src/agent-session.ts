/**
 * Interactive pi-agent session that uses model_proxy_v3's own HTTP server as
 * its LLM provider (loopback /v1/messages). Started via AGENT=true, mirroring
 * the TUI=true convention in server.ts.
 *
 * Flow: pick working directory -> pick model -> verify with "hi, which model
 * and agent are right here?" -> set a budget (tokens or turns) -> state the
 * task -> run -> summarize file changes
 * -> prompt for a follow-up task (same agent/budget) until blank/budget hit.
 */
import { randomUUID } from 'crypto';
import { access, constants as fsConstants, mkdir, readFile, readdir, stat } from 'fs/promises';
import { appendFileSync } from 'fs';
import { resolve, relative, join } from 'path';
import { tmpdir, homedir } from 'os';
import { execFile } from 'child_process';
import {
  ProcessTerminal,
  SelectList,
  TUI,
  Input,
  type Component,
  type SelectItem,
} from '@earendil-works/pi-tui';
import { Agent, loadSkills, formatSkillInvocation } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { createModels, createProvider, type Model } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import type { Env } from './types/shared.js';
import type { ProxyConfig } from './utils/config-loader.js';
import { getConfiguredModelIds } from './utils/config-loader.js';
import { createAgentTools } from './agent-tools.js';

export interface AgentSessionSource {
  env: Env;
  loadConfig: (forceReload?: boolean) => Promise<ProxyConfig>;
  port: number;
}

// Dark gray (ANSI 90) wrapper for this session's own status/notice output
// (console.log), so it reads as dimmed background chatter against the
// agent's own streamed reply text. console.error output is left plain —
// those signal actual failures and should stay visually distinct.
function dim(text: string): string {
  return `\x1b[90m${text}\x1b[0m`;
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

// TRAJ=true/1 records this session's full console output (status lines, tool
// calls/results, replies) to a flat trajectory log, unrelated to LOG_LEVEL/
// AGENT_MODE's terminal-only dimming above. Path uses os.tmpdir() (not a
// hardcoded /tmp — see the same fix in agent-tools.ts's TMP_ROOT_RAW) so it
// still lands under the real OS temp root when $TMPDIR is set. Opt-in and
// off by default: appends across runs rather than truncating, so nothing is
// silently lost if this is left on across multiple sessions.
const TRAJECTORY_LOG_PATH = join(tmpdir(), 'agent_trajectory.log');
function isTrajectoryLoggingEnabled(): boolean {
  return process.env.TRAJ === 'true' || process.env.TRAJ === '1';
}

const PROVIDER_ID = 'model-proxy-v3';
const SYSTEM_PROMPT_FILENAMES = ['AGENTS.md', 'CLAUDE.md'];
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful coding assistant.';
// Explicit end-the-session commands for the follow-up task prompt, alongside
// blank input (both end the loop before the budget is reached).
const QUIT_COMMANDS = new Set(['/q', '/quit', '/exit']);
// Confirmed via the `skills` CLI's own bundled agent registry (vercel-labs/skills,
// dist/cli.mjs): the "pi" agent target's global skills dir is ~/.pi/agent/skills,
// distinct from project-scoped ".pi/skills" (used by add_skill, agent-tools.ts) and
// distinct from other agents' global dirs (~/.claude/skills etc. are not pi-scoped).
const GLOBAL_SKILLS_DIR = resolve(homedir(), '.pi/agent/skills');

// ---------------------------------------------------------------------------
// Minimal standalone pi-tui screens (picker + text prompt). The full
// DashboardApp/ListOverlay machinery in tui.ts is built for a persistent,
// continuously-redrawing dashboard with overlays layered on top of it; this
// session only ever shows one linear screen at a time, so it drives its own
// throwaway TUI instance per screen instead of reusing that scaffolding.
// ---------------------------------------------------------------------------

class PickerScreen implements Component {
  private readonly list: SelectList;
  constructor(
    private readonly title: string,
    items: SelectItem[],
  ) {
    this.list = new SelectList(items, 12, {
      selectedPrefix: (t) => `> ${t}`,
      selectedText: (t) => `\x1b[1m${t}\x1b[0m`,
      description: (t) => `\x1b[2m${t}\x1b[0m`,
      scrollInfo: (t) => `\x1b[2m${t}\x1b[0m`,
      noMatch: (t) => `\x1b[2m${t}\x1b[0m`,
    });
  }
  get selectList(): SelectList {
    return this.list;
  }
  handleInput(data: string): void {
    this.list.handleInput(data);
  }
  invalidate(): void {
    this.list.invalidate();
  }
  render(width: number): string[] {
    return [this.title, '', ...this.list.render(width)];
  }
}

/** Show a single-selection picker in its own throwaway TUI screen; resolves with the chosen value, or null on cancel (Ctrl+C/Esc). */
async function pickFromList(title: string, items: SelectItem[]): Promise<string | null> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const screen = new PickerScreen(title, items);
  return new Promise((resolvePick) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      tui.stop();
      resolvePick(value);
    };
    screen.selectList.onSelect = (item) => finish(item.value);
    screen.selectList.onCancel = () => finish(null);
    tui.addChild(screen);
    tui.setFocus(screen);
    tui.start();
  });
}

class PromptScreen implements Component {
  private readonly input = new Input();
  constructor(
    private readonly title: string,
    defaultValue = '',
  ) {
    this.input.setValue(defaultValue);
    // setValue() leaves the cursor at 0 (its construction-time default),
    // clamped rather than moved — so a prefilled default (e.g. the cwd)
    // renders with the cursor at the start of the line. Send the
    // cursorLineEnd keybinding (ctrl+e, \x05) to place it at the end, same
    // as if the user had pressed End/ctrl+e themselves.
    this.input.handleInput('\x05');
  }
  get inputComponent(): Input {
    return this.input;
  }
  handleInput(data: string): void {
    this.input.handleInput(data);
  }
  invalidate(): void {
    this.input.invalidate();
  }
  render(width: number): string[] {
    // Split on \n so a caller can pass a multi-line title (e.g. moving a long
    // clause to its own line) — each line must be a separate array element,
    // since the TUI renderer tracks one row per element for cursor repositioning.
    return [...this.title.split('\n'), '', ...this.input.render(width)];
  }
}

/** Show a single-line text prompt in its own throwaway TUI screen; resolves with the entered text (possibly ''), or null on cancel. */
async function promptText(title: string, defaultValue = ''): Promise<string | null> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const screen = new PromptScreen(title, defaultValue);
  return new Promise((resolvePrompt) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      tui.stop();
      // Blank line after a submitted answer so whatever follows (status lines,
      // the agent's streamed reply, the next prompt) doesn't butt up against
      // the input line. Skipped on cancel (null), where the session is exiting
      // and the caller prints its own "Cancelled/exiting" notice anyway.
      if (value !== null) console.log('');
      resolvePrompt(value);
    };
    screen.inputComponent.onSubmit = (value) => finish(value);
    screen.inputComponent.onEscape = () => finish(null);
    tui.addChild(screen);
    tui.setFocus(screen);
    tui.start();
  });
}

// ---------------------------------------------------------------------------
// Working directory
// ---------------------------------------------------------------------------

async function isWritable(dir: string): Promise<boolean> {
  try {
    await access(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the user-chosen working directory, creating it if needed and falling back to /tmp when unwritable. Returns the final dir plus a note if a fallback happened. */
async function resolveWorkDir(input: string): Promise<{ dir: string; fallbackNotice: string | null }> {
  const requested = resolve(input.trim() || process.cwd());
  try {
    await mkdir(requested, { recursive: true });
  } catch {
    // fall through to writability check / fallback below
  }
  if (await isWritable(requested)) {
    return { dir: requested, fallbackNotice: null };
  }
  const fallback = resolve(tmpdir(), `task-${randomUUID().slice(0, 8)}`);
  await mkdir(fallback, { recursive: true });
  return {
    dir: fallback,
    fallbackNotice: `"${requested}" is not writable — using "${fallback}" instead.`,
  };
}

async function loadSystemPrompt(workDir: string): Promise<string> {
  for (const filename of SYSTEM_PROMPT_FILENAMES) {
    try {
      const content = await readFile(resolve(workDir, filename), 'utf-8');
      if (content.trim()) return content;
    } catch {
      // not found / unreadable — try next filename
    }
  }
  return DEFAULT_SYSTEM_PROMPT;
}

/** Loads skills already installed globally (~/.pi/agent/skills) plus project-scoped
 *  (workDir/.pi/skills), formats each with formatSkillInvocation, and returns the
 *  block to append to the system prompt (or '' if none are installed). loadSkills
 *  itself skips missing directories rather than erroring — this is expected on a
 *  fresh machine (no global skills installed yet) and not a failure. `globalSkillsDir`
 *  is parameterized (default GLOBAL_SKILLS_DIR) so this is testable without touching
 *  the real ~/.pi/agent/skills. */
export async function loadStartupSkills(workDir: string, globalSkillsDir: string = GLOBAL_SKILLS_DIR): Promise<string> {
  const env = new NodeExecutionEnv({ cwd: workDir });
  const projectSkillsDir = resolve(workDir, '.pi/skills');
  const { skills, diagnostics } = await loadSkills(env, [projectSkillsDir, globalSkillsDir]);
  for (const diag of diagnostics) {
    console.log(dim(`[skills] ${diag.code}: ${diag.message} (${diag.path})`));
  }
  if (skills.length === 0) return '';
  console.log(dim(`Loaded ${skills.length} skill(s) at startup: ${skills.map((s) => s.name).join(', ')}`));
  return skills.map((skill) => formatSkillInvocation(skill)).join('\n\n');
}

/** Cheap availability probe for the `skills` CLI (vercel-labs/skills). Gates whether
 *  find_skill/add_skill are exposed at all — Rule 8: don't ship tools that are present
 *  but always fail. */
function probeSkillsCli(workDir: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    execFile('npx', ['skills', '--version'], { cwd: workDir, timeout: 15_000 }, (error) => {
      resolvePromise(!error);
    });
  });
}

// ---------------------------------------------------------------------------
// Budget parsing
// ---------------------------------------------------------------------------

// A budget is one or both limits; the run stops at whichever is hit first.
// Explicit prompt input always sets exactly one (parseBudget below); the
// blank-input default (DEFAULT_BUDGET) sets both.
export type Budget = { tokens?: number; turns?: number };

const BUDGET_PATTERN = /^(\d+(?:\.\d+)?)([kKmM]?)$/;

// Applied when the budget prompt is left blank OR submitted with its prefill
// unchanged (see startAgentSession). Turns is sized to be a runaway-loop
// backstop rather than the binding limit: at a realistic ~30k tokens/turn,
// 5m tokens is roughly 150 turns, so 100 turns keeps tokens as the constraint
// that normally trips first while still bounding a loop that makes no progress.
export const DEFAULT_BUDGET: Budget = { tokens: 5_000_000, turns: 100 };

// Prefilled into the budget prompt. Compared against the submitted value to
// detect "took the default", so it must stay in sync with DEFAULT_BUDGET.tokens.
export const BUDGET_PROMPT_DEFAULT = '5m';

/** Bare integer = turn budget. Integer with k/m suffix (case-insensitive) = token budget.
 *  Not parseHumanTokenLimit: that parser requires a mandatory duration suffix
 *  (e.g. "50k 1h", for rate-limit windows) and can't parse a standalone value. */
export function parseBudget(raw: string): Budget | null {
  const match = BUDGET_PATTERN.exec(raw.trim());
  if (!match) return null;
  const [, numStr, suffix] = match;
  const num = Number(numStr);
  if (!Number.isFinite(num) || num <= 0) return null;
  if (!suffix) {
    if (!Number.isInteger(num)) return null;
    return { turns: num };
  }
  const multiplier = suffix.toLowerCase() === 'k' ? 1_000 : 1_000_000;
  return { tokens: Math.round(num * multiplier) };
}

/** Human-readable form for logging, e.g. "10 turns", "5,000,000 tokens", or "5,000,000 tokens / 10 turns" when both are set. */
export function formatBudget(budget: Budget): string {
  const parts: string[] = [];
  if (budget.tokens !== undefined) parts.push(`${budget.tokens.toLocaleString()} tokens`);
  if (budget.turns !== undefined) parts.push(`${budget.turns.toLocaleString()} turns`);
  return parts.join(' / ');
}

// ---------------------------------------------------------------------------
// workDir file-change tracking (for the post-run "files changed" summary)
// ---------------------------------------------------------------------------

const SNAPSHOT_IGNORED_DIRS = new Set(['.git', 'node_modules']);

/** Recursively maps every file under `workDir` to its mtime (ms). Used to
 *  diff before/after a task run and report what the agent created/modified —
 *  works regardless of whether workDir is a git repo. Skips .git/node_modules
 *  (noisy, not "generated stuff" from the agent's own task). Missing/unreadable
 *  entries are skipped rather than failing the whole snapshot (best-effort
 *  summary, not a critical path). */
export async function snapshotWorkDir(workDir: string): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SNAPSHOT_IGNORED_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        const fullPath = join(dir, entry.name);
        try {
          const st = await stat(fullPath);
          files.set(relative(workDir, fullPath), st.mtimeMs);
        } catch {
          // File removed/unreadable between readdir and stat — skip it.
        }
      }
    }
  }
  await walk(workDir);
  return files;
}

/** Diffs two snapshots into created/modified file lists, sorted for stable
 *  output. Deletions aren't reported — "generated stuff" is about what the
 *  agent produced, not what it removed. */
export function diffWorkDirSnapshots(before: Map<string, number>, after: Map<string, number>): { created: string[]; modified: string[] } {
  const created: string[] = [];
  const modified: string[] = [];
  for (const [path, mtime] of after) {
    const prevMtime = before.get(path);
    if (prevMtime === undefined) created.push(path);
    else if (prevMtime !== mtime) modified.push(path);
  }
  created.sort();
  modified.sort();
  return { created, modified };
}

// ---------------------------------------------------------------------------
// Provider wiring
// ---------------------------------------------------------------------------

function buildSelfModel(alias: string, port: number): Model<'anthropic-messages'> {
  return {
    id: alias,
    name: alias,
    api: 'anthropic-messages',
    provider: PROVIDER_ID,
    baseUrl: `http://127.0.0.1:${port}`,
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

/**
 * Order the model picker so the interesting aliases come first: composite
 * aliases (coordinator/fusion/fallback/share — the multi-target routing this
 * proxy exists to exercise), then schedule aliases, then the plain [models.*]
 * target models last. getConfiguredModelIds returns the opposite order
 * (targets first, aliases appended); it's shared with /v1/models, the TUI and
 * the dashboard, so this reordering is local to the picker rather than a
 * change to that shared function. Each group keeps its config order, and the
 * kind is shown as the item description so the grouping is visible, not just
 * implied by position — the kind only, not the composite mode
 * (coordinator/fusion/fallback/share), which is more detail than picking a
 * model calls for.
 */
export function buildModelPickerItems(aliases: string[], config: ProxyConfig): SelectItem[] {
  const composite: SelectItem[] = [];
  const schedule: SelectItem[] = [];
  const targets: SelectItem[] = [];
  for (const id of aliases) {
    if (config.composite?.[id]) {
      composite.push({ value: id, label: id, description: 'composite' });
    } else if (config.schedule?.[id]) {
      schedule.push({ value: id, label: id, description: 'schedule' });
    } else {
      targets.push({ value: id, label: id, description: 'target model' });
    }
  }
  return [...composite, ...schedule, ...targets];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function startAgentSession(source: AgentSessionSource): Promise<void> {
  const { env, loadConfig, port } = source;

  // TRAJ=true/1: tee console.log/console.error to a flat trajectory log for
  // the lifetime of this session, restored in the top-level finally below.
  // Wrapping console here (rather than each of the ~25 call sites in this
  // file) mirrors the existing console.log override in server.ts's TUI=true
  // branch. ANSI color codes are stripped for the file (dim() is a
  // terminal-only concern); the console itself keeps its normal formatting.
  const trajectoryEnabled = isTrajectoryLoggingEnabled();
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  if (trajectoryEnabled) {
    const writeLine = (prefix: string, args: unknown[]) => {
      const line = args.map((a) => (typeof a === 'string' ? stripAnsi(a) : String(a))).join(' ');
      // Blank lines are terminal-only spacing (see promptText) — same rationale
      // as stripping ANSI above, they carry no information in the log file.
      if (!line.trim()) return;
      appendFileSync(TRAJECTORY_LOG_PATH, `${new Date().toISOString()} ${prefix} ${line}\n`);
    };
    console.log = (...args: unknown[]) => {
      writeLine('[LOG]', args);
      originalConsoleLog(...args);
    };
    console.error = (...args: unknown[]) => {
      writeLine('[ERROR]', args);
      originalConsoleError(...args);
    };
    originalConsoleLog(dim(`[TRAJ] Recording session trajectory to ${TRAJECTORY_LOG_PATH}`));
  }

  try {
    await runAgentSession(source);
  } finally {
    if (trajectoryEnabled) {
      console.log = originalConsoleLog;
      console.error = originalConsoleError;
    }
  }
}

/** The actual session flow, split out from startAgentSession so TRAJ's console
 *  patching (which must wrap every exit path, including early returns below)
 *  stays in one try/finally at the outer call site instead of being duplicated
 *  at each return. */
async function runAgentSession(source: AgentSessionSource): Promise<void> {
  const { env, loadConfig, port } = source;

  // No OS-level sandbox: the bash tool runs commands via a plain `/bin/sh -c`
  // child process with this user's full privileges (see README "Tool safety
  // limits") — pi-agent-core itself provides no sandboxing either. Only the
  // path-confinement/denylist checks in agent-tools.ts apply, and those are
  // raw string/regex matching, not enforced by the OS. Printed unconditionally
  // at session start so this is visible before any prompt (Rule 8: fail loud).
  console.log('[WARNING] No OS-level sandbox — bash/write_file run with this user\'s full privileges, confined only by this session\'s own path/command checks (see README "Tool safety limits").');

  const dirInputRaw = await promptText('Working directory (default: current dir):', process.cwd());
  if (dirInputRaw === null) {
    console.log(dim('Cancelled — exiting agent session.\nbye!'));
    return;
  }
  const dirInput = dirInputRaw || process.cwd();
  const { dir: workDir, fallbackNotice } = await resolveWorkDir(dirInput);
  if (fallbackNotice) {
    console.log(dim(fallbackNotice));
  }
  const baseSystemPrompt = await loadSystemPrompt(workDir);
  console.log(dim('Checking for global/project skills...'));
  const startupSkills = await loadStartupSkills(workDir);
  const systemPrompt = startupSkills ? `${baseSystemPrompt}\n\n${startupSkills}` : baseSystemPrompt;

  // npx has to resolve the "skills" package even when it's installed locally,
  // which can take a few seconds with no output of its own — print a notice
  // first so this doesn't look like a silent hang (Rule 8).
  console.log(dim('Checking for "skills" CLI...'));
  const skillsCliAvailable = await probeSkillsCli(workDir);
  if (!skillsCliAvailable) {
    console.log(dim('[INFO] "skills" CLI not found (npx skills --version failed) — find_skill/add_skill tools disabled for this session.'));
    console.log(dim('       To enable them: run `npm install skills`, then verify with `npx skills find <query>`.'));
  }

  console.log(dim('Loading proxy config...'));
  const config = await loadConfig();
  const aliases = getConfiguredModelIds(config);
  if (aliases.length === 0) {
    console.error('No models configured in proxy_config.toml — nothing to select. Aborting agent session.');
    return;
  }

  // Resolve a key to auth the loopback /v1/messages call with, same
  // precedence tui.ts's own model-test call already uses (PROXY_CLIENT_API_KEY
  // override, else the proxy's own default_upstream.default_api_key, else
  // DEV_NO_KEY): without this, every verification attempt 401s from the
  // proxy's own auth check (src/index.ts) no matter which model is picked,
  // which previously showed up as an unexplained infinite "pick a different
  // model" loop (Rule 8: fail loud once, up front, instead of looping silently).
  const devNoKey = env.DEV_NO_KEY === 'true' || env.DEV_NO_KEY === '1';
  const clientApiKey = env.PROXY_CLIENT_API_KEY || config.default_upstream?.default_api_key;
  if (!clientApiKey && !devNoKey) {
    console.error(
      'Cannot start an agent session: no client API key available to authenticate the loopback' +
      ' /v1/messages call. Set PROXY_CLIENT_API_KEY, configure [default_upstream] default_api_key' +
      ' in proxy_config.toml, or set DEV_NO_KEY=true. Aborting agent session.',
    );
    return;
  }
  const models = createModels();
  const provider = createProvider({
    id: PROVIDER_ID,
    baseUrl: `http://127.0.0.1:${port}`,
    auth: {
      apiKey: clientApiKey
        ? { name: 'model_proxy_v3 client key', resolve: async () => ({ auth: { apiKey: clientApiKey } }) }
        : { name: 'model_proxy_v3 (DEV_NO_KEY)', resolve: async () => ({ auth: {} }) },
    },
    models: aliases.map((alias) => buildSelfModel(alias, port)),
    api: anthropicMessagesApi(),
  });
  models.setProvider(provider);

  let selectedAlias: string | null = null;
  let agent: Agent | null = null;

  while (!selectedAlias) {
    const choice = await pickFromList(
      'Select a model (Esc to cancel):',
      buildModelPickerItems(aliases, config),
    );
    if (!choice) {
      console.log(dim('No model selected — exiting agent session.\nbye!'));
      return;
    }
    const model = models.getModel(PROVIDER_ID, choice);
    if (!model) {
      console.error(`Internal error: model "${choice}" not found on provider after selection.`);
      continue;
    }

    // candidateRef lets the skill tools reach the live Agent's system prompt
    // (agent.state.systemPrompt) even though tools must be built before the
    // Agent that will hold them is constructed.
    const candidateRef: { current: Agent | null } = { current: null };
    const candidate = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools: createAgentTools(workDir, {
          skillsCliAvailable,
          getSystemPrompt: () => candidateRef.current!.state.systemPrompt,
          setSystemPrompt: (prompt: string) => {
            candidateRef.current!.state.systemPrompt = prompt;
          },
        }),
      },
      streamFn: models.streamSimple.bind(models),
    });
    candidateRef.current = candidate;

    console.log(dim(`Verifying "${choice}" — sending "hi, which model and agent are right here?"...`));
    let replyText = '';
    let sawError = false;
    const unsubscribe = candidate.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        replyText += event.assistantMessageEvent.delta;
      }
      if (event.type === 'agent_end') {
        const last = candidate.state.messages[candidate.state.messages.length - 1] as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
        if (last?.role === 'assistant' && last.stopReason === 'error') {
          sawError = true;
          console.error(`Verification failed: ${last.errorMessage ?? 'unknown error'}`);
        }
      }
    });
    try {
      await candidate.prompt('hi, which model and agent are right here?');
    } catch (err) {
      sawError = true;
      console.error(`Verification failed: ${(err as Error).message}`);
    } finally {
      unsubscribe();
    }

    if (sawError || !replyText.trim()) {
      if (!sawError) console.error('Verification failed: model returned an empty reply.');
      console.log(dim('Pick a different model.'));
      continue;
    }

    console.log(`Reply: ${replyText.trim()}`);
    selectedAlias = choice;
    agent = candidate;
  }

  if (!agent) return; // unreachable, satisfies TS narrowing

  // -- Budget prompt --
  let budget: Budget | null = null;
  while (!budget) {
    const raw = await promptText(
      'Max tokens (e.g. 1000000 or 1m) or max turns (e.g. 20), /quit or /exit to end:\nblank for default budget (5m tokens && 100 turns)',
      BUDGET_PROMPT_DEFAULT,
    );
    if (raw === null || QUIT_COMMANDS.has(raw.trim().toLowerCase())) {
      console.log(dim('No budget entered — exiting agent session.\nbye!'));
      return;
    }
    // Blank input and accepting the "5m" prefill unchanged both mean "the
    // default" — so both yield the combined DEFAULT_BUDGET. Without this,
    // submitting the prefill would run parseBudget('5m') = tokens-only and
    // silently drop the turn cap, making the two ways of taking the default
    // behave in opposite ways (one nearly unbounded, one capped).
    if (!raw.trim() || raw.trim().toLowerCase() === BUDGET_PROMPT_DEFAULT) {
      budget = DEFAULT_BUDGET;
      break;
    }
    budget = parseBudget(raw);
    if (!budget) {
      console.error(`Could not parse "${raw}" — enter a bare integer for turns (e.g. 20) or a k/m-suffixed value for tokens (e.g. 50k), or leave blank for the default.`);
    }
  }
  console.log(dim(`Budget: ${formatBudget(budget)}.`));

  // Proxy-request logging (e.g. "/v1/messages for ... to ..." and the
  // per-request upstream summary line, both logged at info) is very noisy
  // against the compact [tool]/streamed-text output this session already
  // prints below, and floods the terminal turn-over-turn — suppress it for
  // the remainder of the interactive session by lowering the shared env's
  // LOG_LEVEL (env is the same object every request handler reads its logger
  // from), restoring the original value on exit so background/non-agent
  // traffic logging is unaffected once the session ends.
  const originalLogLevel = env.LOG_LEVEL;
  env.LOG_LEVEL = 'warn';

  // -- Budget enforcement --
  // The Agent class does not forward shouldStopAfterTurn to the underlying
  // loop (that field only exists on AgentLoopConfig, consumed by the
  // low-level agentLoop()/runAgentLoop() functions — confirmed by reading
  // Agent.createLoopConfig() in dist/agent.js, which never includes it).
  // So budget enforcement here uses the Agent class's actual control
  // surface: turn_end subscribers are awaited before the loop starts
  // another LLM call, so calling agent.abort() from one stops the run
  // gracefully after the current turn — the same "stop after this turn"
  // semantics shouldStopAfterTurn documents, via abort() instead. Usage
  // accumulates across follow-up tasks in the loop below (not reset per
  // task) — the budget is for the whole session, same as the original design.
  let turnsUsed = 0;
  let tokensUsed = 0;
  let budgetHit = false;
  const runningAgent = agent;

  const unsubscribeBudget = runningAgent.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
    if (event.type === 'tool_execution_start') {
      const argsPreview = JSON.stringify(event.args).slice(0, 120);
      console.log(dim(`\n[tool] ${event.toolName}(${argsPreview})`));
    }
    if (event.type === 'tool_execution_end') {
      const preview = JSON.stringify(event.result?.details ?? {}).slice(0, 120);
      console.log(dim(`[result] ${preview}`));
    }
    if (event.type === 'turn_end') {
      turnsUsed += 1;
      const msg = event.message as { role?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } };
      if (msg.role === 'assistant' && msg.usage) {
        tokensUsed += msg.usage.input + msg.usage.output + msg.usage.cacheRead + msg.usage.cacheWrite;
      }
      const exceeded =
        (budget!.turns !== undefined && turnsUsed >= budget!.turns) ||
        (budget!.tokens !== undefined && tokensUsed >= budget!.tokens);
      if (exceeded) {
        budgetHit = true;
        runningAgent.abort();
      }
    }
  });

  try {
    // -- Task loop: run a task, summarize what changed, ask for the next one --
    // Follow-up input also doubles as how you answer a clarifying question the
    // agent asked at the end of its last turn (e.g. "Want me to consolidate
    // them?") — it's appended to the same transcript via prompt(), not a fresh
    // conversation, so the agent picks up right where it left off. Blank input
    // or /q, /quit, /exit end the session early, without waiting for budget.
    let task = await promptText('What do you want the agent to do?');
    while (task !== null && !QUIT_COMMANDS.has(task.trim().toLowerCase()) && task.trim() && !budgetHit) {
      const beforeSnapshot = await snapshotWorkDir(workDir);
      try {
        await runningAgent.prompt(task);
        while (!budgetHit && runningAgent.hasQueuedMessages()) {
          await runningAgent.continue();
        }
      } catch (err) {
        console.error(`\nAgent run failed: ${(err as Error).message}`);
      }

      const afterSnapshot = await snapshotWorkDir(workDir);
      const { created, modified } = diffWorkDirSnapshots(beforeSnapshot, afterSnapshot);
      const changeSummary = created.length === 0 && modified.length === 0
        ? 'no files created or modified'
        : [
            created.length > 0 ? `created: ${created.join(', ')}` : null,
            modified.length > 0 ? `modified: ${modified.join(', ')}` : null,
          ].filter(Boolean).join(' | ');
      console.log(dim(
        `\n\n--- ${budgetHit ? 'Budget reached' : 'Turn done'} (${turnsUsed} turns, ${tokensUsed} tokens used, limit: ${formatBudget(budget)}) ---\n` +
        `${changeSummary}`,
      ));

      if (budgetHit) {
        // Budget enforcement stops the agent, not the session — require an
        // explicit acknowledgment before exiting so this reads as a deliberate
        // stop, not a hang (Rule 8: fail loud, don't just trail off).
        await promptText('Budget reached — press enter or type /q to exit:');
        break;
      }
      task = await promptText('Next task (/quit, /exit or ctrl+c to end):');
    }
    // Sign off on a user-initiated exit (blank input, /q, /quit, /exit, or a
    // cancelled prompt). Not printed when the budget stopped the run — that
    // path already prints its own "Budget reached" acknowledgment above, and
    // the session ended on its own terms rather than because the user asked.
    if (!budgetHit) console.log(dim('bye!'));
  } finally {
    unsubscribeBudget();
    env.LOG_LEVEL = originalLogLevel;
  }
}
