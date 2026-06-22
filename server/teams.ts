import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { nanoid } from 'nanoid';
import { startTask } from './task-runner.js';
import { childLogger } from './logger.js';
import {
  getTask,
  insertTask,
  insertWorktree,
  upsertTeamSchedule as upsertTeamScheduleRepo,
  listTeamSchedules as listTeamSchedulesRepo,
  listEnabledTeamSchedules,
  findActiveTeamRun,
  insertTeamRun,
  touchTeamScheduleLastRun,
} from './repositories/index.js';

const logger = childLogger('teams');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TeamRosterEntry {
  role: string;
  skeleton: string;
  model: string;
  overlay?: string;
}

export interface TeamConfig {
  name: string;
  repo?: string;
  base_branch?: string;
  schedule?: string;
  notify_command?: string;
  journal_dir?: string;
  incidents_dir?: string;
  roster: TeamRosterEntry[];
}

// ─── Parsing + Validation ─────────────────────────────────────────────────────

export function parseTeamConfig(raw: string): TeamConfig {
  const doc = yaml.load(raw);
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new Error('team.yaml must be a YAML mapping');
  }
  return doc as TeamConfig;
}

export function validateTeamConfig(config: unknown): TeamConfig {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error('team config must be an object');
  }
  const c = config as Record<string, unknown>;

  if (!c.name || typeof c.name !== 'string') {
    throw new Error('team config: name is required');
  }
  if (!Array.isArray(c.roster) || c.roster.length === 0) {
    throw new Error('team config: roster must be a non-empty array');
  }
  const roster = c.roster as TeamRosterEntry[];
  const hasLead = roster.some((r) => r.role === 'lead');
  if (!hasLead) {
    throw new Error('team config: roster must include a lead role');
  }

  return c as unknown as TeamConfig;
}

// ─── Skeleton loading ─────────────────────────────────────────────────────────

function loadSkeleton(skeletonName: string, repoPath: string): string {
  const p = path.join(repoPath, '.octomux', 'agents', `${skeletonName}.md`);
  if (!fs.existsSync(p)) {
    throw new Error(`skeleton not found: ${skeletonName} (expected at ${p})`);
  }
  return fs.readFileSync(p, 'utf-8');
}

// ─── runTeam ─────────────────────────────────────────────────────────────────

export interface RunTeamOpts {
  name: string;
  repoPath: string;
}

/**
 * Read .octomux/team.yaml from repoPath, create a Lead task, start it.
 * Returns the new task id.
 */
export async function runTeam(opts: RunTeamOpts): Promise<string> {
  const { name, repoPath } = opts;

  const configPath = path.join(repoPath, '.octomux', 'team.yaml');
  if (!fs.existsSync(configPath)) {
    throw new Error(`team.yaml not found at ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = parseTeamConfig(raw);
  const config = validateTeamConfig(parsed);

  const lead = config.roster.find((r) => r.role === 'lead')!;

  // Load lead skeleton from target repo's .octomux/agents/
  const skeletonContent = loadSkeleton(lead.skeleton, repoPath);

  // Load optional overlay from target repo
  let overlayContent = '';
  if (lead.overlay) {
    const overlayPath = path.join(repoPath, lead.overlay);
    if (fs.existsSync(overlayPath)) {
      overlayContent = fs.readFileSync(overlayPath, 'utf-8');
    }
  }

  const id = nanoid(12);

  // Build kick-off prompt for the Lead
  const rosterSummary = config.roster
    .map((r) => `  - role: ${r.role}, skeleton: ${r.skeleton}, model: ${r.model}`)
    .join('\n');

  const prompt = [
    `# Team: ${config.name}`,
    '',
    '## Your Role: Lead',
    '',
    skeletonContent,
    overlayContent ? `\n## Repo-specific overlay\n\n${overlayContent}` : '',
    '',
    '## Team Configuration',
    '',
    `Team config: ${configPath}`,
    `Base branch: ${config.base_branch ?? 'main'}`,
    `Journal dir: ${config.journal_dir ?? 'desk/journal'}`,
    `Incidents dir: ${config.incidents_dir ?? 'desk/incidents'}`,
    `Notify command: ${config.notify_command ?? ''}`,
    '',
    '## Full Roster',
    '',
    rosterSummary,
    '',
    '## Instructions',
    '',
    `Your task ID (Lead): ${id}`,
    `Spawn worker tasks via: octomux create-task --notify-task ${id} --model <role model> ...`,
    `After workers finish, run: ${config.notify_command ?? 'echo "No notify_command configured"'}`,
    'Never merge, deploy, or write live config. Open PRs; let the human decide.',
  ]
    .filter((l) => l !== null)
    .join('\n');
  const worktreeId = nanoid(12);

  insertWorktree({
    id: worktreeId,
    path: '',
    repo_path: repoPath,
    branch: null,
    base_branch: config.base_branch ?? 'main',
    mode: 'new',
    status: 'available',
  });

  insertTask({
    id,
    title: `Team run: ${name}`,
    description: `Automated desk crew run for team ${name}`,
    runtime_state: 'setting_up',
    workflow_status: 'planned',
    initial_prompt: prompt,
    worktree_id: worktreeId,
    harness_id: 'claude-code',
    model: lead.model ?? null,
    source: 'team_run',
  });

  const created = getTask(id)!;
  await startTask(created);

  logger.info({ task_id: id, team: name }, 'team run started');
  return id;
}

// ─── Schedule management ──────────────────────────────────────────────────────

export interface TeamScheduleRow {
  name: string;
  repo_path: string;
  config_path: string;
  cron: string;
  enabled: number;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TeamRunRow {
  id: string;
  team: string;
  lead_task_id: string;
  started_at: string;
  status: string;
}

export function upsertTeamSchedule(opts: { name: string; repoPath: string; cron: string }): void {
  const configPath = path.join(opts.repoPath, '.octomux', 'team.yaml');
  upsertTeamScheduleRepo({
    name: opts.name,
    repoPath: opts.repoPath,
    configPath,
    cron: opts.cron,
  });
}

export function listTeamSchedules(): TeamScheduleRow[] {
  return listTeamSchedulesRepo();
}

// ─── Cron evaluation ─────────────────────────────────────────────────────────

/**
 * Minimal 5-field cron parser: "min hour dom mon dow"
 * Supports: exact values, asterisks. Returns true if now matches the expr.
 * Does NOT support ranges, step values, or lists — sufficient for daily schedules.
 */
export function cronMatches(expr: string, now: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [min, hour, dom, mon, dow] = fields;

  const matches = (field: string, value: number): boolean => {
    if (field === '*') return true;
    const n = parseInt(field, 10);
    return !isNaN(n) && n === value;
  };

  return (
    matches(min!, now.getUTCMinutes()) &&
    matches(hour!, now.getUTCHours()) &&
    matches(dom!, now.getUTCDate()) &&
    matches(mon!, now.getUTCMonth() + 1) &&
    matches(dow!, now.getUTCDay())
  );
}

/**
 * Called on each poller tick. For each enabled schedule, if the cron matches
 * the current minute AND no active team_run exists, fire a team run.
 */
export async function pollTeamSchedules(now: Date = new Date()): Promise<void> {
  const schedules = listEnabledTeamSchedules();

  for (const schedule of schedules) {
    if (!cronMatches(schedule.cron, now)) continue;

    // Idempotency: skip only if the linked Lead task is still actually running.
    // Joining tasks avoids the stuck-forever bug where team_runs.status never
    // transitions off 'running' — self-correcting even without an explicit status update.
    const activeRun = findActiveTeamRun(schedule.name);
    if (activeRun) {
      logger.info({ team: schedule.name }, 'team run already active, skipping');
      continue;
    }

    try {
      const leadTaskId = await runTeam({ name: schedule.name, repoPath: schedule.repo_path });
      insertTeamRun({ team: schedule.name, lead_task_id: leadTaskId });
      touchTeamScheduleLastRun(schedule.name);
      logger.info({ team: schedule.name, task_id: leadTaskId }, 'team schedule fired');
    } catch (err) {
      logger.error({ team: schedule.name, err }, 'team schedule run failed');
    }
  }
}
