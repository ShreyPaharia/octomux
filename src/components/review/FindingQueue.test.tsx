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

const GROUPS = [{ name: 'Core', summary: '', files: [{ path: 'src/foo.ts' }] }];

describe('FindingQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPatchComment.mockImplementation(async (_t, _id, patch) => ({
      ...makeComment(),
      ...patch,
    }));
  });

  it('shows severity and category on the selected card', () => {
    render(
      <FindingQueue
        taskId="t1"
        comments={[makeComment()]}
        groups={GROUPS}
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
        groups={GROUPS}
        selectedId="c1"
        onSelect={() => {}}
        onUpdated={onUpdated}
        onJumpToCode={() => {}}
      />,
    );
    await user.click(screen.getByText('Accept'));
    await vi.waitFor(() => expect(onUpdated).toHaveBeenCalled());
  });

  it('groups blocking findings by walkthrough group and collapses nits by default', () => {
    render(
      <FindingQueue
        taskId="t1"
        comments={[
          makeComment({ id: 'b1', severity: 'critical', body: 'blocking bug' }),
          makeComment({ id: 'n1', severity: 'nit', body: 'tiny nit' }),
        ]}
        groups={GROUPS}
        selectedId="b1"
        onSelect={() => {}}
        onUpdated={() => {}}
        onJumpToCode={() => {}}
      />,
    );
    // Blocking is grouped and shown.
    expect(screen.getByTestId('finding-group-Core')).toBeTruthy();
    expect(screen.getByTestId('finding-queue-item-b1')).toBeTruthy();
    // Nits are collapsed behind a disclosure — the row is not rendered until expanded.
    expect(screen.getByTestId('finding-nits-toggle')).toBeTruthy();
    expect(screen.queryByTestId('finding-queue-item-n1')).toBeNull();
  });

  it('expands nits when the disclosure is clicked', async () => {
    const user = userEvent.setup();
    render(
      <FindingQueue
        taskId="t1"
        comments={[makeComment({ id: 'n1', severity: 'nit', body: 'tiny nit' })]}
        groups={GROUPS}
        selectedId={null}
        onSelect={() => {}}
        onUpdated={() => {}}
        onJumpToCode={() => {}}
      />,
    );
    expect(screen.queryByTestId('finding-queue-item-n1')).toBeNull();
    await user.click(screen.getByTestId('finding-nits-toggle'));
    expect(screen.getByTestId('finding-queue-item-n1')).toBeTruthy();
  });
});
