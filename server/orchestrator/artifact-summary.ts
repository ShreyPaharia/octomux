/**
 * server/orchestrator/artifact-summary.ts
 *
 * Build a self-contained, plain-text gist of a task artifact so gateway chat
 * replies (Telegram/Slack) carry the actual content — not a bare link the user
 * can't open from a phone/SSH session.
 *
 * `buildArtifactSummary` is pure (path + content in, bounded string out) so it's
 * trivially testable. `summarizeArtifact` wires it to the shared symlink-safe
 * reader; it returns null when the artifact can't be read so callers fall back
 * to their plain note.
 */

import path from 'path';
import { readTaskArtifact } from './artifact-endpoint.js';
import { childLogger } from '../logger.js';

const logger = childLogger('orchestrator/artifact-summary');

const DEFAULT_MAX_CHARS = 1200;

/** Truncate to `maxChars`, appending an ellipsis when cut. */
function clamp(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}\n…`;
}

/**
 * Render a plan.json object as a readable gist: summary, file list, and any
 * open questions. Falls back to raw content when the shape is unexpected.
 */
function summarizePlanJson(content: string, maxChars: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Malformed JSON — surface the raw head so the user still sees something.
    return clamp(content, maxChars);
  }

  const plan = parsed as {
    summary?: unknown;
    files?: unknown;
    open_questions?: unknown;
  };
  const parts: string[] = [];

  if (typeof plan.summary === 'string' && plan.summary.trim()) {
    parts.push(plan.summary.trim());
  }

  if (Array.isArray(plan.files) && plan.files.length > 0) {
    const lines = plan.files
      .map((f) => {
        const file = f as { path?: unknown; action?: unknown };
        const p = typeof file.path === 'string' ? file.path : null;
        if (!p) return null;
        const action = typeof file.action === 'string' ? file.action : 'change';
        return `• ${p} — ${action}`;
      })
      .filter((l): l is string => l !== null);
    if (lines.length > 0) parts.push(`Files:\n${lines.join('\n')}`);
  }

  if (Array.isArray(plan.open_questions) && plan.open_questions.length > 0) {
    const qs = plan.open_questions
      .filter((q): q is string => typeof q === 'string' && q.trim() !== '')
      .map((q) => `• ${q}`);
    if (qs.length > 0) parts.push(`Open questions:\n${qs.join('\n')}`);
  }

  // Nothing recognizable — fall back to the raw head rather than an empty gist.
  if (parts.length === 0) return clamp(content, maxChars);

  return clamp(parts.join('\n\n'), maxChars);
}

/**
 * Build a bounded, self-contained plain-text summary of an artifact.
 *
 * - plan.json (or any .json)  → summary + file list + open questions
 * - .md / .html / anything else → head of the raw content
 *
 * Always bounded to `maxChars` (ellipsis when cut).
 */
export function buildArtifactSummary(
  relPath: string,
  content: string,
  maxChars: number = DEFAULT_MAX_CHARS,
): string {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === '.json') {
    return summarizePlanJson(content, maxChars);
  }
  return clamp(content, maxChars);
}

/**
 * Read a task artifact and render its gist. Returns null when the artifact can't
 * be read (missing task/worktree/file or empty) so the caller keeps its plain note.
 */
export function summarizeArtifact(
  taskId: string,
  relPath: string,
  maxChars: number = DEFAULT_MAX_CHARS,
): string | null {
  const content = readTaskArtifact(taskId, relPath);
  if (content === null || content.trim() === '') {
    logger.debug({ task_id: taskId, path: relPath }, 'summarizeArtifact: no readable artifact');
    return null;
  }
  return buildArtifactSummary(relPath, content, maxChars);
}
