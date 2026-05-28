import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import type { ListTaskBranchesResponse, ListTaskCommitsResponse, TaskCommit } from './types.js';

const execFile = promisify(execFileCb);

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_')) env[k] = v;
  }
  return env;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('git', ['-C', cwd, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    env: gitEnv(),
  });
  return stdout;
}

export async function computeMergeBase(
  repoPath: string,
  ref1: string,
  ref2: string,
): Promise<string> {
  const { stdout } = await execFile('git', ['-C', repoPath, 'merge-base', ref1, ref2], {
    env: gitEnv(),
  });
  return stdout.trim();
}

/**
 * List commits in `cwd` between `from` and `to`. Both default behaviour: caller
 * supplies a base..HEAD style window via `from`/`to`. Returns up to `limit`
 * commits with `truncated = true` if more were available.
 */
export async function listCommits(
  cwd: string,
  opts: { from?: string; to?: string; limit: number },
): Promise<ListTaskCommitsResponse> {
  const { from, to = 'HEAD', limit } = opts;
  const range = from ? `${from}..${to}` : to;
  // %x09 = TAB; %aI = author date strict ISO 8601.
  // Read limit+1 so we can detect truncation.
  const args = [
    'log',
    '--pretty=format:%H%x09%h%x09%s%x09%an%x09%ae%x09%aI',
    `-n`,
    String(limit + 1),
    range,
  ];
  let stdout = '';
  try {
    stdout = await git(cwd, args);
  } catch (err) {
    // Empty range / unborn branch / missing ref — return empty list rather than 500.
    const msg = (err as Error).message;
    if (
      msg.includes('unknown revision') ||
      msg.includes('does not have any commits yet') ||
      msg.includes('bad revision')
    ) {
      return { commits: [], truncated: false };
    }
    throw err;
  }

  const lines = stdout.split('\n').filter(Boolean);
  const truncated = lines.length > limit;
  if (truncated) lines.length = limit;

  const commits: TaskCommit[] = lines.map((line) => {
    const [sha, short_sha, subject, author, author_email, authored_at] = line.split('\t');
    return {
      sha: sha ?? '',
      short_sha: short_sha ?? '',
      subject: subject ?? '',
      author: author ?? '',
      author_email: author_email ?? '',
      authored_at: authored_at ?? '',
    };
  });
  return { commits, truncated };
}

/**
 * List local + remote branches in `cwd`. Strips `origin/` prefixes and dedupes
 * so the picker shows one entry per logical branch. Resolves the current
 * branch (HEAD's symbolic ref) when on one, otherwise null.
 */
export async function listBranches(cwd: string): Promise<ListTaskBranchesResponse> {
  const { stdout } = await execFile(
    'git',
    ['-C', cwd, 'branch', '-a', '--format=%(refname:short)'],
    {
      env: gitEnv(),
    },
  );
  const raw = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((b) => b.replace(/^origin\//, ''));
  const branches = [...new Set(raw)].filter((b) => b !== 'HEAD').sort();

  let current: string | null = null;
  try {
    const { stdout: head } = await execFile('git', ['-C', cwd, 'symbolic-ref', '--short', 'HEAD'], {
      env: gitEnv(),
    });
    current = head.trim() || null;
  } catch {
    current = null;
  }

  let defaultBranch: string | null = null;
  try {
    const { stdout: ref } = await execFile(
      'git',
      ['-C', cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      { env: gitEnv() },
    );
    defaultBranch = ref.trim().replace(/^origin\//, '') || null;
  } catch {
    defaultBranch = null;
  }

  return { branches, current, default: defaultBranch };
}
