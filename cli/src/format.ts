import chalk from 'chalk';

const STATUS_COLORS: Record<string, (s: string) => string> = {
  draft: chalk.cyan,
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
