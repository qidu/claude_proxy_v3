import { stdin, stdout } from 'process';
import { addCompositeAliasFromDashboard, getDashboardSnapshot, removeCompositeTargetFromDashboard, upsertCompositeTargetFromDashboard } from './handlers/dashboard.js';
import type { Env } from './types/shared.js';
import type { ProxyConfig } from './utils/config-loader.js';

export type DashboardSource = {
  env: Env;
  loadConfig: () => Promise<ProxyConfig>;
  readOnly: boolean;
};

type InputMode = 'normal' | 'add-alias' | 'pick-target' | 'share-target' | 'edit-target' | 'confirm-delete';

type Selection =
  | { kind: 'alias'; alias: string }
  | { kind: 'target'; alias: string; target: string }
  | null;

type ModelChoice = {
  category: string;
  model: string;
  label: string;
};

function ansi(code: number): string {
  return `\u001b[${code}m`;
}
function reset(): string { return ansi(0); }
function bold(s: string): string { return `${ansi(1)}${s}${reset()}`; }
function dim(s: string): string { return `${ansi(2)}${s}${reset()}`; }
function green(s: string): string { return `${ansi(32)}${s}${reset()}`; }
function yellow(s: string): string { return `${ansi(33)}${s}${reset()}`; }
function cyan(s: string): string { return `${ansi(36)}${s}${reset()}`; }
function clear(): string { return '\u001b[2J\u001b[H'; }
function hideCursor(): string { return '\u001b[?25l'; }
function showCursor(): string { return '\u001b[?25h'; }
function stripAnsi(value: string): string { return value.replace(/\u001b\[[0-9;]*m/g, ''); }
function truncate(value: string, width: number): string {
  if (width <= 0) return '';
  const clean = stripAnsi(value);
  if (clean.length <= width) return value;
  return clean.slice(0, Math.max(0, width - 1)) + '…';
}
function pad(value: string, width: number): string {
  const clean = stripAnsi(value);
  if (clean.length >= width) return truncate(value, width);
  return value + ' '.repeat(width - clean.length);
}
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
function getWidth(): number {
  return Math.max(80, stdout.columns || 80);
}
function titleCase(value: string): string {
  return value
    .split(/[_-]/g)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(' ');
}

class BufferLine {
  private buf = '';
  constructor(private onSubmit: (value: string) => void) {}
  input(ch: string): void {
    if (ch === '\r' || ch === '\n') {
      this.onSubmit(this.buf.trim());
      this.buf = '';
      return;
    }
    if (ch === '\x7f') {
      this.buf = this.buf.slice(0, -1);
      return;
    }
    if (ch >= ' ' && ch <= '~') {
      this.buf += ch;
    }
  }
  text(): string { return this.buf; }
}

class ModelPicker {
  private index = 0;
  done = false;
  selectedValue = '';

  constructor(private choices: ModelChoice[]) {}

  handleInput(data: string): void {
    if (this.done) return;

    if (data === '\u001b' || data === '\x03') {
      this.done = true;
      this.selectedValue = '';
      return;
    }

    if (data === '\r' || data === '\n') {
      const choice = this.choices[this.index];
      if (choice) {
        this.selectedValue = choice.model;
        this.done = true;
      }
      return;
    }

    if (data === 'ArrowUp' || data === 'k') {
      if (this.index > 0) this.index -= 1;
      return;
    }

    if (data === 'ArrowDown' || data === 'j') {
      if (this.index < this.choices.length - 1) this.index += 1;
    }
  }

  render(width: number): string[] {
    const boxWidth = Math.min(76, Math.max(50, width - 6));
    const leftPad = Math.max(0, Math.floor((width - boxWidth) / 2));
    const inner = boxWidth - 2;
    const lines: string[] = [];
    const entries = this.choices.slice(this.index - 4 < 0 ? 0 : this.index - 4, this.index + 5);

    lines.push('');
    lines.push(' '.repeat(leftPad) + bold('┌' + '─'.repeat(inner - 2) + '┐'));
    lines.push(' '.repeat(leftPad) + '│' + pad(` ${bold('Select target model')} `, inner) + '│');
    lines.push(' '.repeat(leftPad) + '├' + '─'.repeat(inner - 2) + '┤');
    lines.push(' '.repeat(leftPad) + '│' + pad(dim(' ↑/↓ move   Enter select   Esc cancel '), inner) + '│');
    lines.push(' '.repeat(leftPad) + '├' + '─'.repeat(inner - 2) + '┤');

    if (entries.length === 0) {
      lines.push(' '.repeat(leftPad) + '│' + pad(dim(' No custom models available '), inner) + '│');
    } else {
      for (const choice of entries) {
        const selected = this.choices[this.index] === choice;
        const marker = selected ? green('>') : dim('│');
        const text = `${marker} ${choice.label}`;
        lines.push(' '.repeat(leftPad) + '│' + pad(selected ? green(text) : text, inner) + '│');
      }
    }

    lines.push(' '.repeat(leftPad) + bold('└' + '─'.repeat(inner - 2) + '┘'));
    return lines;
  }
}

export function startTUI(source: DashboardSource): () => void {
  if (!stdin.isTTY || !stdout.isTTY) return () => {};

  const state = {
    snapshot: null as Awaited<ReturnType<typeof getDashboardSnapshot>> | null,
    selectionIndex: 0,
    inputMode: 'normal' as InputMode,
    pendingDelete: null as Selection,
    pendingTargetModel: '',
    input: new BufferLine(() => {}),
    picker: null as ModelPicker | null,
    message: '',
    stop: false,
  };

  const aliasOrder = () => (state.snapshot ? Object.keys(state.snapshot.config.composite).sort() : []);
  const targetList = (alias: string) => Object.keys(state.snapshot?.config.composite?.[alias] || {}).sort();
  const selections = (): Selection[] => {
    const out: Selection[] = [];
    for (const alias of aliasOrder()) {
      out.push({ kind: 'alias', alias });
      for (const target of targetList(alias)) out.push({ kind: 'target', alias, target });
    }
    return out;
  };
  const modelChoices = (): ModelChoice[] => {
    const snap = state.snapshot;
    if (!snap) return [];
    const seen = new Set<string>();
    const choices: ModelChoice[] = [];

    for (const [category, categoryConfig] of Object.entries(snap.config.models)) {
      for (const [key, value] of Object.entries(categoryConfig || {})) {
        if (key === 'upstream_mode' || key === 'base_url' || key === 'api_key') continue;
        if (value === undefined || seen.has(key)) continue;
        seen.add(key);
        choices.push({ category, model: key, label: `${key}  ${dim(`(${titleCase(category)})`)}` });
      }
    }

    return choices.sort((a, b) => a.model.localeCompare(b.model));
  };

  const render = (): void => {
    const width = getWidth();
    const snap = state.snapshot;
    const sels = selections();
    const sel = sels[state.selectionIndex] ?? null;
    const lines: string[] = [];

    lines.push(bold('Proxy TUI') + dim(`  ${new Date().toLocaleTimeString()}`));
    lines.push(dim('─'.repeat(width)));

    if (!snap) {
      lines.push('Loading…');
    } else {
      lines.push(`${bold('Config')}: ${snap.config.config_path ?? 'memory'} ${snap.config.read_only ? yellow('(read-only)') : green('(writable)')}`);
      lines.push(`${bold('Models')}: ${fmt(snap.modelStats.length)}  ${bold('Agents')}: ${fmt(snap.agentStats.length)}  ${bold('Requests')}: ${fmt(snap.requestStats.endpoints.length)}`);
      lines.push('');
      lines.push(bold('Composite aliases'));
      const composites = Object.entries(snap.config.composite).sort(([a], [b]) => a.localeCompare(b));
      if (!composites.length) lines.push(dim('  none'));
      for (const [alias, targets] of composites) {
        const selectedAlias = sel?.kind === 'alias' && sel.alias === alias;
        const prefix = selectedAlias ? green('>') : dim('│');
        lines.push(`  ${prefix} ${bold(alias)}`);
        const entries = Object.entries(targets || {});
        if (!entries.length) lines.push(`    ${dim('(empty)')}`);
        for (const [target, cfg] of entries.sort(([a], [b]) => a.localeCompare(b))) {
          const selectedTarget = sel?.kind === 'target' && sel.alias === alias && sel.target === target;
          const mark = selectedTarget ? cyan('>') : dim('·');
          const summary = `${cfg.share ?? '-'}${cfg.primary ? ' *' : ''}${cfg.fallback !== undefined ? ` f${cfg.fallback}` : ''}`;
          lines.push(`    ${mark} ${truncate(target, 22)} ${dim(summary)}`);
        }
      }

      lines.push('');
      lines.push(bold('Top models'));
      lines.push(dim('  model                       req   failed   in       cached   wrote    out      total'));
      for (const row of snap.modelStats.slice(0, 5)) {
        lines.push(
          `  ${pad(row.model, 26)} ${pad(fmt(row.requests), 5)} ${pad(fmt(row.failed_requests), 8)} ${pad(fmt(row.input_tokens), 8)} ${pad(fmt(row.cached_tokens), 8)} ${pad(fmt(row.cache_written_tokens), 8)} ${pad(fmt(row.output_tokens), 8)} ${pad(fmt(row.total_tokens), 8)}`,
        );
      }

      lines.push('');
      lines.push(bold('Top endpoints'));
      for (const row of snap.requestStats.endpoints.slice(0, 5)) lines.push(`  ${pad(row.endpoint, 26)} ${fmt(row.requests)} req`);

      lines.push('');
      lines.push(bold('Top agents'));
      for (const row of snap.agentStats.slice(0, 5)) lines.push(`  ${pad(row.key, 26)} ${fmt(row.requests)} req`);

      lines.push('');
      lines.push(dim('A add alias  T add target  E edit target  D delete  R reload  Ctrl+C quit  ↑↓ move  Enter select'));
      lines.push(state.message ? yellow(state.message) : dim('Ready'));
      if (state.inputMode !== 'normal') lines.push(dim(`Input: ${state.input.text()}`));

      if (state.inputMode === 'pick-target' && state.picker) {
        lines.push(...state.picker.render(width));
      } else if (state.inputMode === 'share-target' || state.inputMode === 'edit-target' || state.inputMode === 'add-alias' || state.inputMode === 'confirm-delete') {
        lines.push('');
        const prompt =
          state.inputMode === 'share-target'
            ? `Share for ${state.pendingTargetModel} (blank = equal):`
            : state.inputMode === 'edit-target'
              ? `Edit target ${sel?.kind === 'target' ? `${sel.alias}.${sel.target}` : ''} (share fallback primary):`
              : state.inputMode === 'confirm-delete'
                ? `Delete ${sel?.kind === 'target' ? `${sel.alias}.${sel.target}` : ''}? y/n`
                : 'Alias name:';
        lines.push(dim(prompt));
      }
    }

    stdout.write(clear() + hideCursor() + lines.map((line) => truncate(line, width)).join('\n'));
  };

  const refresh = async (): Promise<void> => {
    state.snapshot = getDashboardSnapshot(await source.loadConfig(), source.env);
    if (state.selectionIndex >= selections().length) state.selectionIndex = Math.max(0, selections().length - 1);
    render();
  };

  const ask = (mode: InputMode, action: (value: string) => Promise<void> | void): void => {
    state.inputMode = mode;
    state.input = new BufferLine(async (value) => {
      try {
        await action(value);
      } catch (err) {
        state.message = (err as Error).message;
      }
      state.inputMode = 'normal';
      state.pendingDelete = null;
      state.pendingTargetModel = '';
      await refresh();
    });
  };

  const startTargetPicker = (): void => {
    const choices = modelChoices();
    state.picker = new ModelPicker(choices);
    state.inputMode = 'pick-target';
    render();
  };

  const handleKey = async (key: string): Promise<void> => {
    if (state.inputMode === 'pick-target' && state.picker) {
      state.picker.handleInput(key);
      if (state.picker.done) {
        const selected = state.picker.selectedValue;
        state.picker = null;
        if (!selected) {
          state.inputMode = 'normal';
          render();
          return;
        }
        state.pendingTargetModel = selected;
        ask('share-target', async (value) => {
          const trimmed = value.trim();
          const share = trimmed.length > 0 ? Number(trimmed) : undefined;
          if (trimmed.length > 0 && Number.isNaN(share)) {
            throw new Error('Share must be a number or blank');
          }
          const selectedAlias = selections()[state.selectionIndex];
          if (!selectedAlias || selectedAlias.kind !== 'alias') {
            throw new Error('Select an alias first');
          }
          upsertCompositeTargetFromDashboard(source.env, selectedAlias.alias, state.pendingTargetModel, {
            share,
          });
          state.message = `added ${state.pendingTargetModel} to ${selectedAlias.alias}`;
        });
      }
      render();
      return;
    }

    if (state.inputMode !== 'normal') {
      state.input.input(key);
      render();
      return;
    }

    const sels = selections();
    const sel = sels[state.selectionIndex] ?? null;
    if (key === '\u0003' || key === 'q') { stop(); return; }
    if (key === 'r') { await refresh(); return; }
    if (key === 'ArrowDown' || key === 'j') { state.selectionIndex = Math.min(sels.length - 1, state.selectionIndex + 1); render(); return; }
    if (key === 'ArrowUp' || key === 'k') { state.selectionIndex = Math.max(0, state.selectionIndex - 1); render(); return; }
    if (key === 'a') {
      ask('add-alias', async (value) => {
        if (!value) return;
        addCompositeAliasFromDashboard(source.env, value);
        state.message = `added alias ${value}`;
      });
      render();
      return;
    }
    if (key === 't' && sel?.kind === 'alias') {
      startTargetPicker();
      return;
    }
    if (key === 'e' && sel?.kind === 'target') {
      ask('edit-target', async (value) => {
        const [share, fallback, primary] = value.split(/\s+/);
        const parsedShare = share ? Number(share) : undefined;
        const parsedFallback = fallback ? Number(fallback) : undefined;
        const parsedPrimary = primary === 'true' ? true : primary === 'false' ? false : undefined;
        if (share && Number.isNaN(parsedShare)) throw new Error('Share must be a number');
        if (fallback && Number.isNaN(parsedFallback)) throw new Error('Fallback must be a number');
        upsertCompositeTargetFromDashboard(source.env, sel.alias, sel.target, {
          share: parsedShare,
          fallback: parsedFallback,
          primary: parsedPrimary,
        });
        state.message = `updated ${sel.alias}.${sel.target}`;
      });
      render();
      return;
    }
    if (key === 'd' && sel?.kind === 'target') {
      state.pendingDelete = sel;
      ask('confirm-delete', async (value) => {
        if (value.toLowerCase() !== 'y' && value.toLowerCase() !== 'yes') {
          state.message = 'delete cancelled';
          return;
        }
        removeCompositeTargetFromDashboard(source.env, sel.alias, sel.target);
        state.message = `deleted ${sel.alias}.${sel.target}`;
      });
      render();
      return;
    }
    if (key === '\r' || key === '\n') { state.message = sel ? `${sel.kind} selected` : ''; render(); return; }
  };

  const onData = (buf: Buffer): void => {
    const s = buf.toString('utf8');
    if (s === '\u001b[A') { void handleKey('ArrowUp'); return; }
    if (s === '\u001b[B') { void handleKey('ArrowDown'); return; }
    for (const ch of s) void handleKey(ch);
  };

  const stop = (): void => {
    state.stop = true;
    stdin.off('data', onData);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdout.write(showCursor() + reset() + '\n');
  };

  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', onData);
  void refresh();
  const timer = setInterval(() => { if (!state.stop) void refresh(); }, 1500);
  return () => { clearInterval(timer); stop(); };
}
