import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import {
  readGithubLogin as readGithubLoginRepo,
  writeGithubLogin as writeGithubLoginRepo,
} from './repositories/index.js';
import { childLogger } from './logger.js';

const logger = childLogger('github-login');
const execFile = promisify(execFileCb);

let cachedLogin: string | null | undefined;

/** Read the cached GitHub login (env var overrides DB). Returns null if unknown. */
export function readGithubLogin(): string | null {
  if (process.env.OCTOMUX_GITHUB_LOGIN) return process.env.OCTOMUX_GITHUB_LOGIN;
  if (cachedLogin !== undefined) return cachedLogin;
  cachedLogin = readGithubLoginRepo();
  return cachedLogin;
}

/** Reset the in-memory cache (test hook). */
export function resetGithubLoginCache(): void {
  cachedLogin = undefined;
}

function writeLogin(login: string): void {
  writeGithubLoginRepo(login);
  cachedLogin = login;
}

/**
 * Ensure the owner's GitHub login is populated. Uses env override, then DB cache,
 * then falls back to `gh api user -q .login`. Returns the login on success,
 * null if gh is unavailable or unauthed (caller should degrade gracefully).
 */
export async function ensureGithubLogin(): Promise<string | null> {
  if (process.env.OCTOMUX_GITHUB_LOGIN) {
    return process.env.OCTOMUX_GITHUB_LOGIN;
  }

  const existing = readGithubLogin();
  if (existing) return existing;

  try {
    const { stdout } = await execFile('gh', ['api', 'user', '-q', '.login']);
    const login = stdout.trim();
    if (!login) {
      logger.warn('gh api user returned empty login — reviewer polling disabled this session');
      return null;
    }
    writeLogin(login);
    logger.info({ github_login: login }, 'cached GitHub login for reviewer polling');
    return login;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'failed to resolve GitHub login (gh missing/unauthed?) — reviewer polling disabled',
    );
    return null;
  }
}
