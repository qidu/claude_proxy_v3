import { stdin, stdout } from 'process';
import {
  type Component,
  type Focusable,
  type OverlayHandle,
  type SelectItem,
  type SelectListTheme,
  Input,
  ProcessTerminal,
  SelectList,
  TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui';
import {
  addCompositeAliasFromDashboard,
  getDashboardSnapshot,
  removeCompositeTargetFromDashboard,
  upsertCompositeAliasLimitFromDashboard,
  upsertCompositeTargetFromDashboard,
} from './handlers/dashboard.js';
import { buildHeatmap, renderHeatmapPanel } from './heatmap.js';
import { dumpTodayTokens, TOKEN_LOG_FILE } from './utils/dashboard-stats.js';
import type { Env } from './types/shared.js';
import type { ConfigValidationError } from './utils/config-loader.js';
import type { ProxyConfig } from './utils/config-loader.js';
import { parseHumanTokenLimit, formatTokenLimit } from './utils/config-loader.js';

const TEST_ENDPOINT = '/v1/messages';
const TEST_TOOL_NAME = 'test_tool';
const TEST_TOOL_DESCRIPTION = 'test tool';
const TEST_TOOL_PROMPT = 'Use the test_tool and say hi.';
const TEST_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
  additionalProperties: false,
};

function filterAndStringify(body: unknown): string {
  if (Array.isArray(body)) return `[${body.map(filterAndStringify).join(',')}]`;
  if (body && typeof body === 'object') {
    const filtered = Object.fromEntries(
      Object.entries(body as Record<string, unknown>)
        .filter(([key]) => key !== 'id' && key !== 'session_id' && key !== 'request_id')
        .map(([k, v]) => [k, filterAndStringify(v)]),
    );
    return JSON.stringify(filtered);
  }
  return JSON.stringify(body);
}

function formatTestResultDetail(responseBody: unknown): string {
  if (!responseBody || typeof responseBody !== 'object') {
    return String(responseBody);
  }

  const record = responseBody as Record<string, unknown>;
  const errorDetails = extractErrorDetails(record);
  const messageDetails = extractMessageDetails(record);
  const toolDetails = extractToolDetails(record);
  const lines: string[] = [];

  if (errorDetails.length > 0) {
    lines.push(`error: ${errorDetails.join(' | ')}`);
  }

  if (messageDetails.length > 0) {
    lines.push(`message: ${messageDetails.join(' | ')}`);
  }

  if (toolDetails.length > 0) {
    lines.push(`content: ${toolDetails.join(' | ')}`);
  }

  return lines.length > 0 ? lines.join(' | ') : filterAndStringify(responseBody);
}

type CompositeTargetConfig = { share?: number; primary?: boolean; fallback?: number };

function sortCompositeTargets([aKey, aCfg]: [string, unknown], [bKey, bCfg]: [string, unknown]): number {
  const a = aCfg as CompositeTargetConfig;
  const b = bCfg as CompositeTargetConfig;
  if (a.primary && !b.primary) return -1;
  if (!a.primary && b.primary) return 1;
  const shareA = a.share ?? 1;
  const shareB = b.share ?? 1;
  if (shareA !== shareB) return shareB - shareA;
  if (shareA === 0) {
    return (a.fallback ?? 0) - (b.fallback ?? 0);
  }
  return aKey.localeCompare(bKey);
}


function extractToolDetails(record: Record<string, unknown>): string[] {
  const details: string[] = [];

  const content = record.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const typedBlock = block as Record<string, unknown>;
      if (typedBlock.type === 'tool_use') {
        const name = typeof typedBlock.name === 'string' ? typedBlock.name : 'tool';
        const input = typedBlock.input !== undefined ? stringifyCompact(typedBlock.input) : '';
        details.push(input ? `${name} ${input}` : name);
      }
    }
  }

  const toolCalls = record.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      if (!call || typeof call !== 'object') continue;
      const typedCall = call as Record<string, unknown>;
      const functionCall = typedCall.function;
      if (functionCall && typeof functionCall === 'object') {
        const fn = functionCall as Record<string, unknown>;
        const name = typeof fn.name === 'string' ? fn.name : 'tool';
        const args = fn.arguments !== undefined ? stringifyCompact(fn.arguments) : '';
        details.push(args ? `${name} ${args}` : name);
      } else {
        const name = typeof typedCall.name === 'string' ? typedCall.name : 'tool';
        const args = typedCall.arguments !== undefined ? stringifyCompact(typedCall.arguments) : '';
        details.push(args ? `${name} ${args}` : name);
      }
    }
  }

  const outputs = record.outputs;
  if (Array.isArray(outputs)) {
    for (const output of outputs) {
      if (!output || typeof output !== 'object') continue;
      const typedOutput = output as Record<string, unknown>;
      if (typedOutput.type === 'function_call') {
        const name = typeof typedOutput.name === 'string' ? typedOutput.name : 'tool';
        const args = typedOutput.arguments !== undefined ? stringifyCompact(typedOutput.arguments) : '';
        details.push(args ? `${name} ${args}` : name);
      }
    }
  }

  return details;
}

function extractErrorDetails(record: Record<string, unknown>): string[] {
  const details: string[] = [];

  const error = record.error;
  if (error) {
    if (typeof error === 'string') {
      details.push(error.trim());
    } else if (typeof error === 'object') {
      const errObj = error as Record<string, unknown>;
      const message = errObj.message;
      const type = errObj.type;
      if (typeof message === 'string' && message.trim()) {
        details.push(message.trim());
      } else if (typeof type === 'string' && type.trim()) {
        details.push(type.trim());
      }
    }
  }

  return details;
}

function extractMessageDetails(record: Record<string, unknown>): string[] {
  const details: string[] = [];
  const content = record.content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const typedBlock = block as Record<string, unknown>;
      if (typedBlock.type === 'text' && typeof typedBlock.text === 'string' && typedBlock.text.trim()) {
        texts.push(typedBlock.text.trim());
      }
    }
    if (texts.length > 0) {
      details.push(texts.join(' '));
    }
  }

  if (typeof record.output_text === 'string' && record.output_text.trim()) {
    details.push(record.output_text.trim());
  }

  if (details.length === 0) {
    const fallback = record.message;
    if (typeof fallback === 'string' && fallback.trim()) {
      details.push(fallback.trim());
    }
  }

  return details;
}

function stringifyCompact(value: unknown): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 180 ? `${text.slice(0, 180)}…` : text;
  } catch {
    return String(value);
  }
}

function buildClaudeToolRequest(): Record<string, unknown> {
  return {
    messages: [{ role: 'user', content: TEST_TOOL_PROMPT }],
    max_tokens: 128,
    tools: [{ name: TEST_TOOL_NAME, description: TEST_TOOL_DESCRIPTION, input_schema: TEST_TOOL_SCHEMA }],
    tool_choice: { type: 'tool', name: TEST_TOOL_NAME },
  };
}

function buildOpenAIToolRequest(): Record<string, unknown> {
  return {
    messages: [{ role: 'user', content: TEST_TOOL_PROMPT }],
    max_tokens: 128,
    tools: [{
      type: 'function',
      function: {
        name: TEST_TOOL_NAME,
        description: TEST_TOOL_DESCRIPTION,
        parameters: TEST_TOOL_SCHEMA,
      },
    }],
    tool_choice: 'auto',
  };
}

function buildTestToolRequest(upstreamMode: string): Record<string, unknown> {
  if (upstreamMode === 'openai-completions' ||
      upstreamMode === 'openai-responses' ||
      upstreamMode === 'gemini-generatecontent' ||
      upstreamMode === 'gemini-interactions') {
    return buildOpenAIToolRequest();
  }

  const request = buildClaudeToolRequest();
  // For anthropic-messages models, default to adaptive thinking so the TUI
  // test exercises the same thinking path real Anthropic traffic uses.
  if (upstreamMode === 'anthropic-messages') {
    request.thinking = { type: 'adaptive' };
  }
  return request;
}

export type DashboardSource = {
  env: Env;
  loadConfig: (forceReload?: boolean) => Promise<ProxyConfig>;
  readOnly: boolean;
};

type Selection =
  | { kind: 'alias'; alias: string }
  | { kind: 'target'; alias: string; target: string }
  | { kind: 'model'; category: string; modelId: string }
  | null;


type ModelChoice = SelectItem & {
  category: string;
  modelId: string;
};

type TestResult = {
  success: boolean;
  modelId: string;
  status?: number;
  error?: string;
  responseBody?: string;
};

function fg(code: number, text: string): string {
  return `\u001b[${code}m${text}\u001b[0m`;
}
function rgbFg(r: number, g: number, b: number, text: string): string {
  return `\u001b[38;2;${r};${g};${b}m${text}\u001b[0m`;
}
function bold(text: string): string { return fg(1, text); }
function dim(text: string): string { return fg(2, text); }
function green(text: string): string { return fg(32, text); }
function yellow(text: string): string { return fg(33, text); }
function red(text: string): string { return fg(31, text); }
function cyan(text: string): string { return fg(36, text); }
function lightWhite(text: string): string { return fg(97, text); }
function lightBlue(text: string): string { return rgbFg(144, 202, 249, text); }  // #90caf9
function mediumBlue(text: string): string { return rgbFg(66, 165, 245, text); }   // #42a5f5
function grey(text: string): string { return fg(90, text); }
function clip(text: string, width: number): string {
  return width <= 0 ? '' : truncateToWidth(text, width, '');
}
function pad(text: string, width: number): string {
  const current = visibleWidth(text);
  if (current >= width) return clip(text, width);
  return text + ' '.repeat(width - current);
}
function alignRight(text: string, width: number): string {
  const current = visibleWidth(text);
  if (current >= width) return clip(text, width);
  return ' '.repeat(width - current) + text;
}
function titleCase(value: string): string {
  return value
    .split(/[_-]/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}
function fmt(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function fmtSeconds(ms: number): string {
  return (ms / 1000).toFixed(2);
}
function stripCompletions(s: string): string {
  return s.replace(/^.*-(completions|messages|generatecontent|interactions|responses)$/, '$1');
}
function stripHttps(s: string): string {
  return s.replace(/^https?:\/\//, '');
}

function frame(title: string, body: string[], width: number): string[] {
  const boxWidth = Math.min(Math.max(width, 10), 88);
  const inner = Math.max(1, boxWidth - 2);
  const lines: string[] = [];
  lines.push(`┌${'─'.repeat(inner)}┐`);
  lines.push(`│${pad(title, inner)}│`);
  for (const line of body) {
    lines.push(`│${pad(line, inner)}│`);
  }
  lines.push(`└${'─'.repeat(inner)}┘`);
  return lines;
}

const SELECT_LIST_THEME: SelectListTheme = {
  selectedPrefix: (text) => green(text),
  selectedText: (text) => green(text),
  description: (text) => dim(text),
  scrollInfo: (text) => dim(text),
  noMatch: (text) => dim(text),
};

class PromptOverlay implements Component, Focusable {
  focused = false;
  private readonly input = new Input();

  constructor(
    private readonly title: string,
    private readonly prompt: string,
    initialValue: string,
    private readonly onSubmit: (value: string) => void,
    private readonly onCancel: () => void,
  ) {
    this.input.setValue(initialValue);
    this.input.onSubmit = (value) => this.onSubmit(value);
    this.input.onEscape = () => this.onCancel();
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    this.input.focused = this.focused;
    const innerWidth = Math.max(1, Math.min(width - 2, 76));
    const bodyWidth = Math.max(1, innerWidth - 2);
    const inputLine = this.input.render(bodyWidth)[0] ?? '';
    return frame(this.title, [clip(this.prompt, bodyWidth), clip(inputLine, bodyWidth), dim('Enter submit  Esc cancel')], innerWidth);
  }
}

class ListOverlay implements Component {
  private readonly list: SelectList;
  private readonly onExtraKey: ((data: string) => boolean) | undefined;

  constructor(
    title: string,
    subtitle: string,
    items: SelectItem[],
    onSelect: (item: SelectItem) => void,
    onCancel: () => void,
    maxVisible = 8,
    onExtraKey?: (data: string) => boolean,
  ) {
    this.list = new SelectList(items, maxVisible, SELECT_LIST_THEME, {
      truncatePrimary: ({ text, maxWidth }) => clip(text, maxWidth),
    });
    this.list.onSelect = onSelect;
    this.list.onCancel = onCancel;
    this.title = title;
    this.subtitle = subtitle;
    this.onExtraKey = onExtraKey;
  }

  private readonly title: string;
  private subtitle: string;

  setSubtitle(subtitle: string): void {
    this.subtitle = subtitle;
    this.invalidate();
  }

  handleInput(data: string): void {
    if (this.onExtraKey && this.onExtraKey(data)) return;
    this.list.handleInput(data);
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, Math.min(width - 2, 76));
    const bodyWidth = Math.max(1, innerWidth - 2);
    const listLines = this.list.render(bodyWidth).map((line) => clip(line, bodyWidth));
    return frame(this.title, [clip(this.subtitle, bodyWidth), ...listLines], innerWidth);
  }
}

class CompositeAliasesOverlay implements Component, Focusable {
  focused = false;
  private snapshot: Awaited<ReturnType<typeof getDashboardSnapshot>> | null = null;
  private message = 'Ready';
  private messageUntil = 0;
  private selectionIndex = 0;

  constructor(private readonly app: DashboardApp) {}

  setSnapshot(snapshot: Awaited<ReturnType<typeof getDashboardSnapshot>> | null): void {
    this.snapshot = snapshot;
    const total = this.selectionCount();
    if (this.selectionIndex >= total) {
      this.selectionIndex = Math.max(0, total - 1);
    }
  }

  setMessage(message: string, holdMs = 0): void {
    this.message = message;
    this.messageUntil = holdMs > 0 ? Date.now() + holdMs : 0;
  }

  focusAlias(alias: string): void {
    const index = this.selections().findIndex((selection) => selection?.kind === 'alias' && selection.alias === alias);
    if (index >= 0) {
      this.selectionIndex = index;
    }
  }

  bumpSelection(delta: number): void {
    const total = this.selectionCount();
    if (total === 0) return;
    this.selectionIndex = Math.max(0, Math.min(total - 1, this.selectionIndex + delta));
  }

  selectCurrent(): Selection {
    return this.selections()[this.selectionIndex] ?? null;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    console.error('[DEBUG] handleInput:', JSON.stringify(data), [...data].map((c) => c.charCodeAt(0)));
    if (matchesKey(data, 'escape')) {
      this.app.closeOverlay();
      return;
    }
    if (matchesKey(data, 'ctrl+c')) {
      this.app.stopAndExit();
      return;
    }
    if (matchesKey(data, 'ctrl+u')) {
      this.app.dumpTokens();
      return;
    }
    if (matchesKey(data, 'r')) {
      void this.app.refresh(false, true);
      return;
    }
    if (matchesKey(data, 'down') || matchesKey(data, 'j')) {
      this.bumpSelection(1);
      this.app.requestRender();
      return;
    }
    if (matchesKey(data, 'up') || matchesKey(data, 'k')) {
      this.bumpSelection(-1);
      this.app.requestRender();
      return;
    }

    const selected = this.selectCurrent();
    if (matchesKey(data, 'a')) {
      this.app.openAddAliasPrompt();
      return;
    }
    if (matchesKey(data, 't') && selected?.kind === 'alias') {
      this.app.openEditAliasLimitPrompt(selected.alias);
      return;
    }
    if (matchesKey(data, 'm')) {
      const alias = selected?.kind === 'alias' ? selected.alias : selected?.kind === 'target' ? selected.alias : undefined;
      if (alias) {
        this.app.openTargetPicker(alias);
      } else {
        this.setMessage('Select an alias first');
        this.app.requestRender();
      }
      return;
    }
    if (matchesKey(data, 'e') && selected?.kind === 'target') {
      this.app.openEditTargetPrompt(selected.alias, selected.target);
      return;
    }
    if (matchesKey(data, 'd') && selected?.kind === 'target') {
      this.app.openDeleteConfirm(selected.alias, selected.target);
      return;
    }
    if (matchesKey(data, 'enter') || matchesKey(data, 'return')) {
      this.setMessage(selected ? `${selected.kind} selected` : '');
      this.app.requestRender();
      return;
    }
  }

  render(width: number): string[] {
    const snap = this.snapshot;
    const lines: string[] = [];
    lines.push(`Esc ${dim('hide panel')}  A ${dim('add alias')} T ${dim('token limit')}  M ${dim('add target')}  E ${dim('edit')}  D ${dim('delete')} ↑↓ ${dim('move')} `);

    if (!snap) {
      return frame('Edit Composite Aliases Config', [...lines, 'Loading…'], width).map((line) => clip(line, width));
    }

    const selections = this.selections();
    const selected = selections[this.selectionIndex] ?? null;
    const composites = Object.entries(snap.config.composite).sort(([a], [b]) => a.localeCompare(b));
    const modelTimingMap = new Map((snap.requestStats.model_timings || []).map((t) => [t.endpoint, t]));
    if (!composites.length) lines.push(dim('  none'));
    for (const [alias, targets] of composites) {
      const selectedAlias = selected?.kind === 'alias' && selected.alias === alias;
      const prefix = selectedAlias ? green('▶') : dim('│');
      const typedTargets = targets as { token_limit?: { num: number; duration: string } } | undefined;
      const aliasLimit = typedTargets?.token_limit;
      const win = snap.compositeLimitWindows?.[alias];
      const windowUsed = win?.accumulator ?? 0;
      const windowDuration = win ? win.duration : (aliasLimit?.duration ?? '');
      const aliasSummary = aliasLimit !== undefined && aliasLimit.num > 0
        ? ` ${dim(fmt(windowUsed))} ${dim('/')} ${dim(fmt(aliasLimit.num))}${dim(' (' + windowDuration + ')')}`
        : '';
      lines.push(`  ${prefix} ${bold(alias)}${aliasSummary}`);
      const entries = Object.entries(targets || {}).filter(([target]) => target !== 'token_limit');
      if (!entries.length) lines.push(`    ${dim('(empty)')}`);
      const targetRouteModel = new Map<string, string | undefined>();
      const resolvedAlias = snap.compositeResolved.find((r) => r.alias === alias);
      if (resolvedAlias) {
        for (const t of resolvedAlias.targets) {
          targetRouteModel.set(t.model, t.routeModel);
        }
      }
      for (const [target, cfg] of entries.sort(sortCompositeTargets)) {
        const selectedTarget = selected?.kind === 'target' && selected.alias === alias && selected.target === target;
        const mark = selectedTarget ? green('▶') : dim('·');
        const typedCfg = cfg as { share?: number; primary?: boolean; fallback?: number } | undefined;
        const summary = `${typedCfg?.share ?? '-'}${typedCfg?.primary ? ' P' : ''}${typedCfg?.fallback === 0 ? ' non-FB' : typedCfg?.fallback !== undefined ? ` FB${typedCfg.fallback}` : ''}`;
        const timingKey = targetRouteModel.get(target) ?? target;
        const timing = modelTimingMap.get(timingKey);
        const timingStr = timing ? ` ${dim('[')}${dim(fmtSeconds(timing.min_time_ms))}${dim('/')}${dim(fmtSeconds(timing.avg_time_ms))}${dim('/')}${dim(fmtSeconds(timing.max_time_ms))}${dim('s]')}` : '';
        lines.push(`  ${dim('│')} ${mark} ${clip(target, 22)} ${dim(summary)}${timingStr}`);
      }
    }

    lines.push('');
    lines.push(this.message ? yellow(this.message) : dim('Ready'));
    return frame('Edit Composite Aliases Config', lines, width).map((line) => clip(line, width));
  }

  private selections(): Selection[] {
    const snap = this.snapshot;
    if (!snap) return [];
    const out: Selection[] = [];
    for (const alias of Object.keys(snap.config.composite).sort()) {
      out.push({ kind: 'alias', alias });
      const targetEntries = Object.entries(snap.config.composite?.[alias] || {});
      for (const [target] of targetEntries.sort(sortCompositeTargets)) {
        out.push({ kind: 'target', alias, target });
      }
    }
    return out;
  }

  private selectionCount(): number {
    return this.selections().length;
  }
}

class DashboardView implements Component {
  private snapshot: Awaited<ReturnType<typeof getDashboardSnapshot>> | null = null;
  private message = 'Ready';
  private messageUntil = 0;
  private lastTime = '';
  private configStatus: 'normal' | 'changed' | 'saved' = 'normal';
  private configStatusTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly app: DashboardApp, private readonly onInvalidate: () => void) {}

  setConfigStatus(status: 'changed' | 'saved'): void {
    this.configStatus = status;
    if (this.configStatusTimer) clearTimeout(this.configStatusTimer);
    // Revert to 'normal' after 3 seconds for 'saved', 5 seconds for 'changed'
    const ms = status === 'saved' ? 3000 : 5000;
    this.configStatusTimer = setTimeout(() => {
      this.configStatus = 'normal';
      this.invalidate();
    }, ms);
    this.invalidate();
  }

  setSnapshot(snapshot: Awaited<ReturnType<typeof getDashboardSnapshot>> | null): void {
    this.snapshot = snapshot;
    this.invalidate();
  }

  setMessage(message: string, holdMs = 0): void {
    this.message = message;
    this.messageUntil = holdMs > 0 ? Date.now() + holdMs : 0;
    this.invalidate();
  }

  shouldPreserveMessage(): boolean {
    return this.messageUntil > Date.now();
  }

  invalidate(): void {
    this.onInvalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'ctrl+c')) {
      this.app.stopAndExit();
      return;
    }
    if (matchesKey(data, 'r')) {
      void this.app.refresh(false, true);
      return;
    }
    if (matchesKey(data, 't') || matchesKey(data, 'shift+t')) {
      void this.app.openTestModelPicker();
      return;
    }
    if (matchesKey(data, 'shift+c') || matchesKey(data, 'c')) {
      this.app.openCompositeAliasesOverlay();
      return;
    }
  }

  render(width: number): string[] {
    const snap = this.snapshot;
    const date = new Date();
    const now = date.toLocaleTimeString('en-US', { hour12: false });
    if (now !== this.lastTime) {
      this.lastTime = now;
    }
    const sec = date.getSeconds();
    const secColors = [lightWhite, lightBlue, mediumBlue];
    const secColor = secColors[sec % 3];
    const hourminTime = this.lastTime.slice(0, -2);
    const secondsTime = secColor(this.lastTime.slice(-2));
    const lines: string[] = [];
    lines.push(bold('Proxy TUI') + dim(`  ${hourminTime}`) + `${secondsTime}`);
    lines.push(dim('─'.repeat(Math.max(0, width))));

    if (!snap) {
      lines.push('Loading…');
      return lines.map((line) => clip(line, width));
    }

    const toolStats = snap.toolStats || [];
    const fixedContentLines = 37; // header(2) + config(1) + heatmap(4) + blank(1) + customModelsHeader(1) + topModels(7) + tools(7) + endpoints(7) + footer(2) + message(1) + blanks(3)
    const termRows = (this.app as unknown as { getTerminalRows: () => number }).getTerminalRows();
    const maxCustomModelRows = Math.max(3, termRows - fixedContentLines);
    let configIndicator: string;
    if (this.configStatus === 'changed') {
      configIndicator = red('(changed)');
    } else if (this.configStatus === 'saved') {
      configIndicator = lightBlue('(saved)');
    } else {
      configIndicator = snap.config.read_only ? yellow('(read-only)') : cyan('(writable)');
    }
    lines.push(`${dim('Config:')} ${dim(snap.config.config_path ?? 'memory')} ${configIndicator}${((snap.config as unknown as { config_errors?: unknown[] }).config_errors?.length ?? 0) > 0 ? red(` (${(snap.config as unknown as { config_errors: unknown[] }).config_errors.length} errors)`) : ''}`);
    const tokenHeatmap = buildHeatmap(snap.tokenHeatmap);
    const heatmapRowFilter = termRows < 40 ? [1, 3, 5] : undefined; // show Mon/Wed/Fri in small terminals
    const tokenHeatmapLines = renderHeatmapPanel(tokenHeatmap, { title: 'Tokens Panel', rowFilter: heatmapRowFilter }).split('\n');
    tokenHeatmapLines[0] = `${bold('Tokens Panel')} (${fmt(tokenHeatmap.totalValues)})`;
    lines.push(...tokenHeatmapLines);
    lines.push('');
    const customModels = this.customModels();
    lines.push(`${bold('Custom Models')} (${fmt(customModels.length)})`);
    const modelTimingMap = new Map((snap.requestStats.model_timings || []).map((t) => [t.endpoint, t]));
    if (!customModels.length) {
      lines.push(dim('  none'));
    } else {
      const shownModels = customModels.slice(0, maxCustomModelRows);
      const hiddenCount = customModels.length - shownModels.length;
      for (const row of shownModels) {
        const tag = row.category === 'composite' ? '[C]' : dim(titleCase(row.category));
        const extra = row.description ? ` ${dim(row.description)}` : '';
        const timing = modelTimingMap.get(row.routeModel ?? row.modelId);
        const timingStr = timing ? ` ${dim('[')}${dim(fmtSeconds(timing.min_time_ms))}${dim('/')}${dim(fmtSeconds(timing.avg_time_ms))}${dim('/')}${dim(fmtSeconds(timing.max_time_ms))}${dim('s]')}` : '';
        lines.push(`  ${dim(row.modelId)} ${tag}${extra}${timingStr}`);
      }
      if (hiddenCount > 0) {
        lines.push(dim(`  ... +${hiddenCount} more. press`) + ' C' + dim(' expand composite'));
      }
    }
    lines.push(`${bold('Top Models')} (${fmt(snap.modelStats.length)})`);
    lines.push(dim(`  ${'model'.padEnd(32)}req   failed | token in    cached    wrote     out     total`));
    for (const row of snap.modelStats.slice(0, 5)) {
      lines.push(
        `  ${(row.model.split('/').pop() || row.model).padEnd(30)}${alignRight(fmt(row.requests), 5)} ${alignRight(fmt(row.failed_requests), 8)}  ${alignRight(fmt(row.input_tokens), 8)}  ${alignRight(fmt(row.cached_tokens), 8)} ${alignRight(fmt(row.cache_written_tokens), 8)} ${alignRight(fmt(row.output_tokens), 8)}  ${alignRight(fmt(row.total_tokens), 8)}`,
      );
    }

    lines.push('');
    lines.push(`${bold('Tools Used')} (${fmt(toolStats.length)})`);
    lines.push(dim(`  ${'tool'.padEnd(32)}in req     in resp     total len`));
    for (const row of toolStats.slice(0, 5)) {
      lines.push(`  ${row.tool_name.padEnd(30)}${alignRight(fmt(row.in_requests), 7)}   ${alignRight(fmt(row.in_responses), 8)}   ${alignRight(fmt(row.in_request_chars), 10)}`);
    }

    lines.push('');
    lines.push(`${bold('Top Endpoints')} (${fmt(snap.requestStats.endpoints.length)})`);
    lines.push(dim(`  ${'endpoint'.padEnd(32)}req   min(s)   avg(s)   max(s)`));
    const endpointRows = new Map(snap.requestStats.endpoints.map((row) => [row.endpoint, row]));
    for (const row of snap.requestStats.endpoint_timings.slice(0, 5)) {
      const requestRow = endpointRows.get(row.endpoint);
      lines.push(
        `  ${row.endpoint.padEnd(30)}${alignRight(fmt(requestRow?.requests ?? 0), 5)} ${alignRight(fmtSeconds(row.min_time_ms), 8)} ${alignRight(fmtSeconds(row.avg_time_ms), 8)} ${alignRight(fmtSeconds(row.max_time_ms), 8)}`,
      );
    }

    lines.push('');
    lines.push(`C ${dim('edit composite')}  T ${dim('test models')}  R ${dim('reload config')}  Ctrl+U ${dim('dump usage')}  Ctrl+C ${dim('quit')}`);
    lines.push(this.message ? yellow(this.message) : dim('Ready'));

    return lines.map((line) => clip(line, width));
  }

  private customModels(): Array<{ category: string; modelId: string; description?: string; routeModel?: string }> {
    const snap = this.snapshot;
    if (!snap) return [];
    const seen = new Set<string>();
    const models: Array<{ category: string; modelId: string; description?: string; routeModel?: string }> = [];

    for (const [category, categoryConfig] of Object.entries(snap.config.models)) {
      for (const [key, value] of Object.entries(categoryConfig || {})) {
        if (key === 'upstream_mode' || key === 'base_url' || key === 'api_key') continue;
        if (value === undefined || seen.has(key)) continue;
        seen.add(key);
        const routeModel = Array.isArray(value) && value.length >= 1 && typeof value[0] === 'string' ? value[0] : undefined;
        models.push({ category, modelId: key, routeModel });
      }
    }

    // Add composite aliases — skip if same name already exists as a model
    if (snap.compositeResolved) {
      for (const alias of snap.compositeResolved) {
        if (seen.has(alias.alias)) continue; // model with same name already added
        seen.add(alias.alias);
        const targets = alias.targets.map((t) => t.model || t.routeModel || '?').join(' · ');
        models.push({ category: 'composite', modelId: alias.alias, description: `(${targets})` });
      }
    }

    // Sort by modelId so composites interleave, not float to the end
    return models.sort((a, b) => a.modelId.localeCompare(b.modelId));
  }
}

class DashboardApp {
  private readonly terminal = new ProcessTerminal();
  private readonly tui = new TUI(this.terminal);
  private readonly view = new DashboardView(this, () => this.scheduleRender());
  private overlay: OverlayHandle | null = null;
  private compositeOverlay: CompositeAliasesOverlay | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private hourlyDumpTimer: ReturnType<typeof setInterval> | null = null;
  private modelTestTimer: ReturnType<typeof setInterval> | null = null;
  private modelTestTimerActive = false;
  private modelTestInProgress = false;
  // Set by togglePeriodicModelTest / stop() to abort an in-flight test-all
  // batch. The for-loop in runAllCustomModelTests checks it between models;
  // the AbortController interrupts the current fetch so the loop doesn't
  // have to wait for it to time out.
  private modelTestAborted = false;
  private modelTestAbortController: AbortController | null = null;
  private lastDumpedTotalTokens = -1;
  private lastRefreshTotalTokens = -1;
  private lastDumpedDate = '';
  private stopped = false;
  private refreshing = false;
  private renderPending = false;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly source: DashboardSource) {}

  async start(): Promise<() => void> {
    this.tui.addChild(this.view);
    this.tui.setFocus(this.view);
    this.tui.addInputListener((data) => {
      if (matchesKey(data, 'ctrl+c')) {
        this.stopAndExit();
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+u')) {
        this.dumpTokens();
        return { consume: true };
      }
      return undefined;
    });
    this.tui.start();
    await this.refresh();
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, 500);
    this.hourlyDumpTimer = setInterval(() => {
      const today = new Date().toISOString().slice(0, 10);
      const dayChanged = today !== this.lastDumpedDate;
      if (!dayChanged && this.lastRefreshTotalTokens === this.lastDumpedTotalTokens) return;
      this.lastDumpedTotalTokens = this.lastRefreshTotalTokens;
      this.lastDumpedDate = today;
      dumpTodayTokens();
      this.view.setMessage(`auto-dumped tokens -> ${TOKEN_LOG_FILE}`);
    }, 60 * 60 * 1000);
    return () => this.stop();
  }

  dumpTokens(): void {
    if (this.lastRefreshTotalTokens === this.lastDumpedTotalTokens) {
      this.view.setMessage('no new tokens to dump');
      this.requestRender();
      return;
    }
    this.lastDumpedTotalTokens = this.lastRefreshTotalTokens;
    this.lastDumpedDate = new Date().toISOString().slice(0, 10);
    dumpTodayTokens();
    this.view.setMessage(`dumped tokens -> ${TOKEN_LOG_FILE}`);
    this.requestRender();
  }

  requestRender(): void {
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.renderPending) return;
    this.renderPending = true;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => {
      this.renderPending = false;
      this.tui.requestRender();
    }, 100);
  }

  async refresh(fromMutation = false, forceReload = false): Promise<void> {
    if (this.refreshing) return;
    if (fromMutation) this.view.setConfigStatus('changed');
    this.refreshing = true;
    try {
      const proxyConfig = await this.source.loadConfig(forceReload);
      const validationErrors = (proxyConfig as unknown as { _validationErrors?: ConfigValidationError[] })._validationErrors;
      const snapshot = getDashboardSnapshot(proxyConfig, this.source.env);
      this.lastRefreshTotalTokens = snapshot.modelStats.reduce((sum, m) => sum + m.total_tokens, 0);
      this.view.setSnapshot(snapshot);
      this.compositeOverlay?.setSnapshot(snapshot);
      if (fromMutation) this.view.setConfigStatus('saved');
      // When this refresh is triggered by a save action, don't override the
      // success message the save flow sets right after this returns. The
      // periodic refresh (fromMutation=false) will still surface any real
      // errors that persist after the save.
      if (fromMutation) {
        // skip message update — save flow will set its own
      } else if (validationErrors && validationErrors.length > 0) {
        const first = validationErrors[0];
        this.view.setMessage(`Config error: ${first.path} — ${first.message}`, 15000);
      } else if (!this.view.shouldPreserveMessage()) {
        this.view.setMessage('Ready');
      }
    } catch (error) {
      this.view.setMessage((error as Error).message);
    } finally {
      this.refreshing = false;
    }
  }

  getTerminalRows(): number {
    return this.tui.terminal.rows;
  }

  openAddAliasPrompt(): void {
    this.openPrompt('Add alias', 'Alias name:', '', async (value) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      addCompositeAliasFromDashboard(this.source.env, trimmed);
      await this.refresh(true);
      this.compositeOverlay?.focusAlias(trimmed);
      this.openTargetPicker(trimmed);
    });
  }

  openCompositeAliasesOverlay(): void {
    if (this.compositeOverlay) {
      if (this.overlay) {
        this.closeOverlay();
      } else {
        this.overlay = this.tui.showOverlay(this.compositeOverlay, { width: '80%', maxHeight: '70%', anchor: 'center' });
        this.compositeOverlay.setSnapshot(this.viewSnapshot());
        this.tui.setFocus(this.compositeOverlay);
        this.requestRender();
      }
      return;
    }
    this.closeOverlay();
    const overlay = new CompositeAliasesOverlay(this);
    this.compositeOverlay = overlay;
    this.overlay = this.tui.showOverlay(overlay, { width: '80%', maxHeight: '70%', anchor: 'center' });
    overlay.setSnapshot(this.viewSnapshot());
    this.tui.setFocus(overlay);
    this.requestRender();
  }

  openEditAliasLimitPrompt(alias: string): void {
    const snapshot = this.viewSnapshot();
    const current = snapshot?.config.composite?.[alias]?.token_limit;
    const defaultValue = current
      ? `${formatTokenLimit(current.num)} ${current.duration}`
      : '';
    this.openPrompt(
      `Token limit for ${alias}`,
      'Format: <num[k|m|b|t]> <1h|1d|1w|1m>  (e.g. 50k 1d, 1.5m 1h, 100000 1w)  blank clears',
      defaultValue,
      async (value) => {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
          upsertCompositeAliasLimitFromDashboard(this.source.env, alias, null);
          await this.refresh(true);
          this.compositeOverlay?.focusAlias(alias);
          this.view.setMessage(`cleared ${alias} token limit`);
          this.requestRender();
          return;
        }
        const parsed = parseHumanTokenLimit(trimmed);
        if (!parsed) {
          this.view.setMessage('Invalid. Use: <num> <1h|1d|1w|1m>  e.g. 50k 1d');
          await this.refresh();
          this.compositeOverlay?.focusAlias(alias);
          this.requestRender();
          return;
        }
        upsertCompositeAliasLimitFromDashboard(this.source.env, alias, trimmed);
        await this.refresh(true);
        this.compositeOverlay?.focusAlias(alias);
        this.view.setMessage(`updated ${alias} token limit: ${formatTokenLimit(parsed.num)} ${parsed.duration}`);
        this.requestRender();
      },
    );
  }

  openTargetPicker(alias: string): void {
    const choices = this.modelChoices();
    if (choices.length === 0) {
      this.view.setMessage('No custom models available');
      this.requestRender();
      return;
    }

    this.hideOverlay();
    const overlay = new ListOverlay(
      `Add target to ${bold(alias)}`,
      `↑/↓ ${dim('move')}  Enter ${dim('select')}  Esc ${dim('cancel')}`,
      choices,
      (item) => {
        this.hideOverlay();
        this.openPrompt(`Add ${item.value} to ${alias}`, 'input <share> <primary> <fallback>', '', async (value) => {
          const parts = value.trim().split(/\s+/).filter(Boolean);
          if (parts.length < 1 || parts.length > 3) {
            this.view.setMessage('Use: share [primary] [fallback]');
            await this.refresh();
            this.compositeOverlay?.focusAlias(alias);
            this.requestRender();
            return;
          }

          const [shareText, primaryText, fallbackText] = parts;
          const share = Number(shareText);
          if (Number.isNaN(share)) {
            this.view.setMessage('Share must be a number');
            await this.refresh();
            this.compositeOverlay?.focusAlias(alias);
            this.requestRender();
            return;
          }

          const parsedPrimary = primaryText === undefined ? undefined : primaryText === 'true' || primaryText === '1' ? true : primaryText === 'false' || primaryText === '0' ? false : null;
          if (parsedPrimary === null) {
            this.view.setMessage('Primary must be true, 1, false, or 0');
            await this.refresh();
            this.compositeOverlay?.focusAlias(alias);
            this.requestRender();
            return;
          }

          const fallback = fallbackText === undefined ? undefined : Number(fallbackText);
          if (fallbackText !== undefined && Number.isNaN(fallback)) {
            this.view.setMessage('Fallback must be a number');
            await this.refresh();
            this.compositeOverlay?.focusAlias(alias);
            this.requestRender();
            return;
          }

          upsertCompositeTargetFromDashboard(this.source.env, alias, item.value, {
            share,
            primary: parsedPrimary === undefined ? undefined : parsedPrimary,
            fallback,
          });
          await this.refresh(true);
          this.compositeOverlay?.focusAlias(alias);
          this.view.setMessage(`added ${item.value} to ${alias}`);
          this.requestRender();
        });
      },
      () => {
        this.hideOverlay();
        this.view.setMessage('add target cancelled');
        this.requestRender();
      },
    );
    this.overlay = this.tui.showOverlay(overlay, { width: '70%', maxHeight: '50%', anchor: 'center' });
    this.overlay.focus();
  }

  openTestModelPicker(): void {
    const choices = this.modelChoices();
    if (choices.length === 0) {
      this.view.setMessage('No custom models available');
      this.requestRender();
      return;
    }

    const subtitle = this.testPickerSubtitle();
    this.hideOverlay();
    const overlay = new ListOverlay(
      'Test custom model',
      subtitle,
      choices,
      (item) => {
        this.hideOverlay();
        void this.runModelTest(item.value as string);
      },
      () => {
        this.hideOverlay();
        this.view.setMessage('test cancelled');
        this.requestRender();
      },
      8,
      (data) => {
        if (matchesKey(data, 'p')) {
          this.togglePeriodicModelTest();
          this.hideOverlay();
          return true;
        }
        return false;
      },
    );
    this.overlay = this.tui.showOverlay(overlay, { width: '70%', maxHeight: '50%', anchor: 'center' });
    this.overlay.focus();
  }

  private testPickerSubtitle(): string {
    const pHint = this.modelTestTimerActive
      ? `P ${dim('stop test timer')}`
      : `P ${dim('test all (30m)')}`;
    return `↑/↓ ${dim('move')}  Enter ${dim('test')}  ${pHint}  Esc ${dim('cancel')}`;
  }

  async runModelTest(modelId: string): Promise<void> {
    const result = await this.executeModelTest(modelId);
    if (!result) return;
    if (!result.ok) {
      this.view.setMessage(`test failed ${result.modelId} (${result.status ?? '?'}) ${result.detail}`, 10000);
    } else {
      this.view.setMessage(`${green(`${result.modelId} OK`)} ${green(`(${result.status})`)} ${green(`usage=${result.usage}`)} ${green(result.detail)}`, 10000);
    }
    this.requestRender();
  }

  // Lower-level test runner. Returns the outcome without touching the message line,
  // so a batch run can compose its own progress display.
  private async executeModelTest(modelId: string): Promise<{
    ok: boolean;
    modelId: string;
    status?: number;
    usage: string;
    detail: string;
  } | null> {
    // Strip [C] suffix if present
    const actualModelId = modelId.endsWith(' [C]') ? modelId.slice(0, -4).trim() : modelId;
    const port = this.source.env.PORT || '8788';
    const endpoint = `http://127.0.0.1:${port}${TEST_ENDPOINT}`;
    const snapshot = this.viewSnapshot();

    // If [C] suffix: test as composite alias (resolve from compositeResolved)
    // If no suffix: test as model (resolve from models.*)
    const modelConfig = snapshot
      ? modelId.endsWith(' [C]')
        ? resolveModelTestConfig(snapshot.config, actualModelId, snapshot.compositeResolved)
        : resolveModelTestConfig(snapshot.config, actualModelId)
      : undefined;

    const upstreamMode = modelConfig?.upstreamMode || 'openai-completions';
    const requestBody = buildTestToolRequest(upstreamMode);
    const testLabel = modelId.endsWith(' [C]')
      ? `${actualModelId} ${modelConfig?.targetUrl ? stripHttps(modelConfig.targetUrl) : '?'}`
      : actualModelId;

    const fullRequestBody = { ...requestBody, model: actualModelId };

    // Debug log test request/response to /tmp/test_model.log (LOG_LEVEL=debug)
    if (process.env.LOG_LEVEL === 'debug') {
      try {
        const fs = await import('fs');
        fs.writeFileSync('/tmp/test_model.log',
          `[${new Date().toISOString()}] test model request (tui)\n` +
          `target: ${endpoint}\n` +
          `upstreamMode: ${upstreamMode}\n` +
          `modelId: ${actualModelId}\n` +
          `request body:\n${JSON.stringify(fullRequestBody, null, 2)}\n`,
        );
      } catch (_e) { /* ignore */ }
    }

    this.modelTestAbortController = new AbortController();
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fullRequestBody),
        signal: this.modelTestAbortController.signal,
      });

      const contentType = response.headers.get('content-type') || '';
      const responseBody = contentType.includes('application/json') ? await response.json() : await response.text();

      // Append response to debug log (LOG_LEVEL=debug)
      if (process.env.LOG_LEVEL === 'debug') {
        try {
          const fs = await import('fs');
          const responseText = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody, null, 2);
          fs.appendFileSync('/tmp/test_model.log',
            `response status: ${response.status}\n` +
            `response body:\n${responseText}\n` +
            `---\n`,
          );
        } catch (_e) { /* ignore */ }
      }
      const usage = typeof responseBody === 'object' && responseBody !== null && 'usage' in responseBody
        ? JSON.stringify((responseBody as Record<string, unknown>).usage ?? {})
        : 'n/a';
      const detailText = formatTestResultDetail(responseBody).split('\n').map((l) => l.length > 60 ? `${l.slice(0, 60)}…` : l).join(' | ');

      return {
        ok: response.ok,
        modelId: testLabel,
        status: response.status,
        usage,
        detail: detailText,
      };
    } catch (error) {
      return {
        ok: false,
        modelId: testLabel,
        usage: 'n/a',
        detail: (error as Error).message,
      };
    } finally {
      this.modelTestAbortController = null;
    }
  }

  // Run a test against every custom model in sequence. Composes a single
  // progress line (`testing 3/12 — code-small...`) that updates per model.
  async runAllCustomModelTests(opts: { announce?: boolean } = {}): Promise<void> {
    if (this.modelTestInProgress) {
      this.view.setMessage('test-all already in progress');
      this.requestRender();
      return;
    }
    const choices = this.modelChoices();
    if (choices.length === 0) {
      this.view.setMessage('No custom models available');
      this.requestRender();
      return;
    }
    this.modelTestInProgress = true;
    this.modelTestAborted = false;
    if (opts.announce) {
      this.view.setMessage(`test-all: starting ${choices.length} models...`);
      this.requestRender();
    }
    let passed = 0;
    let failed = 0;
    for (let i = 0; i < choices.length; i++) {
      if (this.modelTestAborted) break;
      const choice = choices[i];
      this.view.setMessage(`test-all: ${i + 1}/${choices.length} — ${choice.value}...`);
      this.requestRender();
      const result = await this.executeModelTest(choice.value);
      // The abort can land mid-fetch; don't count the interrupted model.
      if (this.modelTestAborted) break;
      if (result?.ok) passed++;
      else failed++;
    }
    if (this.modelTestAborted) {
      this.view.setMessage(`test-all: aborted (${passed} ok / ${failed} failed so far)`, 10000);
    } else {
      const summary = `test-all: ${passed} ok / ${failed} failed / ${choices.length} total`;
      this.view.setMessage(this.modelTestTimerActive ? `${green(summary)} (next in 30m)` : summary, 15000);
    }
    this.requestRender();
    this.modelTestInProgress = false;
  }

  // Toggle a 30-minute recurring test-all loop. `P` flips it on; the first
  // run starts immediately so the user gets feedback right away. Flipping
  // it off also aborts any in-flight batch via the abort flag + controller.
  togglePeriodicModelTest(): void {
    if (this.modelTestTimerActive) {
      if (this.modelTestTimer) clearInterval(this.modelTestTimer);
      this.modelTestTimer = null;
      this.modelTestTimerActive = false;
      this.modelTestAborted = true;
      if (this.modelTestAbortController) this.modelTestAbortController.abort();
      this.view.setMessage('test-all: periodic timer stopped');
      this.requestRender();
      return;
    }
    this.modelTestTimerActive = true;
    this.view.setMessage('test-all: starting (will repeat every 30m)');
    this.requestRender();
    void this.runAllCustomModelTests();
    this.modelTestTimer = setInterval(() => {
      if (this.stopped) return;
      void this.runAllCustomModelTests();
    }, 30 * 60 * 1000);
  }

  openEditTargetPrompt(alias: string, target: string): void {
    this.openPrompt(`Edit ${alias}.${target}`, 'input <share> <primary> <fallback>', '', async (value) => {
      const parts = value.trim().split(/\s+/).filter(Boolean);
      if (parts.length < 1 || parts.length > 3) {
        this.view.setMessage('Use: share [primary] [fallback]');
        await this.refresh();
        return;
      }

      const [shareText, primaryText, fallbackText] = parts;
      const share = Number(shareText);
      if (Number.isNaN(share)) {
        this.view.setMessage('Share must be a number');
        await this.refresh();
        return;
      }

      const parsedPrimary = primaryText === undefined ? undefined : primaryText === 'true' || primaryText === '1' ? true : primaryText === 'false' || primaryText === '0' ? false : null;
      if (parsedPrimary === null) {
        this.view.setMessage('Primary must be true, 1, false, or 0');
        await this.refresh();
        return;
      }

      const fallback = fallbackText === undefined ? undefined : Number(fallbackText);
      if (fallbackText !== undefined && Number.isNaN(fallback)) {
        this.view.setMessage('Fallback must be a number');
        await this.refresh();
        return;
      }

      upsertCompositeTargetFromDashboard(this.source.env, alias, target, {
        share,
        primary: parsedPrimary === undefined ? undefined : parsedPrimary,
        fallback,
      });
      this.view.setMessage(`updated ${alias}.${target}`);
      await this.refresh(true);
    });
  }

  openDeleteConfirm(alias: string, target: string): void {
    this.closeOverlay();
    const overlay = new ListOverlay(
      `Delete ${alias}.${target}?`,
      'Enter confirm  Esc cancel',
      [
        { value: 'yes', label: 'Yes', description: 'Delete target' },
        { value: 'no', label: 'No', description: 'Cancel' },
      ],
      (item) => {
        this.closeOverlay();
        if (item.value === 'yes') {
          removeCompositeTargetFromDashboard(this.source.env, alias, target);
          this.view.setMessage(`deleted ${alias}.${target}`);
          void this.refresh(true);
        } else {
          this.view.setMessage('delete cancelled');
          void this.refresh();
        }
      },
      () => {
        this.closeOverlay();
        this.view.setMessage('delete cancelled');
        this.requestRender();
      },
      2,
    );
    this.overlay = this.tui.showOverlay(overlay, { width: '50%', maxHeight: '30%', anchor: 'center' });
    this.overlay.focus();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    if (this.hourlyDumpTimer) clearInterval(this.hourlyDumpTimer);
    this.hourlyDumpTimer = null;
    if (this.modelTestTimer) clearInterval(this.modelTestTimer);
    this.modelTestTimer = null;
    this.modelTestTimerActive = false;
    this.modelTestAborted = true;
    if (this.modelTestAbortController) this.modelTestAbortController.abort();
    this.closeOverlay();
    this.tui.stop();
  }

  stopAndExit(): void {
    this.stop();
    process.exit(0);
  }

  closeOverlay(): void {
    this.overlay?.hide();
    this.overlay = null;
    this.compositeOverlay = null;
    this.tui.setFocus(this.view);
  }

  private hideOverlay(): void {
    this.overlay?.hide();
    this.overlay = null;
    this.tui.setFocus(this.view);
  }

  private showCompositeOverlay(): void {
    if (!this.compositeOverlay || this.overlay) return;
    this.overlay = this.tui.showOverlay(this.compositeOverlay, { width: '80%', maxHeight: '70%', anchor: 'center' });
    this.compositeOverlay.setSnapshot(this.viewSnapshot());
    this.tui.setFocus(this.compositeOverlay);
  }

  private openPrompt(
    title: string,
    prompt: string,
    initialValue: string,
    onSubmit: (value: string) => Promise<void> | void,
  ): void {
    const restoreCompositeOverlay = this.compositeOverlay !== null;
    this.hideOverlay();
    const overlay = new PromptOverlay(
      title,
      prompt,
      initialValue,
      (value) => {
        void (async () => {
          try {
            this.hideOverlay();
            await onSubmit(value);
            if (restoreCompositeOverlay) {
              this.showCompositeOverlay();
            }
            this.requestRender();
          } catch (error) {
            this.view.setMessage((error as Error).message);
            await this.refresh();
          }
        })();
      },
      () => {
        this.hideOverlay();
        if (restoreCompositeOverlay) {
          this.showCompositeOverlay();
        }
        this.view.setMessage('cancelled');
        this.requestRender();
      },
    );
    this.overlay = this.tui.showOverlay(overlay, { width: '60%', maxHeight: '40%', anchor: 'center' });
    this.overlay.focus();
  }

  private modelChoices(): ModelChoice[] {
    const snapshot = this.viewSnapshot();
    if (!snapshot) return [];
    const seenNames = new Set<string>();
    const choices: ModelChoice[] = [];

    for (const [category, categoryConfig] of Object.entries(snapshot.config.models)) {
      for (const [key, value] of Object.entries(categoryConfig || {})) {
        if (key === 'upstream_mode' || key === 'base_url' || key === 'api_key') continue;
        if (value === undefined || seenNames.has(key)) continue;
        seenNames.add(key);
        const modelUrl = Array.isArray(value) && value.length >= 2 && value[1]
          ? value[1]
          : (categoryConfig.base_url || '-');
        choices.push({
          category,
          modelId: key,
          value: key,
          label: key,
          description: `${titleCase(category)} · ${stripCompletions(categoryConfig.upstream_mode || 'openai-completions')} · ${stripHttps(modelUrl)}`,
        });
      }
    }

    // Add composite aliases — if same name as a model, add with "[C]" suffix to differentiate
    if (snapshot.compositeResolved) {
      for (const alias of snapshot.compositeResolved) {
        const isDuplicate = seenNames.has(alias.alias);
        if (isDuplicate) {
          // Same name already added as a model — add composite with [C] suffix to make value unique
          choices.push({
            category: 'composite',
            modelId: alias.alias,
            value: `${alias.alias} [C]`,
            label: `${alias.alias} [C]`,
            description: `${alias.targets.map((t) => t.model || t.routeModel || '?').join('· ')}`,
          });
        } else {
          seenNames.add(alias.alias);
          const targets = alias.targets.map((t) => t.model || t.routeModel || '?').join('· ');
          choices.push({
            category: 'composite',
            modelId: alias.alias,
            value: alias.alias,
            label: alias.alias,
            description: `${targets}`,
          });
        }
      }
    }

    // Sort by value (which is now unique) — "code-small" < "code-small [C]" since ' ' < '['
    return choices.sort((a, b) => {
      const cmp = a.value.localeCompare(b.value);
      return cmp !== 0 ? cmp : a.label.localeCompare(b.label);
    });
  }

  private viewSnapshot(): Awaited<ReturnType<typeof getDashboardSnapshot>> | null {
    return (this.view as unknown as { snapshot: Awaited<ReturnType<typeof getDashboardSnapshot>> | null }).snapshot;
  }
}

function resolveModelTestConfig(
  config: ProxyConfig,
  modelId: string,
  compositeResolved?: Array<{ alias: string; targets: Array<{ model: string; routeModel?: string; upstreamMode: string; targetUrl: string }> }>,
): { upstreamMode: string; targetUrl: string; apiKey?: string } | undefined {
  // Check composite aliases first
  if (compositeResolved) {
    const alias = compositeResolved.find((a) => a.alias === modelId);
    if (alias && alias.targets.length > 0) {
      const first = alias.targets[0];
      return { upstreamMode: first.upstreamMode, targetUrl: first.targetUrl };
    }
  }

  // Check model configs
  for (const categoryConfig of Object.values(config.models || {})) {
    if (Array.isArray(categoryConfig)) continue;
    for (const [key, value] of Object.entries(categoryConfig || {})) {
      if (key === 'upstream_mode' || key === 'base_url' || key === 'api_key') continue;
      if (value === undefined) continue;
      if (key !== modelId) continue;
      // Check for per-model URL override in tuple [target, baseUrl, apiKey]
      // (dashboard sanitizer strips 3rd element, so accept >= 2)
      if (Array.isArray(value) && value.length >= 2) {
        const modelBaseUrl = value[1] as string | undefined;
        return {
          upstreamMode: categoryConfig.upstream_mode || config.upstream?.upstream_mode || 'openai-completions',
          targetUrl: modelBaseUrl || categoryConfig.base_url || config.upstream?.default_base_url || 'https://api.qnaigc.com',
          apiKey: categoryConfig.api_key || config.upstream?.default_api_key,
        };
      }
      return {
        upstreamMode: categoryConfig.upstream_mode || config.upstream?.upstream_mode || 'openai-completions',
        targetUrl: categoryConfig.base_url || config.upstream?.default_base_url || 'https://api.qnaigc.com',
        apiKey: categoryConfig.api_key || config.upstream?.default_api_key,
      };
    }
  }
  return undefined;
}

export function startTUI(source: DashboardSource): () => void {
  if (!stdin.isTTY || !stdout.isTTY) return () => {};

  const app = new DashboardApp(source);
  void app.start();
  return () => app.stop();
}
