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
  upsertCompositeTargetFromDashboard,
} from './handlers/dashboard.js';
import type { Env } from './types/shared.js';
import type { ProxyConfig } from './utils/config-loader.js';

export type DashboardSource = {
  env: Env;
  loadConfig: () => Promise<ProxyConfig>;
  readOnly: boolean;
};

type Selection =
  | { kind: 'alias'; alias: string }
  | { kind: 'target'; alias: string; target: string }
  | null;


type ModelChoice = SelectItem & {
  category: string;
  modelId: string;
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

class DashboardView implements Component {
  private snapshot: Awaited<ReturnType<typeof getDashboardSnapshot>> | null = null;
  private message = 'Ready';
  private selectionIndex = 0;

  constructor(private readonly app: DashboardApp) {}

  setSnapshot(snapshot: Awaited<ReturnType<typeof getDashboardSnapshot>> | null): void {
    this.snapshot = snapshot;
    const total = this.selectionCount();
    if (this.selectionIndex >= total) {
      this.selectionIndex = Math.max(0, total - 1);
    }
  }

  setMessage(message: string): void {
    this.message = message;
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
    if (matchesKey(data, 'ctrl+c') || matchesKey(data, 'q')) {
      this.app.stopAndExit();
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
    if (matchesKey(data, 't') || matchesKey(data, 'shift+t')) {
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
    lines.push(bold('Proxy TUI') + dim(`  ${new Date().toLocaleTimeString()}`));
    lines.push(dim('─'.repeat(Math.max(0, width))));

    if (!snap) {
      lines.push('Loading…');
      return lines.map((line) => clip(line, width));
    }

    const toolStats = snap.toolStats || [];
    lines.push(`${bold('Config')}: ${snap.config.config_path ?? 'memory'} ${snap.config.read_only ? yellow('(read-only)') : green('(writable)')}`);
    lines.push(`${bold('Models')}: ${fmt(snap.modelStats.length)}  ${bold('Tools')}: ${fmt(toolStats.length)}  ${bold('Requests')}: ${fmt(snap.requestStats.endpoints.length)}`);
    lines.push('');
    lines.push(bold('Composite aliases'));

    const selections = this.selections();
    const selected = selections[this.selectionIndex] ?? null;
    const composites = Object.entries(snap.config.composite).sort(([a], [b]) => a.localeCompare(b));
    if (!composites.length) lines.push(dim('  none'));
    for (const [alias, targets] of composites) {
      const selectedAlias = selected?.kind === 'alias' && selected.alias === alias;
      const prefix = selectedAlias ? green('>') : dim('│');
      lines.push(`  ${prefix} ${bold(alias)}`);
      const entries = Object.entries(targets || {});
      if (!entries.length) lines.push(`    ${dim('(empty)')}`);
      for (const [target, cfg] of entries.sort(([a], [b]) => a.localeCompare(b))) {
        const selectedTarget = selected?.kind === 'target' && selected.alias === alias && selected.target === target;
        const mark = selectedTarget ? green('>') : dim('·');
        const summary = `${cfg.share ?? '-'}${cfg.primary ? ' P' : ''}${cfg.fallback !== undefined ? ` FB${cfg.fallback}` : ''}`;
        lines.push(`  ${dim('│')} ${mark} ${clip(target, 22)} ${dim(summary)}`);
      }
    }

    lines.push('');
    lines.push(bold('Top models'));
    lines.push(dim('  model                         req   failed | token in  cached    wrote    out      total'));
    for (const row of snap.modelStats.slice(0, 5)) {
      lines.push(
        `  ${pad(row.model, 26)}  ${alignRight(fmt(row.requests), 5)} ${alignRight(fmt(row.failed_requests), 8)}  ${alignRight(fmt(row.input_tokens), 8)}  ${alignRight(fmt(row.cached_tokens), 8)} ${alignRight(fmt(row.cache_written_tokens), 8)} ${alignRight(fmt(row.output_tokens), 8)}  ${alignRight(fmt(row.total_tokens), 8)}`,
      );
    }

    lines.push('');
    lines.push(bold('Tool usage'));
    lines.push(dim('  tool                          in req   in resp'));
    for (const row of toolStats.slice(0, 5)) {
      lines.push(`  ${pad(row.tool_name, 30)} ${alignRight(fmt(row.in_requests), 7)} ${alignRight(fmt(row.in_responses), 8)}`);
    }

    lines.push('');
    lines.push(bold('Top endpoints'));
    lines.push(dim('  endpoint                      req  min (ms)  avg (ms)  max (ms)'));
    const endpointRows = new Map(snap.requestStats.endpoints.map((row) => [row.endpoint, row]));
    for (const row of snap.requestStats.endpoint_timings.slice(0, 5)) {
      const requestRow = endpointRows.get(row.endpoint);
      lines.push(
        `  ${pad(row.endpoint, 26)} ${alignRight(fmt(requestRow?.requests ?? 0), 5)} ${alignRight(fmt(row.min_time_ms), 8)} ${alignRight(fmt(row.avg_time_ms), 8)} ${alignRight(fmt(row.max_time_ms), 8)}`,
      );
    }

    lines.push('');
    lines.push(`A ${dim('add alias')} T ${dim('add target')} E ${dim('edit target')} D ${dim('delete')} R ${dim('reload')} Ctrl+C ${dim('quit')} ↑↓ ${dim('move')} Enter ${dim('select')}`);
    lines.push(this.message ? yellow(this.message) : dim('Ready'));

    return lines.map((line) => clip(line, width));
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

class DashboardApp {
  private readonly terminal = new ProcessTerminal();
  private readonly tui = new TUI(this.terminal);
  private readonly view = new DashboardView(this);
  private overlay: OverlayHandle | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly source: DashboardSource) {}

  async start(): Promise<() => void> {
    this.tui.addChild(this.view);
    this.tui.setFocus(this.view);
    this.tui.addInputListener((data) => {
      if (matchesKey(data, 'ctrl+c')) {
        this.stopAndExit();
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
    this.tui.requestRender();
  }

  async refresh(): Promise<void> {
    try {
      const proxyConfig = await this.source.loadConfig();
      this.view.setSnapshot(getDashboardSnapshot(proxyConfig, this.source.env));
      this.view.setMessage('Ready');
      this.tui.requestRender();
    } catch (error) {
      this.view.setMessage((error as Error).message);
      this.tui.requestRender();
    }
  }

  openAddAliasPrompt(): void {
    this.openPrompt('Add alias', 'Alias name:', '', async (value) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      addCompositeAliasFromDashboard(this.source.env, trimmed);
      await this.refresh();
      this.view.focusAlias(trimmed);
      this.openTargetPicker(trimmed);
    });
  }

  openTargetPicker(alias: string): void {
    const choices = this.modelChoices();
    if (choices.length === 0) {
      this.view.setMessage('No custom models available');
      this.requestRender();
      return;
    }

    this.closeOverlay();
    const overlay = new ListOverlay(
      `Add target to ${alias}`,
      '↑/↓ move  Enter select  Esc cancel',
      choices,
      (item) => {
        this.closeOverlay();
        this.openPrompt(`Share for ${item.value}`, 'Blank = equal share', '', async (value) => {
          const trimmed = value.trim();
          const share = trimmed.length > 0 ? Number(trimmed) : undefined;
          if (trimmed.length > 0 && Number.isNaN(share)) {
            this.view.setMessage('Share must be a number or blank');
            await this.refresh();
            this.view.focusAlias(alias);
            this.requestRender();
            return;
          }
          upsertCompositeTargetFromDashboard(this.source.env, alias, item.value, { share });
          await this.refresh();
          this.view.focusAlias(alias);
          this.view.setMessage(`added ${item.value} to ${alias}`);
          this.requestRender();
        });
      },
      () => {
        this.closeOverlay();
        this.view.setMessage('add target cancelled');
        this.requestRender();
      },
    );
    this.overlay = this.tui.showOverlay(overlay, { width: '70%', maxHeight: '50%', anchor: 'center' });
    this.overlay.focus();
  }

  openEditTargetPrompt(alias: string, target: string): void {
    this.openPrompt(`Edit ${alias}.${target}`, 'share fallback primary', '', async (value) => {
      const [share, fallback, primary] = value.split(/\s+/);
      const parsedShare = share ? Number(share) : undefined;
      const parsedFallback = fallback ? Number(fallback) : undefined;
      const parsedPrimary = primary === 'true' ? true : primary === 'false' ? false : undefined;
      if (share && Number.isNaN(parsedShare)) {
        this.view.setMessage('Share must be a number');
        await this.refresh();
        return;
      }
      if (fallback && Number.isNaN(parsedFallback)) {
        this.view.setMessage('Fallback must be a number');
        await this.refresh();
        return;
      }
      upsertCompositeTargetFromDashboard(this.source.env, alias, target, {
        share: parsedShare,
        fallback: parsedFallback,
        primary: parsedPrimary,
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

  private closeOverlay(): void {
    this.overlay?.hide();
    this.overlay = null;
    this.tui.setFocus(this.view);
  }

  private openPrompt(
    title: string,
    prompt: string,
    initialValue: string,
    onSubmit: (value: string) => Promise<void> | void,
  ): void {
    this.closeOverlay();
    const overlay = new PromptOverlay(
      title,
      prompt,
      initialValue,
      (value) => {
        void (async () => {
          try {
            this.closeOverlay();
            await onSubmit(value);
          } catch (error) {
            this.view.setMessage((error as Error).message);
            await this.refresh();
          }
        })();
      },
      () => {
        this.closeOverlay();
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
    const seen = new Set<string>();
    const choices: ModelChoice[] = [];

    for (const [category, categoryConfig] of Object.entries(snapshot.config.models)) {
      for (const [key, value] of Object.entries(categoryConfig || {})) {
        if (key === 'upstream_mode' || key === 'base_url' || key === 'api_key') continue;
        if (value === undefined || seen.has(key)) continue;
        seen.add(key);
        choices.push({
          category,
          modelId: key,
          value: key,
          label: key,
          description: titleCase(category),
        });
      }
    }

    return choices.sort((a, b) => a.modelId.localeCompare(b.modelId));
  }

  private viewSnapshot(): Awaited<ReturnType<typeof getDashboardSnapshot>> | null {
    return (this.view as unknown as { snapshot: Awaited<ReturnType<typeof getDashboardSnapshot>> | null }).snapshot;
  }
}

export function startTUI(source: DashboardSource): () => void {
  if (!stdin.isTTY || !stdout.isTTY) return () => {};

  const app = new DashboardApp(source);
  void app.start();
  return () => app.stop();
}
