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

/** Blocking = the few the agent flagged as must-fix (critical / issue). */
export function isBlocking(severity: InlineCommentDTO['severity']): boolean {
  return severity === 'critical' || severity === 'issue';
}

/** Active triage set: draft or accepted, not auto-resolved. History lives in Discussion. */
export function activeFindings(comments: InlineCommentDTO[]): InlineCommentDTO[] {
  return comments.filter(
    (c) => (c.status === 'draft' || c.status === 'accepted') && !c.auto_resolved_at,
  );
}

/** Conversation history: everything that has left the triage queue. */
export function historyFindings(comments: InlineCommentDTO[]): InlineCommentDTO[] {
  return comments.filter(
    (c) =>
      c.status === 'published' ||
      c.status === 'rejected' ||
      c.status === 'stale' ||
      !!c.auto_resolved_at,
  );
}

export interface FindingGroup {
  name: string;
  blocking: InlineCommentDTO[];
  nits: InlineCommentDTO[];
}

interface GroupLike {
  name: string;
  files: { path: string }[];
}

/**
 * Bucket findings under their walkthrough group, blocking-first within each.
 * Groups keep walkthrough order; findings with no group land under "Other".
 * Empty groups are dropped.
 */
export function groupFindings(comments: InlineCommentDTO[], groups: GroupLike[]): FindingGroup[] {
  const pathToGroup = new Map<string, string>();
  for (const g of groups) {
    for (const f of g.files) if (!pathToGroup.has(f.path)) pathToGroup.set(f.path, g.name);
  }
  const order = groups.map((g) => g.name);
  const byName = new Map<string, FindingGroup>();
  const ensure = (name: string): FindingGroup => {
    let fg = byName.get(name);
    if (!fg) {
      fg = { name, blocking: [], nits: [] };
      byName.set(name, fg);
    }
    return fg;
  };
  for (const c of rankFindings(comments)) {
    const fg = ensure(pathToGroup.get(c.file_path) ?? 'Other');
    (isBlocking(c.severity) ? fg.blocking : fg.nits).push(c);
  }
  const rank = (name: string): number => {
    const i = order.indexOf(name);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...byName.values()]
    .sort((a, b) => rank(a.name) - rank(b.name))
    .filter((g) => g.blocking.length + g.nits.length > 0);
}

/** Flatten grouped findings into keyboard-nav order: all blocking first, then nits when shown. */
export function flattenFindingQueue(
  groups: FindingGroup[],
  includeNits: boolean,
): InlineCommentDTO[] {
  const blocking = groups.flatMap((g) => g.blocking);
  const nits = includeNits ? groups.flatMap((g) => g.nits) : [];
  return [...blocking, ...nits];
}
