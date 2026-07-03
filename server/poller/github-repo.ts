import { getRemoteOriginUrl } from '../task-engine/git.js';

/** Parse a git remote URL into `owner/repo` (nameWithOwner) form. Returns null if non-GitHub. */
export function parseNameWithOwner(remoteUrl: string): string | null {
  const m = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\s*$/i);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

/**
 * Cache of repoPath → nameWithOwner. Remotes rarely change at runtime.
 * Only successful resolutions are cached so a transient failure (or a repo
 * that gains a GitHub remote later) is retried on the next tick.
 */
const repoNwoCache = new Map<string, string>();

export async function repoNameWithOwner(repoPath: string): Promise<string | null> {
  const cached = repoNwoCache.get(repoPath);
  if (cached) return cached;
  const remoteUrl = await getRemoteOriginUrl(repoPath);
  if (!remoteUrl) return null;
  const nwo = parseNameWithOwner(remoteUrl);
  if (nwo) repoNwoCache.set(repoPath, nwo);
  return nwo;
}
