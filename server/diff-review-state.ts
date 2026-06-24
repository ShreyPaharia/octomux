import { blobAt, type DiffFileEntry, type DiffSummary } from '@octomux/diff-engine';
import { listReviewState } from './repositories/file-review-state.js';

export interface DecoratedDiffFileEntry extends DiffFileEntry {
  reviewed: boolean;
  reviewed_at: string | null;
  reviewed_at_commit: string | null;
  changed_since_review: boolean;
}

export interface DecoratedDiffSummary extends DiffSummary {
  files: DecoratedDiffFileEntry[];
  reviewed_count: number;
}

/**
 * Join file-review DB state onto an undecorated diff summary from @octomux/diff-engine.
 */
export async function decorateDiffSummaryWithReviewState(
  taskId: string,
  worktree: string,
  summary: DiffSummary,
): Promise<DecoratedDiffSummary> {
  const reviewRows = listReviewState(taskId);
  const reviewByPath = new Map(reviewRows.map((r) => [r.file_path, r]));
  let reviewed_count = 0;

  const files: DecoratedDiffFileEntry[] = [];
  for (const entry of summary.files) {
    const row = reviewByPath.get(entry.path);
    if (!row) {
      files.push({
        ...entry,
        reviewed: false,
        reviewed_at: null,
        reviewed_at_commit: null,
        changed_since_review: false,
      });
      continue;
    }
    let same: boolean;
    if (row.reviewed_blob_sha != null) {
      same = entry.post_blob_sha != null && row.reviewed_blob_sha === entry.post_blob_sha;
    } else {
      const blobAtReviewedCommit = await blobAt({
        worktree,
        commit: row.reviewed_at_commit,
        relPath: entry.path,
      });
      same =
        blobAtReviewedCommit !== null &&
        entry.post_blob_sha != null &&
        blobAtReviewedCommit === entry.post_blob_sha;
    }
    files.push({
      ...entry,
      reviewed: same,
      reviewed_at: row.reviewed_at,
      reviewed_at_commit: row.reviewed_at_commit,
      changed_since_review: !same,
    });
    if (same) reviewed_count++;
  }

  return {
    ...summary,
    files,
    reviewed_count,
  };
}
