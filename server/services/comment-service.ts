/**
 * Service layer for inline review comments.
 * HTTP-agnostic: depends only on repos, diff utilities, and child_process git calls.
 * Never imports express or touches req/res.
 */

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import { addComment } from '../repositories/inline-comments.js';
import type { InlineCommentRow } from '../repositories/inline-comments.js';
import { getFileDiff, type FileDiff } from '@octomux/diff-engine';
import { splitLines } from '../inline-comments-outdated.js';
import { ServiceError } from './errors.js';

const execFile = promisify(execFileCb);

export interface CreateInlineCommentInput {
  /** Resolved worktree directory path (caller must have verified it exists). */
  cwd: string;
  task_id: string;
  base_sha: string;
  file_path: string;
  line: number;
  side: 'old' | 'new';
  body: string;
  agent_id: string | null;
  /** Optional anchor commit sha; when absent, HEAD is resolved via git. */
  anchor_commit_sha?: string;
}

/**
 * Create an inline comment on a task diff.
 *
 * Validates the anchor sha, checks the file exists at that commit, verifies
 * line is in range, then inserts the comment row.
 *
 * Throws ServiceError with appropriate status on domain errors.
 */
export async function createInlineComment(
  input: CreateInlineCommentInput,
): Promise<InlineCommentRow> {
  const { cwd, task_id, base_sha, file_path, line, side, body, agent_id, anchor_commit_sha } =
    input;

  // Resolve anchor sha
  let anchorSha: string;
  if (anchor_commit_sha) {
    anchorSha = anchor_commit_sha;
  } else {
    try {
      const { stdout } = await execFile('git', ['-C', cwd, 'rev-parse', 'HEAD']);
      anchorSha = stdout.trim();
    } catch (err) {
      throw new ServiceError((err as Error).message, 500);
    }
  }

  // Get the diff to verify the file is diffed (not binary, etc.)
  let fileDiff: FileDiff;
  try {
    fileDiff = await getFileDiff({
      worktree: cwd,
      base: base_sha,
      relPath: file_path,
    });
  } catch (err) {
    throw new ServiceError((err as Error).message, 500);
  }

  if (fileDiff.binary) {
    throw new ServiceError('cannot comment on binary file', 400);
  }

  // Verify the file exists at the anchor commit and check line range
  let anchoredContent: string;
  try {
    const { stdout } = await execFile('git', ['-C', cwd, 'show', `${anchorSha}:${file_path}`]);
    anchoredContent = stdout;
  } catch {
    throw new ServiceError('file not found at anchor commit', 400);
  }

  const anchoredLineCount = splitLines(anchoredContent).length;
  if (line > anchoredLineCount) {
    throw new ServiceError('line out of range at anchor commit', 400);
  }

  // All checks passed — insert the comment
  const row = addComment({
    task_id,
    agent_id,
    file_path,
    line,
    side,
    original_commit_sha: anchorSha,
    body,
  });

  return row;
}
