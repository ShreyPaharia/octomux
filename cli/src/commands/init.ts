import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import chalk from 'chalk';
import { Command } from 'commander';
import { errorMessage, success } from '../format.js';

interface InitOptions {
  jiraUrl?: string;
  jiraProject?: string;
  baseBranch?: string;
  nonInteractive?: boolean;
}

interface RawSettings {
  [key: string]: unknown;
  defaultJiraBaseUrl?: string;
  defaultJiraProjectKey?: string;
  defaultBaseBranch?: string;
}

const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]+$/;

function settingsPath(): string {
  return path.join(os.homedir(), '.octomux', 'settings.json');
}

async function readExisting(): Promise<RawSettings> {
  try {
    const raw = await fs.promises.readFile(settingsPath(), 'utf-8');
    return JSON.parse(raw) as RawSettings;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeSettings(merged: RawSettings): Promise<void> {
  const p = settingsPath();
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(p, JSON.stringify(merged, null, 2), 'utf-8');
}

function normalizeJiraUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`Jira URL must start with http:// or https:// (got "${raw}")`);
  }
  return trimmed;
}

function normalizeProjectKey(raw: string): string {
  const upper = raw.trim().toUpperCase();
  if (!upper) return '';
  if (!PROJECT_KEY_RE.test(upper)) {
    throw new Error(`Project key "${raw}" must match [A-Z][A-Z0-9]+ (e.g. PROJ, ENG, INFRA2)`);
  }
  return upper;
}

function promptOnce(rl: readline.Interface, question: string, def?: string): Promise<string> {
  const suffix = def ? ` ${chalk.dim(`[${def}]`)}` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      const trimmed = answer.trim();
      resolve(trimmed || def || '');
    });
  });
}

export function registerInit(program: Command): void {
  program
    .command('init')
    .description(
      'Interactive setup wizard — writes defaults to ~/.octomux/settings.json. ' +
        'Use --non-interactive with flags for scripted setups.',
    )
    .option('--jira-url <url>', 'Jira base URL (e.g. https://your-co.atlassian.net)')
    .option('--jira-project <key>', 'Default Jira project key (e.g. PROJ)')
    .option('--base-branch <branch>', 'Default base branch (e.g. main)')
    .option('--non-interactive', 'Skip prompts; apply only the values passed via flags')
    .action(async (opts: InitOptions) => {
      let existing: RawSettings;
      try {
        existing = await readExisting();
      } catch (err) {
        errorMessage(
          `Failed to read existing settings at ${settingsPath()}: ${(err as Error).message}`,
        );
        process.exit(1);
      }

      const next: RawSettings = { ...existing };

      const flagsProvided = !!(opts.jiraUrl || opts.jiraProject || opts.baseBranch);
      const skipPrompts = opts.nonInteractive || flagsProvided;

      try {
        if (skipPrompts) {
          if (opts.jiraUrl !== undefined) {
            const v = normalizeJiraUrl(opts.jiraUrl);
            if (v) next.defaultJiraBaseUrl = v;
          }
          if (opts.jiraProject !== undefined) {
            const v = normalizeProjectKey(opts.jiraProject);
            if (v) next.defaultJiraProjectKey = v;
          }
          if (opts.baseBranch !== undefined) {
            const v = opts.baseBranch.trim();
            if (v) next.defaultBaseBranch = v;
          }
        } else {
          console.log('');
          console.log(chalk.bold('octomux setup'));
          console.log('');
          console.log('Configure defaults for new tasks. Press Enter to skip a field.');
          console.log('');

          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          try {
            const jiraUrlRaw = await promptOnce(
              rl,
              'Jira base URL (e.g. https://your-company.atlassian.net)',
              existing.defaultJiraBaseUrl,
            );
            if (jiraUrlRaw) next.defaultJiraBaseUrl = normalizeJiraUrl(jiraUrlRaw);

            const projectKeyRaw = await promptOnce(
              rl,
              'Default Jira project key (e.g. PROJ)',
              existing.defaultJiraProjectKey,
            );
            if (projectKeyRaw) next.defaultJiraProjectKey = normalizeProjectKey(projectKeyRaw);

            const baseBranchRaw = await promptOnce(
              rl,
              'Default base branch',
              existing.defaultBaseBranch ?? 'main',
            );
            if (baseBranchRaw) next.defaultBaseBranch = baseBranchRaw;
          } finally {
            rl.close();
          }
        }
      } catch (err) {
        errorMessage((err as Error).message);
        process.exit(1);
      }

      try {
        await writeSettings(next);
      } catch (err) {
        errorMessage(`Failed to write ${settingsPath()}: ${(err as Error).message}`);
        process.exit(1);
      }

      console.log('');
      success(`Wrote ${settingsPath()}`);
      console.log('');
      console.log(chalk.bold('Optional next steps:'));
      console.log('  • Authenticate GitHub (for the create-pr skill):');
      console.log('    ' + chalk.yellow('gh auth login'));
      console.log('  • Set Jira credentials (only needed for the jira-status hook):');
      console.log('    ' + chalk.yellow('export JIRA_EMAIL=you@company.com'));
      console.log('    ' + chalk.yellow('export JIRA_TOKEN=your-api-token'));
      console.log('  • Start the dashboard:');
      console.log('    ' + chalk.yellow('octomux start'));
      console.log('');
      console.log(chalk.dim('Finish setup in the dashboard: Settings → Setup (or /setup).'));
      console.log(chalk.dim('See ONBOARDING.md for the full walkthrough.'));
      console.log('');
    });
}
