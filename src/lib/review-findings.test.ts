import { describe, it, expect } from 'vitest';
import type { InlineCommentDTO } from '@/lib/api/reviewApi';
import { rankFindings, prepareFindingQueue } from './review-findings';
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
