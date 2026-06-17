import { Command } from 'commander';
import chalk from 'chalk';
import { getContext } from '../action.js';
import { outputJson, success, label, heading } from '../format.js';
import type { OctomuxClient } from '../client.js';

type TeamClient = Pick<OctomuxClient, 'teamRun' | 'teamSchedule' | 'listTeams'>;

async function runTeamRun(name: string, opts: { repo?: string }, cmd: Command): Promise<void> {
  const { client, json } = getContext(cmd);
  const repoPath = opts.repo ?? process.cwd();

  const result = await (client as TeamClient).teamRun({ name, repo_path: repoPath });

  if (json) {
    outputJson(result);
    return;
  }

  success(`Started team run: ${name}`);
  console.log(label('Lead task', result.task_id));
}

async function runTeamSchedule(
  name: string,
  opts: { cron: string; repo?: string },
  cmd: Command,
): Promise<void> {
  const { client, json } = getContext(cmd);
  const repoPath = opts.repo ?? process.cwd();

  await (client as TeamClient).teamSchedule({ name, repo_path: repoPath, cron: opts.cron });

  if (json) {
    outputJson({ ok: true });
    return;
  }

  success(`Scheduled team: ${name}`);
  console.log(label('Cron', opts.cron));
  console.log(label('Repo', repoPath));
}

async function runTeamList(opts: unknown, cmd: Command): Promise<void> {
  const { client, json } = getContext(cmd);

  const schedules = await (client as TeamClient).listTeams();

  if (json) {
    outputJson(schedules);
    return;
  }

  if (!schedules || schedules.length === 0) {
    console.log(chalk.dim('No team schedules configured.'));
    return;
  }

  heading('Team Schedules');
  for (const s of schedules) {
    console.log(
      `  ${chalk.bold(s.name)}  ${chalk.dim(s.cron)}  last: ${s.last_run_at ?? chalk.dim('never')}`,
    );
  }
}

export function registerTeam(program: Command): void {
  const team = program.command('team').description('Manage reusable agent desk teams');

  team
    .command('run <name>')
    .description('Run a team immediately from .octomux/team.yaml')
    .option('-r, --repo <path>', 'path to the target repo (default: cwd)')
    .action((name: string, opts: { repo?: string }, cmd: Command) => runTeamRun(name, opts, cmd));

  team
    .command('schedule <name>')
    .description('Upsert a cron schedule for a team')
    .requiredOption('--cron <expr>', 'cron expression, e.g. "0 7 * * *"')
    .option('-r, --repo <path>', 'path to the target repo (default: cwd)')
    .action((name: string, opts: { cron: string; repo?: string }, cmd: Command) =>
      runTeamSchedule(name, opts, cmd),
    );

  team
    .command('list')
    .description('List configured team schedules')
    .action((opts: unknown, cmd: Command) => runTeamList(opts, cmd));
}
