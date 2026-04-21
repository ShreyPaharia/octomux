import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { getDb } from './db.js';

const execFile = promisify(execFileCb);

export interface RepoConfig {
  repo_path: string;
  base_branch: string | null;
  test_command: string;
  format_command: string;
  lint_command: string;
  created_at: string;
  updated_at: string;
}

export async function getOrCreateRepoConfig(repoPath: string): Promise<RepoConfig> {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM repo_configs WHERE repo_path = ?').get(repoPath) as
    | RepoConfig
    | undefined;

  if (existing) return existing;

  let baseBranch: string | null = null;
  try {
    const { stdout } = await execFile('git', [
      '-C',
      repoPath,
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
    ]);
    baseBranch = stdout.trim().replace('refs/remotes/origin/', '');
  } catch {
    for (const candidate of ['main', 'master', 'staging']) {
      try {
        await execFile('git', ['-C', repoPath, 'rev-parse', '--verify', candidate]);
        baseBranch = candidate;
        break;
      } catch {
        // Try next
      }
    }
  }

  return db
    .prepare(`INSERT INTO repo_configs (repo_path, base_branch) VALUES (?, ?) RETURNING *`)
    .get(repoPath, baseBranch) as RepoConfig;
}

export function updateRepoConfig(
  repoPath: string,
  updates: Partial<
    Pick<RepoConfig, 'base_branch' | 'test_command' | 'format_command' | 'lint_command'>
  >,
): RepoConfig {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM repo_configs WHERE repo_path = ?').get(repoPath) as
    | RepoConfig
    | undefined;

  if (!existing) {
    throw new Error(`No config found for repo: ${repoPath}`);
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length > 0) {
    fields.push(`updated_at = datetime('now')`);
    values.push(repoPath);
    return db
      .prepare(`UPDATE repo_configs SET ${fields.join(', ')} WHERE repo_path = ? RETURNING *`)
      .get(...values) as RepoConfig;
  }

  return existing;
}

export function listRepoConfigs(): RepoConfig[] {
  const db = getDb();
  return db.prepare('SELECT * FROM repo_configs ORDER BY repo_path').all() as RepoConfig[];
}
