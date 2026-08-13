type HeatmapRecord = { weekday: number; hour: number; values: number };
type MonthlyHeatmapRecord = { day: number; values: number };
type HeatmapCell = { values: number };
type HeatmapData = {
  rows: readonly string[];
  columns: readonly string[];
  cells: HeatmapCell[][];
  totalValues: number;
  maxValues: number;
};

export interface TuiOptions {
  title?: string;
  rowFilter?: number[]; // indices of rows to show (0=Sun, 1=Mon, ..., 6=Sat)
}

const ROW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const EMPTY_COLOR = '\x1b[38;2;22;27;34m';
const VALUE_COLORS = [
  '\x1b[38;2;144;202;249m',
  '\x1b[38;2;66;165;245m',
  '\x1b[38;2;30;136;229m',
  '\x1b[38;2;21;101;192m',
] as const;
const RESET = '\x1b[0m';
const ALT_SCREEN = '\x1b[?1049h';
const EXIT_ALT_SCREEN = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const CELL = '■';
const COLUMN_LABELS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'));

function getMetricValue(heatmap: HeatmapData): number {
  return heatmap.totalValues;
}

function getMetricMax(heatmap: HeatmapData): number {
  return heatmap.maxValues;
}

function getCellValue(heatmap: HeatmapData, row: number, column: number): number {
  return heatmap.cells[row][column].values;
}

export function getAnsiColor(value: number, maxValue: number): string {
  if (value <= 0 || maxValue <= 0) {
    return EMPTY_COLOR;
  }

  const ratio = value / maxValue;

  if (ratio < 0.25) {
    return VALUE_COLORS[0];
  }

  if (ratio < 0.5) {
    return VALUE_COLORS[1];
  }

  if (ratio < 0.75) {
    return VALUE_COLORS[2];
  }

  return VALUE_COLORS[3];
}

function fg(code: number, text: string): string {
  return `\u001b[${code}m${text}\u001b[0m`;
}
function bold(text: string): string { return fg(1, text); }
function dim(text: string): string { return fg(2, text); }

export function buildHeatmap(records: HeatmapRecord[]): HeatmapData {
  const cells: HeatmapCell[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ values: 0 })),
  );

  for (const record of records) {
    cells[record.weekday][record.hour].values += record.values;
  }

  let totalValues = 0;
  let maxValues = 0;

  for (const row of cells) {
    for (const cell of row) {
      totalValues += cell.values;
      maxValues = Math.max(maxValues, cell.values);
    }
  }

  return {
    rows: ROW_LABELS,
    columns: COLUMN_LABELS,
    cells,
    totalValues,
    maxValues,
  };
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function replaceVisualChar(str: string, visPos: number, newChar: string): string {
  let vis = 0;
  let i = 0;
  while (i < str.length) {
    if (str[i] === '\x1b') {
      const end = str.indexOf('m', i);
      i = end + 1;
      continue;
    }
    if (vis === visPos) {
      return str.slice(0, i - 1) + newChar + str.slice(i);
    }
    vis++;
    i++;
  }
  if (vis === visPos) {
    return str + newChar;
  }
  return str;
}

export function renderHeatmapPanel(heatmap: HeatmapData, options: TuiOptions = {}): string {
  const title = options.title ?? 'Values';
  const total = getMetricValue(heatmap);
  const maxValue = getMetricMax(heatmap);
  const currentHour = new Date().getHours();
  const headerLabels = heatmap.columns.map((col, index) =>
    index === currentHour ? bold(col) : dim(col),
  );
  const evenLabels = headerLabels.filter((_, index) => index % 2 === 0);
  const evenJoinStr = '  ';
  let headerStr = evenLabels.join(evenJoinStr) + '  ';

  // Replace the second space of the separator before the next even label with '·'
  // to indicate current hour position when current hour is odd.
  if (currentHour % 2 !== 0) {
    if (currentHour >= 22) {
      // Past the last even label (hour 23) — append marker at the end
      headerStr = headerStr.trimEnd() + '· ';
    } else {
      const nextEven = currentHour + 1;
      // Each even label is 2 chars; each separator is 2 spaces. Separator before col n
      // occupies visual positions 2n-2 and 2n-1. Replace the second space (2n-1) with '·'.
      const visPos = 2 * nextEven - 1;
      headerStr = replaceVisualChar(headerStr, visPos, '·');
    }
  }
  const lines: string[] = [];
  lines.push(`  ${title} (${total} total)`);
  lines.push(`      ${headerStr}`);

  for (let rowIndex = 0; rowIndex < heatmap.rows.length; rowIndex += 1) {
    const label = heatmap.rows[rowIndex].padEnd(3, ' ');
    const today = ROW_LABELS[new Date().getDay()];
    const labelDay = label.trim() === today ? bold(label) : dim(label);
    const cells: string[] = [];

    for (let columnIndex = 0; columnIndex < heatmap.columns.length; columnIndex += 1) {
      const value = getCellValue(heatmap, rowIndex, columnIndex);
      cells.push(`${getAnsiColor(value, maxValue)}${CELL}${RESET}`);
    }

    lines.push(`  ${labelDay} ${cells.join(' ')}`);
  }

  return lines.join('\n');
}

export function buildMonthlyHeatmap(records: MonthlyHeatmapRecord[]): HeatmapData {
  const cells: HeatmapCell[][] = Array.from({ length: 1 }, () =>
    Array.from({ length: 31 }, () => ({ values: 0 })),
  );

  let totalValues = 0;
  let maxValues = 0;

  for (const record of records) {
    const idx = record.day - 1; // day 1..31 → index 0..30
    if (idx < 0 || idx > 30) continue;
    cells[0][idx].values += record.values;
    totalValues += record.values;
    maxValues = Math.max(maxValues, cells[0][idx].values);
  }

  const columns = Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0'));

  return {
    rows: ['Day'],
    columns,
    cells,
    totalValues,
    maxValues,
  };
}

export function renderMonthlyHeatmapPanel(heatmap: HeatmapData, options: TuiOptions = {}): string {
  const title = options.title ?? 'Values';
  const total = getMetricValue(heatmap);
  const maxValue = getMetricMax(heatmap);
  const currentDay = new Date().getDate();

  // Show odd days (1, 3, 5, ..., 31) like the weekly view shows even hours
  const headerLabels = heatmap.columns.map((col, index) => {
    const dayNum = index + 1;
    return dayNum === currentDay ? bold(col) : dim(col);
  });
  const oddLabels = headerLabels.filter((_, index) => index % 2 === 0); // days 1, 3, 5, ...
  const headerStr = oddLabels.join('  ') + '  ';

  const lines: string[] = [];
  lines.push(`  ${title} (${total} total)`);
  lines.push(`      ${headerStr}`);

  const cells: string[] = [];
  for (let columnIndex = 0; columnIndex < heatmap.columns.length; columnIndex += 1) {
    const value = getCellValue(heatmap, 0, columnIndex);
    cells.push(`${getAnsiColor(value, maxValue)}${CELL}${RESET}`);
  }
  lines.push(`  Day ${cells.join(' ')}`);

  return lines.join('\n');
}
