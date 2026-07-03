import chalk from 'chalk';
import type { Task } from '@octomux/types';

const STATUS_COLORS: Record<string, (s: string) => string> = {
  draft: chalk.cyan,
  idle: chalk.cyan,
  setting_up: chalk.yellow,
  running: chalk.green,
  closed: chalk.dim,
  error: chalk.red,
};

const AGENT_STATUS_COLORS: Record<string, (s: string) => string> = {
  running: chalk.green,
  idle: chalk.dim,
  waiting: chalk.yellow,
  stopped: chalk.red,
};

export function colorStatus(status: string): string {
  const colorFn = STATUS_COLORS[status] || chalk.white;
  return colorFn(status);
}

/** Legacy CLI status label derived from runtime_state + workflow_status. */
export function taskDisplayStatus(task: Pick<Task, 'runtime_state' | 'workflow_status'>): string {
  if (task.runtime_state === 'idle') {
    return task.workflow_status === 'backlog' ? 'draft' : 'closed';
  }
  return task.runtime_state;
}

export function taskMatchesStatusFilter(
  task: Pick<Task, 'runtime_state' | 'workflow_status'>,
  status: string,
): boolean {
  return taskDisplayStatus(task) === status;
}

export function colorAgentStatus(status: string): string {
  const colorFn = AGENT_STATUS_COLORS[status] || chalk.white;
  return colorFn(status);
}

export function isJsonMode(json: boolean | undefined): boolean {
  return json === true || !process.stdout.isTTY;
}

export function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function label(name: string, value: string | null | undefined): string {
  return `${chalk.bold(name + ':')} ${value ?? chalk.dim('—')}`;
}

export function heading(text: string): void {
  console.log(chalk.bold(text));
}

export function success(text: string): void {
  console.log(chalk.green('✓') + ' ' + text);
}

export function errorMessage(text: string): void {
  console.error(chalk.red('Error:') + ' ' + text);
}

// ─── Table rendering ──────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleLength(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

function padEndVisible(s: string, width: number): string {
  const pad = Math.max(0, width - visibleLength(s));
  return s + ' '.repeat(pad);
}

export interface Column<T> {
  /** Header label shown in the first row. */
  header: string;
  /** Visible width; omit for the final (unbounded) column. */
  width?: number;
  /** Cell renderer. May include ANSI colors; width accounts for visible length only. */
  get: (row: T) => string;
}

/**
 * Renders a bold header row, a dim separator, and one line per row.
 * ANSI-aware: padding is applied to visible length, not byte length.
 */
export function printTable<T>(
  columns: Column<T>[],
  rows: T[],
  opts: { separatorWidth?: number } = {},
): void {
  const renderRow = (cells: string[]) =>
    cells
      .map((cell, i) => {
        const col = columns[i];
        return i === columns.length - 1 || col.width == null
          ? cell
          : padEndVisible(cell, col.width);
      })
      .join('');

  heading(renderRow(columns.map((c) => c.header)));
  console.log(chalk.dim('─'.repeat(opts.separatorWidth ?? 60)));
  for (const row of rows) {
    console.log(renderRow(columns.map((c) => c.get(row))));
  }
}
