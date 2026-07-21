import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FindingQueue } from './FindingQueue';
import type { InlineCommentDTO } from '@/lib/api/reviewApi';

const { mockPatchComment } = await vi.hoisted(async () => ({
  mockPatchComment: vi.fn(),
}));
vi.mock('@/lib/api/reviewApi', () => ({
  reviewApi: { patchComment: mockPatchComment },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function makeComment(overrides: Partial<InlineCommentDTO> = {}): InlineCommentDTO {
  return {
    id: 'c1',
    task_id: 't1',
    file_path: 'src/foo.ts',
    line: 10,
    side: 'new',
    body: 'fix this',
    status: 'draft',
    kind: 'comment',
    severity: 'issue',
    bucket: 'actionable',
    existing_code: null,
    suggested_code: null,
    re_flag_of: null,
    auto_resolved_at: null,
    auto_resolved_reason: null,
    github_comment_id: null,
    review_run_id: 'r1',
    ...overrides,
  };
}

describe('FindingQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPatchComment.mockImplementation(async (_t, _id, patch) => ({
      ...makeComment(),
      ...patch,
    }));
  });

  it('shows severity and category on queue items', () => {
    render(
      <FindingQueue
        taskId="t1"
        comments={[makeComment()]}
        selectedId="c1"
        onSelect={() => {}}
        onUpdated={() => {}}
        onJumpToCode={() => {}}
      />,
    );
    expect(screen.getAllByText('issue').length).toBeGreaterThan(0);
    expect(screen.getAllByText('actionable').length).toBeGreaterThan(0);
  });

  it('accept via card calls onUpdated', async () => {
    const user = userEvent.setup();
    const onUpdated = vi.fn();
    render(
      <FindingQueue
        taskId="t1"
        comments={[makeComment()]}
        selectedId="c1"
        onSelect={() => {}}
        onUpdated={onUpdated}
        onJumpToCode={() => {}}
      />,
    );
    await user.click(screen.getByText('Accept'));
    await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled());
  });
});
