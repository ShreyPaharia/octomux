import { describe, it, expect } from 'vitest';
import type { InlineCommentDTO } from '@/lib/api/reviewApi';
import {
  rankFindings,
  prepareFindingQueue,
  isBlocking,
  activeFindings,
  historyFindings,
  groupFindings,
  flattenFindingQueue,
} from './review-findings';
import type { CommentFilters } from '@/components/review/ReviewFilters';

function comment(overrides: Partial<InlineCommentDTO> = {}): InlineCommentDTO {
  return {
    id: 'c',
    task_id: 't1',
    file_path: 'a.ts',
    line: 1,
    side: 'new',
    body: 'x',
    status: 'draft',
    kind: 'comment',
    severity: 'nit',
    bucket: null,
    existing_code: null,
    suggested_code: null,
    re_flag_of: null,
    auto_resolved_at: null,
    auto_resolved_reason: null,
    github_comment_id: null,
    review_run_id: null,
    ...overrides,
  };
}

const EMPTY_FILTERS: CommentFilters = {
  severity: [],
  bucket: [],
  kind: [],
  showResolved: false,
};

describe('rankFindings', () => {
  it('orders critical before issue before suggestion before nit', () => {
    const ranked = rankFindings([
      comment({ id: '1', severity: 'nit' }),
      comment({ id: '2', severity: 'critical' }),
      comment({ id: '3', severity: 'suggestion' }),
      comment({ id: '4', severity: 'issue' }),
    ]);
    expect(ranked.map((c) => c.id)).toEqual(['2', '4', '3', '1']);
  });
});

describe('prepareFindingQueue', () => {
  it('applies severity filters', () => {
    const queue = prepareFindingQueue(
      [comment({ id: '1', severity: 'nit' }), comment({ id: '2', severity: 'critical' })],
      { ...EMPTY_FILTERS, severity: ['critical'] },
    );
    expect(queue.map((c) => c.id)).toEqual(['2']);
  });
});

describe('blocking / active / history partitions', () => {
  it('treats critical and issue as blocking, suggestion and nit as not', () => {
    expect(isBlocking('critical')).toBe(true);
    expect(isBlocking('issue')).toBe(true);
    expect(isBlocking('suggestion')).toBe(false);
    expect(isBlocking('nit')).toBe(false);
    expect(isBlocking(null)).toBe(false);
  });

  it('active = draft|accepted and not auto-resolved; history = everything else', () => {
    const all = [
      comment({ id: 'd', status: 'draft' }),
      comment({ id: 'a', status: 'accepted' }),
      comment({ id: 'p', status: 'published' }),
      comment({ id: 'x', status: 'rejected' }),
      comment({ id: 's', status: 'stale' }),
      comment({ id: 'ar', status: 'draft', auto_resolved_at: '2026-01-01' }),
    ];
    expect(activeFindings(all).map((c) => c.id)).toEqual(['d', 'a']);
    expect(
      historyFindings(all)
        .map((c) => c.id)
        .sort(),
    ).toEqual(['ar', 'p', 's', 'x']);
  });
});

describe('groupFindings', () => {
  const groups = [
    { name: 'Core', files: [{ path: 'a.ts' }] },
    { name: 'Edges', files: [{ path: 'b.ts' }] },
  ];

  it('buckets findings under their walkthrough group, blocking-first, orphans to Other', () => {
    const result = groupFindings(
      [
        comment({ id: 'a-nit', file_path: 'a.ts', severity: 'nit' }),
        comment({ id: 'a-crit', file_path: 'a.ts', severity: 'critical' }),
        comment({ id: 'b-issue', file_path: 'b.ts', severity: 'issue' }),
        comment({ id: 'orphan', file_path: 'z.ts', severity: 'nit' }),
      ],
      groups,
    );
    expect(result.map((g) => g.name)).toEqual(['Core', 'Edges', 'Other']);
    expect(result[0].blocking.map((c) => c.id)).toEqual(['a-crit']);
    expect(result[0].nits.map((c) => c.id)).toEqual(['a-nit']);
    expect(result[1].blocking.map((c) => c.id)).toEqual(['b-issue']);
    expect(result[2].nits.map((c) => c.id)).toEqual(['orphan']);
  });

  it('flattens to blocking-first order, appending nits only when requested', () => {
    const result = groupFindings(
      [
        comment({ id: 'a-nit', file_path: 'a.ts', severity: 'nit' }),
        comment({ id: 'a-crit', file_path: 'a.ts', severity: 'critical' }),
      ],
      groups,
    );
    expect(flattenFindingQueue(result, false).map((c) => c.id)).toEqual(['a-crit']);
    expect(flattenFindingQueue(result, true).map((c) => c.id)).toEqual(['a-crit', 'a-nit']);
  });
});
