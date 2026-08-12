/**
 * server/artifact.ts
 *
 * One per-task narrative artifact: `.octomux/artifact.md` in the task's
 * worktree (spec/surface-consolidation-and-centaur.md §5.5). Git tracks it,
 * it diffs, it survives a DB wipe, and it fits the established `.octomux/`
 * convention (loop-status.json, implement-done, agents/*.md all live there).
 *
 * This pass only implements the **Summary** section — the single mutable,
 * timestamped field that retires `tasks.current_summary` +
 * `current_summary_updated_at`. Plan / Open questions / Progress / PRs /
 * Walkthrough are reserved headings for later work (still backed by their
 * pre-existing stores — see the migration report) and are intentionally NOT
 * scaffolded here (no reader exists for them yet). Parsing is generic by
 * heading, though, so a human — or a future writer — hand-editing those
 * sections round-trips untouched.
 */
// DEPENDENCY-FREE BY DESIGN: fs/path/os only, no `db`, no `repositories`.
// `server/db/migrations.ts` imports this module to back-fill existing rows into
// artifact files, and migrations run *during* db.ts's own module evaluation —
// so anything reaching back to `repositories` → `db` here would close an import
// cycle through a half-initialised module. That hazard is called out at the top
// of migrations.ts. The task-id-resolving wrapper that DOES need the database
// lives in ./artifact-task.ts instead.
import fs from 'fs';
import path from 'path';
import os from 'os';

const ARTIFACT_REL_PATH = path.join('.octomux', 'artifact.md');
const SUMMARY_HEADING = 'Summary';

/** `_Updated <sqlite-style timestamp>_` marker line prefixing the Summary body. */
const SUMMARY_MARKER_RE = /^_Updated (.+?)_\s*\n?([\s\S]*)$/;

function artifactPath(worktree: string): string {
  return path.join(worktree, ARTIFACT_REL_PATH);
}

/**
 * UTC timestamp in sqlite `datetime('now')` shape: `YYYY-MM-DD HH:MM:SS`, no
 * 'T', no trailing 'Z'. Matches the column this artifact replaces — the
 * dashboard (BoardCard.tsx) appends 'Z' itself before parsing, so the wire
 * shape must stay byte-for-byte what it always was.
 */
function sqliteTimestamp(d: Date = new Date()): string {
  return d
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');
}

/** Split "## Heading\nbody" markdown into an ordered heading→body map. */
function parseSections(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  const headingRe = /^##[ \t]+(.+?)[ \t]*$/gm;
  const matches = [...raw.matchAll(headingRe)];
  for (let i = 0; i < matches.length; i++) {
    const heading = matches[i][1].trim();
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? raw.length) : raw.length;
    map.set(heading, raw.slice(start, end).trim());
  }
  return map;
}

function serializeSections(sections: Map<string, string>): string {
  const parts: string[] = [];
  for (const [heading, body] of sections) {
    parts.push(body ? `## ${heading}\n\n${body}` : `## ${heading}\n`);
  }
  return parts.join('\n\n') + '\n';
}

function readSections(worktree: string): Map<string, string> {
  try {
    return parseSections(fs.readFileSync(artifactPath(worktree), 'utf8'));
  } catch {
    return new Map();
  }
}

/** Atomic write: temp file then rename (same discipline as artifact-endpoint.ts). */
function writeSections(worktree: string, sections: Map<string, string>): void {
  const file = artifactPath(worktree);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(
    os.tmpdir(),
    `octomux-artifact-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
  );
  fs.writeFileSync(tmp, serializeSections(sections), 'utf8');
  fs.renameSync(tmp, file);
}

/** Read the artifact's mutable Summary section for a task's worktree path (or null if none). */
export function getArtifactSummary(worktree: string | null): {
  current_summary: string | null;
  current_summary_updated_at: string | null;
} {
  if (!worktree) return { current_summary: null, current_summary_updated_at: null };
  const body = (readSections(worktree).get(SUMMARY_HEADING) ?? '').trim();
  if (!body) return { current_summary: null, current_summary_updated_at: null };
  const m = body.match(SUMMARY_MARKER_RE);
  if (!m) return { current_summary: body, current_summary_updated_at: null };
  return { current_summary: m[2].trim() || null, current_summary_updated_at: m[1].trim() };
}

/**
 * Overwrite the artifact's Summary section in place, stamping it with the
 * current time — or with `at`, which the one-time back-fill passes so a
 * migrated summary keeps its ORIGINAL timestamp. Restamping those to "now"
 * would tell every board card that a two-week-old summary is fresh, silently
 * defeating BoardCard's staleness indicator on exactly the rows being migrated.
 */
export function setArtifactSummary(
  worktree: string,
  summary: string,
  at?: string,
): { updatedAt: string } {
  const sections = readSections(worktree);
  const updatedAt = at ?? sqliteTimestamp();
  sections.set(SUMMARY_HEADING, `_Updated ${updatedAt}_\n\n${summary.trim()}`);
  writeSections(worktree, sections);
  return { updatedAt };
}

/** True when this worktree's artifact already has a non-empty Summary section. */
export function hasArtifactSummary(worktree: string): boolean {
  return Boolean(getArtifactSummary(worktree).current_summary);
}
