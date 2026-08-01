import path from 'path';
import { fileURLToPath } from 'url';
import { octomuxRoot } from './octomux-root.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo-local octomux config root: `<repo>/.octomux/`. */
export function repoOctomuxDir(repoPath: string): string {
  return path.join(repoPath, '.octomux');
}

/** Repo-portable saved files: `<repo>/.octomux/files/`. */
export function repoFilesDir(repoPath: string): string {
  return path.join(repoOctomuxDir(repoPath), 'files');
}

/**
 * Skills and agent roles ship in the bundled octomux plugin and nowhere else.
 *
 * There is deliberately no repo or home tier. Earlier revisions had
 * `<repo>/.octomux/{skills,agents}` and `~/.octomux/agents`, but nothing ever
 * delivered them to a running agent — `syncAgents()` is a no-op in both
 * harnesses and delivery is entirely via `--plugin-dir`, so those tiers were
 * readable through the REST API and invisible to every actual agent.
 *
 * Users who want their own skills use Claude Code's native locations
 * (`~/.claude/skills/`, `<repo>/.claude/`), which the harness reads directly and
 * octomux does not manage.
 */
export function builtInSkillsDir(): string {
  return path.resolve(__dirname, '..', 'plugin', 'skills');
}

export function builtInAgentsDir(): string {
  return path.resolve(__dirname, '..', 'plugin', 'agents');
}

/**
 * Built-in schedule-kind presets, shipped at `<octomux-pkg>/kinds/*.json`
 * (see spec/schedule-kinds-as-presets.md §3.1). Read-only.
 */
export function builtInKindsDir(): string {
  return path.resolve(__dirname, '..', 'kinds');
}

/**
 * User-authored schedule-kind presets: `~/.octomux/kinds/*.json`. Writable via
 * the `/api/kinds` routes. `OCTOMUX_KINDS_DIR` overrides for tests, mirroring
 * the `OCTOMUX_AGENTS_DIR` pattern used historically for the (since-removed)
 * home agents tier.
 */
export function homeKindsDir(): string {
  return process.env.OCTOMUX_KINDS_DIR || path.join(octomuxRoot(), 'kinds');
}
