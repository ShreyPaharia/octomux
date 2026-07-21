import type { InlineCommentDTO } from '@/lib/api/reviewApi';
import type { CommentFilters } from '@/components/review/ReviewFilters';

const SEVERITY_RANK: Record<NonNullable<InlineCommentDTO['severity']>, number> = {
  critical: 0,
  issue: 1,
  suggestion: 2,
  nit: 3,
};

function severityRank(severity: InlineCommentDTO['severity']): number {
  if (!severity) return 4;
  return SEVERITY_RANK[severity] ?? 4;
}

/** Rank findings: blocking severities first, then suggestion, then nit. */
export function rankFindings(comments: InlineCommentDTO[]): InlineCommentDTO[] {
  return [...comments].sort((a, b) => {
    const sev = severityRank(a.severity) - severityRank(b.severity);
    if (sev !== 0) return sev;
    const file = a.file_path.localeCompare(b.file_path);
    if (file !== 0) return file;
    if (a.line !== b.line) return a.line - b.line;
    return a.id.localeCompare(b.id);
  });
}

export function filterFindings(
  comments: InlineCommentDTO[],
  filters: CommentFilters,
): InlineCommentDTO[] {
  return comments.filter((c) => {
    if (filters.severity.length > 0 && (!c.severity || !filters.severity.includes(c.severity))) {
      return false;
    }
    if (filters.bucket.length > 0 && (!c.bucket || !filters.bucket.includes(c.bucket))) {
      return false;
    }
    if (filters.kind.length > 0 && !filters.kind.includes(c.kind)) {
      return false;
    }
    if (!filters.showResolved && c.auto_resolved_at) {
      return false;
    }
    return true;
  });
}

export function prepareFindingQueue(
  comments: InlineCommentDTO[],
  filters: CommentFilters,
): InlineCommentDTO[] {
  return rankFindings(filterFindings(comments, filters));
}
