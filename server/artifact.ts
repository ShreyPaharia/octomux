/**
 * server/artifact.ts
 *
 * One per-task narrative artifact: `.octomux/artifact.md` in the task's
 * worktree (spec/surface-consolidation-and-centaur.md §5.5). Git tracks it,
 * it diffs, it survives a DB wipe, and it fits the established `.octomux/`
 * convention (loop-status.json, implement-done, agents/*.md all live there).
 *
 * This pass implements two mutable, timestamped sections:
 *   - Summary  — authored (by an agent, a human, or the opt-in Stop
 *     summarizer). Retires `tasks.current_summary` + `current_summary_updated_at`.
 *   - Activity — machine-derived, last-tool-call breadcrumb written on every
 *     post-tool-use hook. Exists so a running task without an authored
 *     summary still reads as alive on the board.
 * Plan / Open questions / Progress / PRs / Walkthrough are reserved headings
 * for later work (still backed by their pre-existing stores — see the
 * migration report) and are intentionally NOT scaffolded here (no reader
 * exists for them yet). Parsing is generic by heading, though, so a human —
 * or a future writer — hand-editing those sections round-trips untouched.
 * Likewise the free text before the first `## Heading` (a `# Title` + lede,
 * exactly what agents write at the top) round-trips untouched — see
 * PREAMBLE_KEY below.
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
const ACTIVITY_HEADING = 'Activity';

/**
 * Reserved key parseSections/serializeSections use to carry the free text
 * before the first `## Heading`. A plain string sentinel (rather than a
 * Symbol) keeps every function in this module typed as plain
 * `Map<string, string>` instead of threading a `string | symbol` union
 * through readSections/writeSections/etc. for one special case. NUL bytes
 * can never appear in a heading captured by parseSections' regex (real
 * markdown headings are plain text), so this can't collide with real content.
 */
const PREAMBLE_KEY = '\u0000preamble\u0000';

/** `_Updated <sqlite-style timestamp>_` marker line prefixing a mutable section's body. */
const MARKER_RE = /^_Updated (.+?)_\s*\n?([\s\S]*)$/;

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

/**
 * Split "<preamble>\n## Heading\nbody\n## Heading2\n..." markdown into an
 * ordered heading→body map. The text before the first `## ` heading is
 * preserved under PREAMBLE_KEY so serializeSections can round-trip it —
 * losing it was the original data-loss bug (any setArtifactSummary call
 * silently deleted everything a human/agent had written above the first
 * heading).
 */
export function parseSections(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  const headingRe = /^##[ \t]+(.+?)[ \t]*$/gm;
  const matches = [...raw.matchAll(headingRe)];

  const preambleEnd = matches.length ? (matches[0].index ?? 0) : raw.length;
  const preamble = raw.slice(0, preambleEnd).trim();
  if (preamble) map.set(PREAMBLE_KEY, preamble);

  for (let i = 0; i < matches.length; i++) {
    const heading = matches[i][1].trim();
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? raw.length) : raw.length;
    map.set(heading, raw.slice(start, end).trim());
  }
  return map;
}

export function serializeSections(sections: Map<string, string>): string {
  const parts: string[] = [];
  const preamble = sections.get(PREAMBLE_KEY);
  if (preamble) parts.push(preamble);
  for (const [heading, body] of sections) {
    if (heading === PREAMBLE_KEY) continue;
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

/**
 * Insert a brand-new heading immediately before `before` if `before` already
 * exists in the map; otherwise identical to `sections.set` (append, or
 * update-in-place if `heading` already exists — Map preserves an existing
 * key's position on re-set). Map has no splice, so inserting mid-sequence
 * means rebuilding.
 */
function setHeadingOrdered(
  sections: Map<string, string>,
  heading: string,
  body: string,
  before?: string,
): void {
  if (sections.has(heading) || !before || !sections.has(before)) {
    sections.set(heading, body);
    return;
  }
  const rebuilt: [string, string][] = [];
  for (const [h, b] of sections) {
    if (h === before) rebuilt.push([heading, body]);
    rebuilt.push([h, b]);
  }
  sections.clear();
  for (const [h, b] of rebuilt) sections.set(h, b);
}

/**
 * Escape a line that begins with '## ' inside a mutable section's body text
 * so parseSections' heading regex can't mistake machine/agent-authored body
 * content (e.g. a Bash command that happens to print "## something") for a
 * new section and split the file apart under it. Reversed by
 * unescapeHeadingLike on read, so callers never see the escape.
 */
function escapeHeadingLike(text: string): string {
  return text.replace(/^##(?=[ \t])/gm, '\\##');
}
function unescapeHeadingLike(text: string): string {
  return text.replace(/^\\##(?=[ \t])/gm, '##');
}

function formatMarkerBody(text: string, at: string): string {
  return `_Updated ${at}_\n\n${escapeHeadingLike(text.trim())}`;
}

function parseMarkerBody(raw: string): { text: string | null; updatedAt: string | null } {
  const body = raw.trim();
  if (!body) return { text: null, updatedAt: null };
  const m = body.match(MARKER_RE);
  if (!m) return { text: unescapeHeadingLike(body), updatedAt: null };
  return { text: unescapeHeadingLike(m[2].trim()) || null, updatedAt: m[1].trim() };
}

function getMarkerSection(
  worktree: string | null,
  heading: string,
): { text: string | null; updatedAt: string | null } {
  if (!worktree) return { text: null, updatedAt: null };
  return parseMarkerBody(readSections(worktree).get(heading) ?? '');
}

function setMarkerSection(
  worktree: string,
  heading: string,
  text: string,
  at: string | undefined,
  insertBefore?: string,
): { updatedAt: string } {
  const sections = readSections(worktree);
  const updatedAt = at ?? sqliteTimestamp();
  setHeadingOrdered(sections, heading, formatMarkerBody(text, updatedAt), insertBefore);
  writeSections(worktree, sections);
  return { updatedAt };
}

/** Read the artifact's mutable Summary section for a task's worktree path (or null if none). */
export function getArtifactSummary(worktree: string | null): {
  current_summary: string | null;
  current_summary_updated_at: string | null;
} {
  const { text, updatedAt } = getMarkerSection(worktree, SUMMARY_HEADING);
  return { current_summary: text, current_summary_updated_at: updatedAt };
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
  // Summary is the section a human expects to read first; if Activity
  // already exists (the tool-use hook can create it before any agent has
  // ever written a Summary) splice Summary in before it so the file still
  // reads Summary → Activity top to bottom regardless of creation order.
  return setMarkerSection(worktree, SUMMARY_HEADING, summary, at, ACTIVITY_HEADING);
}

/** True when this worktree's artifact already has a non-empty Summary section. */
export function hasArtifactSummary(worktree: string): boolean {
  return Boolean(getArtifactSummary(worktree).current_summary);
}

/**
 * Read the artifact's Activity section for a task's worktree path (or
 * null if none). Distinct from Summary: Summary is authored (by an agent, a
 * human, or the opt-in Stop summarizer); Activity is the last tool call,
 * machine-derived, and is what makes a running card look alive even before
 * anyone has written a real summary.
 */
export function getArtifactActivity(worktree: string | null): {
  current_activity: string | null;
  current_activity_updated_at: string | null;
} {
  const { text, updatedAt } = getMarkerSection(worktree, ACTIVITY_HEADING);
  return { current_activity: text, current_activity_updated_at: updatedAt };
}

/** Overwrite the artifact's Activity section in place, stamping it with the
 *  current time (or `at`). Fired on every tool use — see setTaskSummary's
 *  (server/artifact-task.ts) ponytail note on write frequency; same tradeoff
 *  applies here, only more so since Activity writes far more often. */
export function setArtifactActivity(
  worktree: string,
  activity: string,
  at?: string,
): { updatedAt: string } {
  return setMarkerSection(worktree, ACTIVITY_HEADING, activity, at);
}
