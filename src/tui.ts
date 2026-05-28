import { stdin, stdout } from 'process';
import { getDashboardSnapshot, addCompositeAliasFromDashboard, removeCompositeAliasFromDashboard, removeCompositeTargetFromDashboard, upsertCompositeTargetFromDashboard } from './handlers/dashboard.js';
import type { Env } from './types/shared.js';
import type { ProxyConfig } from './utils/config-loader.js';

export type DashboardSource = {
  env: Env;
  loadConfig: () => Promise<ProxyConfig>;
  readOnly: boolean;
};

type InputMode = 'normal' | 'add-alias' | 'add-target' | 'edit-target' | 'confirm';

type Selection =
  | { kind: 'alias'; alias: string }
  | { kind: 'target'; alias: string; target: string }
  | null;

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

export function startTUI(source: DashboardSource): () => void {
  if (!stdin.isTTY || !stdout.isTTY) return () => {};

  const state = {
    snapshot: null as Awaited<ReturnType<typeof getDashboardSnapshot>> | null,
    selectionIndex: 0,
    inputMode: 'normal' as InputMode,
    pendingDelete: null as Selection,
    input: new BufferLine(() => {}),
    message: '',
    stop: false,
  };

  const aliasOrder = () => state.snapshot?.config.composite ? Object.keys(state.snapshot.config.composite).sort() : [];
  const targetList = (alias: string) => Object.keys(state.snapshot?.config.composite?.[alias] || {}).sort();
  const selections = (): Selection[] => {
    const out: Selection[] = [];
    for (const alias of aliasOrder()) {
      out.push({ kind: 'alias', alias });
      for (const target of targetList(alias)) out.push({ kind: 'target', alias, target });
    }
    return out;
  };

  const render = (): void => {
    const width = getWidth();
    const snap = state.snapshot;
    const sels = selections();
    const sel = sels[state.selectionIndex] ?? null;
    const lines: string[] = [];
    lines.push(bold(`Proxy TUI`) + dim(`  ${new Date().toLocaleTimeString()}`));
    lines.push(dim('─'.repeat(width)));
    if (!snap) {
      lines.push('Loading…');
    } else {
      lines.push(`${bold('Config')}: ${snap.config.config_path ?? 'memory'} ${snap.config.read_only ? yellow('(read-only)') : green('(writable)')}`);
      lines.push(`${bold('Models')}: ${fmt(snap.modelStats.length)}  ${bold('Agents')}: ${fmt(snap.agentStats.length)}  ${bold('Requests')}: ${fmt(snap.requestStats.endpoints.length)}`);
      lines.push('');
      lines.push(bold('Composite aliases'));
      const composites = Object.entries(snap.config.composite).sort(([a],[b]) => a.localeCompare(b));
      if (!composites.length) lines.push(dim('  none'));
      for (const [alias, targets] of composites) {
        const selectedAlias = sel?.kind === 'alias' && sel.alias === alias;
        const prefix = selectedAlias ? green('>') : dim('│');
        lines.push(`  ${prefix} ${bold(alias)}`);
        const entries = Object.entries(targets || {});
        if (!entries.length) lines.push(`    ${dim('(empty)')}`);
        for (const [target, cfg] of entries.sort(([a],[b]) => a.localeCompare(b))) {
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
      lines.push(state.message ? yellow(state.message) : dim('A add alias  T add target  E edit target  D delete  R reload  Ctrl+C quit  ↑↓ move  Enter select'));
      if (state.inputMode !== 'normal') lines.push(dim(`Input: ${state.input.text()}`));
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
      try { await action(value); } catch (err) { state.message = (err as Error).message; }
      state.inputMode = 'normal';
      await refresh();
    });
  };

  const handleKey = async (key: string): Promise<void> => {
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
      ask('add-target', async (value) => {
        const [target, share, fallback] = value.split(/\s+/);
        if (!target) return;
        upsertCompositeTargetFromDashboard(source.env, sel.alias, target, {
          share: share ? Number(share) : undefined,
          fallback: fallback ? Number(fallback) : undefined,
        });
        state.message = `added target ${target}`;
      });
      render();
      return;
    }
    if (key === 'e' && sel?.kind === 'target') {
      ask('edit-target', async (value) => {
        const [share, fallback, primary] = value.split(/\s+/);
        upsertCompositeTargetFromDashboard(source.env, sel.alias, sel.target, {
          share: share ? Number(share) : undefined,
          fallback: fallback ? Number(fallback) : undefined,
          primary: primary === 'true' ? true : primary === 'false' ? false : undefined,
        });
        state.message = `updated ${sel.alias}.${sel.target}`;
      });
      render();
      return;
    }
    if (key === 'd' && sel) {
      state.pendingDelete = sel;
      ask('confirm', async (value) => {
        if (value.toLowerCase() !== 'y' && value.toLowerCase() !== 'yes') return;
        if (state.pendingDelete?.kind === 'alias') removeCompositeAliasFromDashboard(source.env, state.pendingDelete.alias);
        if (state.pendingDelete?.kind === 'target') removeCompositeTargetFromDashboard(source.env, state.pendingDelete.alias, state.pendingDelete.target);
        state.message = 'deleted';
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
