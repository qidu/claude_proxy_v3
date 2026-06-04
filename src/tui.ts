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
} from '@mariozechner/pi-tui';
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
import type { ProxyConfig } from './utils/config-loader.js';

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
    max_tokens: 16,
    tools: [{ name: TEST_TOOL_NAME, description: TEST_TOOL_DESCRIPTION, input_schema: TEST_TOOL_SCHEMA }],
    tool_choice: { type: 'tool', name: TEST_TOOL_NAME },
  };
}

function buildOpenAIToolRequest(): Record<string, unknown> {
  return {
    messages: [{ role: 'user', content: TEST_TOOL_PROMPT }],
    max_tokens: 16,
    tools: [{
      type: 'function',
      function: {
        name: TEST_TOOL_NAME,
        description: TEST_TOOL_DESCRIPTION,
        parameters: TEST_TOOL_SCHEMA,
      },
    }],
    tool_choice: { type: 'function', function: { name: TEST_TOOL_NAME } },
  };
}

function buildTestToolRequest(upstreamMode: string): Record<string, unknown> {
  if (upstreamMode === 'openai-completions') {
    return buildOpenAIToolRequest();
  }

  return buildClaudeToolRequest();
}

export type DashboardSource = {
  env: Env;
  loadConfig: () => Promise<ProxyConfig>;
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
function bold(text: string): string { return fg(1, text); }
function dim(text: string): string { return fg(2, text); }
function green(text: string): string { return fg(32, text); }
function yellow(text: string): string { return fg(33, text); }
function cyan(text: string): string { return fg(36, text); }
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

  constructor(
    title: string,
    subtitle: string,
    items: SelectItem[],
    onSelect: (item: SelectItem) => void,
    onCancel: () => void,
    maxVisible = 8,
  ) {
    this.list = new SelectList(items, maxVisible, SELECT_LIST_THEME, {
      truncatePrimary: ({ text, maxWidth }) => clip(text, maxWidth),
    });
    this.list.onSelect = onSelect;
    this.list.onCancel = onCancel;
    this.title = title;
    this.subtitle = subtitle;
  }

  private readonly title: string;
  private readonly subtitle: string;

  handleInput(data: string): void {
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
    if (matchesKey(data, 'ctrl+o')) {
      dumpTodayTokens();
      this.setMessage(`dumped tokens -> ${TOKEN_LOG_FILE}`);
      this.app.requestRender();
      return;
    }
    if (matchesKey(data, 'r')) {
      void this.app.refresh();
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
    if (!composites.length) lines.push(dim('  none'));
    for (const [alias, targets] of composites) {
      const selectedAlias = selected?.kind === 'alias' && selected.alias === alias;
      const prefix = selectedAlias ? green('>') : dim('│');
      const typedTargets = targets as { total_token_limit?: number } | undefined;
      const aliasLimit = typedTargets?.total_token_limit;
      const resolvedAlias = snap.compositeResolved.find((r) => r.alias === alias);
      const totalUsed = resolvedAlias?.targets.reduce((sum, t) => {
        const statKey = t.routeModel || t.model;
        const entry = snap.modelStats.find((m) => m.model === statKey);
        return sum + (entry?.total_tokens ?? 0);
      }, 0) ?? 0;
      const aliasSummary = aliasLimit !== undefined
        ? ` ${dim(fmt(totalUsed))} ${dim('/')} ${dim(fmt(aliasLimit))}${dim(' (Limit)')}`
        : '';
      lines.push(`  ${prefix} ${bold(alias)}${aliasSummary}`);
      const entries = Object.entries(targets || {}).filter(([target]) => target !== 'total_token_limit');
      if (!entries.length) lines.push(`    ${dim('(empty)')}`);
      for (const [target, cfg] of entries.sort(([a], [b]) => a.localeCompare(b))) {
        const selectedTarget = selected?.kind === 'target' && selected.alias === alias && selected.target === target;
        const mark = selectedTarget ? green('>') : dim('·');
        const typedCfg = cfg as { share?: number; primary?: boolean; fallback?: number } | undefined;
        const summary = `${typedCfg?.share ?? '-'}${typedCfg?.primary ? ' P' : ''}${typedCfg?.fallback === 0 ? ' non-FB' : typedCfg?.fallback !== undefined ? ` FB${typedCfg.fallback}` : ''}`;
        lines.push(`  ${dim('│')} ${mark} ${clip(target, 22)} ${dim(summary)}`);
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
      for (const target of Object.keys(snap.config.composite?.[alias] || {}).sort()) {
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

  constructor(private readonly app: DashboardApp, private readonly onInvalidate: () => void) {}

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
      void this.app.refresh();
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
    const now = new Date().toLocaleTimeString();
    if (now !== this.lastTime) {
      this.lastTime = now;
    }
    const lines: string[] = [];
    lines.push(bold('Proxy TUI') + dim(`  ${this.lastTime}`));
    lines.push(dim('─'.repeat(Math.max(0, width))));

    if (!snap) {
      lines.push('Loading…');
      return lines.map((line) => clip(line, width));
    }

    const toolStats = snap.toolStats || [];
    lines.push(`${dim('Config:')} ${dim(snap.config.config_path ?? 'memory')} ${snap.config.read_only ? yellow('(read-only)') : green('(writable)')}`);
    const tokenHeatmap = buildHeatmap(snap.tokenHeatmap);
    const tokenHeatmapLines = renderHeatmapPanel(tokenHeatmap, { title: 'Tokens Panel' }).split('\n');
    tokenHeatmapLines[0] = `${bold('Tokens Panel')} (${fmt(tokenHeatmap.totalValues)})`;
    lines.push(...tokenHeatmapLines);
    lines.push('');
    lines.push(bold('Custom Models'));
    const customModels = this.customModels();
    if (!customModels.length) {
      lines.push(dim('  none'));
    } else {
      for (const row of customModels) {
        const tag = row.category === 'composite' ? bold('[C]') : dim(titleCase(row.category));
        const extra = row.description ? ` ${dim(row.description)}` : '';
        lines.push(`  ${dim(row.modelId)} ${tag}${extra}`);
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
    lines.push(`C ${dim('config composite aliases')}  T ${dim('test models')}  R ${dim('reload config')}  Ctrl+O ${dim('dump data')}  Ctrl+C ${dim('quit')}`);
    lines.push(this.message ? yellow(this.message) : dim('Ready'));

    return lines.map((line) => clip(line, width));
  }

  private customModels(): Array<{ category: string; modelId: string; description?: string }> {
    const snap = this.snapshot;
    if (!snap) return [];
    const seen = new Set<string>();
    const models: Array<{ category: string; modelId: string; description?: string }> = [];

    for (const [category, categoryConfig] of Object.entries(snap.config.models)) {
      for (const [key, value] of Object.entries(categoryConfig || {})) {
        if (key === 'upstream_mode' || key === 'base_url' || key === 'api_key') continue;
        if (value === undefined || seen.has(key)) continue;
        seen.add(key);
        models.push({ category, modelId: key });
      }
    }

    // Add composite aliases — skip if same name already exists as a model
    if (snap.compositeResolved) {
      for (const alias of snap.compositeResolved) {
        if (seen.has(alias.alias)) continue; // model with same name already added
        seen.add(alias.alias);
        const targets = alias.targets.map((t) => t.model || t.routeModel || '?').join(', ');
        models.push({ category: 'composite', modelId: alias.alias, description: targets });
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
      if (matchesKey(data, 'ctrl+o')) {
        dumpTodayTokens();
        this.view.setMessage(`dumped tokens -> ${TOKEN_LOG_FILE}`);
        return { consume: true };
      }
      return undefined;
    });
    this.tui.start();
    await this.refresh();
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, 1500);
    return () => this.stop();
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

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const proxyConfig = await this.source.loadConfig();
      const snapshot = getDashboardSnapshot(proxyConfig, this.source.env);
      this.view.setSnapshot(snapshot);
      this.compositeOverlay?.setSnapshot(snapshot);
      if (!this.view.shouldPreserveMessage()) {
        this.view.setMessage('Ready');
      }
    } catch (error) {
      this.view.setMessage((error as Error).message);
    } finally {
      this.refreshing = false;
    }
  }

  openAddAliasPrompt(): void {
    this.openPrompt('Add alias', 'Alias name:', '', async (value) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      addCompositeAliasFromDashboard(this.source.env, trimmed);
      await this.refresh();
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
    const current = snapshot?.config.composite?.[alias]?.total_token_limit;
    this.openPrompt(
      `Total token limit for ${alias}`,
      'Blank clears the alias-level token limit',
      current === undefined ? '' : String(current),
      async (value) => {
        const trimmed = value.trim();
        if (trimmed.length > 0 && Number.isNaN(Number(trimmed))) {
          this.view.setMessage('Total token limit must be a number or blank');
          await this.refresh();
          this.compositeOverlay?.focusAlias(alias);
          this.requestRender();
          return;
        }
        upsertCompositeAliasLimitFromDashboard(this.source.env, alias, trimmed.length > 0 ? Number(trimmed) : null);
        await this.refresh();
        this.compositeOverlay?.focusAlias(alias);
        this.view.setMessage(`updated ${alias} total token limit`);
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
          await this.refresh();
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

    this.hideOverlay();
    const overlay = new ListOverlay(
      'Test custom model',
      `↑/↓ ${dim('move')}  Enter ${dim('test')}  Esc ${dim('cancel')}`,
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
    );
    this.overlay = this.tui.showOverlay(overlay, { width: '70%', maxHeight: '50%', anchor: 'center' });
    this.overlay.focus();
  }

  async runModelTest(modelId: string): Promise<void> {
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
      ? `${actualModelId} → ${modelConfig?.targetUrl ? stripHttps(modelConfig.targetUrl) : '?'}`
      : actualModelId;

    this.view.setMessage(`testing ${testLabel}...`, 30000);
    this.requestRender();

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...requestBody, model: actualModelId }),
      });

      const contentType = response.headers.get('content-type') || '';
      const responseBody = contentType.includes('application/json') ? await response.json() : await response.text();
      const usage = typeof responseBody === 'object' && responseBody !== null && 'usage' in responseBody
        ? JSON.stringify((responseBody as Record<string, unknown>).usage ?? {})
        : 'n/a';
      const detailText = formatTestResultDetail(responseBody).split('\n').map((l) => l.length > 60 ? `${l.slice(0, 60)}…` : l).join(' | ');

      if (!response.ok) {
        this.view.setMessage(`test failed ${actualModelId} (${response.status}) ${detailText}`, 10000);
        this.requestRender();
        return;
      }

      const statusLine = `${green(`OK ${actualModelId}`)} ${green(`(${response.status})`)} ${green(`usage=${usage}`)}`;
      this.view.setMessage(`${statusLine} ${green(detailText)}`, 10000);
      this.requestRender();
    } catch (error) {
      this.view.setMessage(`test failed ${actualModelId} ${(error as Error).message}`, 10000);
      this.requestRender();
    }
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
      await this.refresh();
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
        } else {
          this.view.setMessage('delete cancelled');
        }
        void this.refresh();
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
        choices.push({
          category,
          modelId: key,
          value: key,
          label: key,
          description: `${titleCase(category)} · ${stripCompletions(categoryConfig.upstream_mode || 'openai-completions')} · ${stripHttps(categoryConfig.base_url || '-')}`,
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
            description: `→ ${alias.targets.map((t) => t.model || t.routeModel || '?').join(', ')}`,
          });
        } else {
          seenNames.add(alias.alias);
          const targets = alias.targets.map((t) => t.model || t.routeModel || '?').join(', ');
          choices.push({
            category: 'composite',
            modelId: alias.alias,
            value: alias.alias,
            label: alias.alias,
            description: `→ ${targets}`,
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
