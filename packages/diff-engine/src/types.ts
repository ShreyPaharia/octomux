/**
 * Minimal task/repo context the diff engine needs. Callers map their domain
 * model (e.g. octomux `Task`) onto this shape.
 */
export interface DiffTarget {
  id: string;
  worktree: string | null;
  repo_path: string;
  run_mode: string;
  base_branch: string | null;
  base_sha: string | null;
}

/**
 * Diff view selector — mirrors the `range=` query param accepted by the API.
 * - `base`: full task diff (base..HEAD + working tree + untracked)
 * - `commit`: a single commit (sha^..sha)
 * - `range`: an arbitrary range (from..to)
 * - `working`: uncommitted changes vs HEAD only
 */
export type DiffRange =
  | { kind: 'base' }
  | { kind: 'commit'; sha: string }
  | { kind: 'range'; from: string; to: string }
  | { kind: 'working' };

export interface DiffLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export const noopLogger: DiffLogger = {
  warn: () => {},
};
