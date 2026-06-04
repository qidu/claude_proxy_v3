type HeatmapRecord = { weekday: number; hour: number; values: number };
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

export function renderHeatmapPanel(heatmap: HeatmapData, options: TuiOptions = {}): string {
  const title = options.title ?? 'Values';
  const total = getMetricValue(heatmap);
  const maxValue = getMetricMax(heatmap);

  const lines: string[] = [];
  lines.push(`  ${title} (${total} total)`);
  lines.push(`      ${heatmap.columns.filter((_, index) => index % 2 === 0).join('  ')}`);

  for (let rowIndex = 0; rowIndex < heatmap.rows.length; rowIndex += 1) {
    const label = heatmap.rows[rowIndex].padEnd(3, ' ');
    const cells: string[] = [];

    for (let columnIndex = 0; columnIndex < heatmap.columns.length; columnIndex += 1) {
      const value = getCellValue(heatmap, rowIndex, columnIndex);
      cells.push(`${getAnsiColor(value, maxValue)}${CELL}${RESET}`);
    }

    lines.push(`  ${label} ${cells.join(' ')}`);
  }

  return lines.join('\n');
}
