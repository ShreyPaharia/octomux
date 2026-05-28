import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InlineCommentCard } from './InlineCommentCard';
import type { InlineCommentDTO } from '../../lib/api';

const { mockPatchComment } = await vi.hoisted(async () => {
  const mockPatchComment = vi.fn();
  return { mockPatchComment };
});
vi.mock('@/lib/api', () => ({
  api: { patchComment: mockPatchComment },
}));

vi.mock('./RejectDialog', () => ({
  RejectDialog: ({
    open,
    onReject,
    onOpenChange,
  }: {
    open: boolean;
    onReject: (why?: string) => Promise<void>;
    onOpenChange: (v: boolean) => void;
  }) =>
    open ? (
      <div data-testid="reject-dialog">
        <button onClick={() => onReject()}>Reject only</button>
        <button onClick={() => onReject('the reason')}>Reject + remember</button>
        <button onClick={() => onOpenChange(false)}>Cancel</button>
      </div>
    ) : null,
}));

function makeDraftComment(overrides: Partial<InlineCommentDTO> = {}): InlineCommentDTO {
  return {
    id: 'c1',
    task_id: 't1',
    file_path: 'src/foo.ts',
    line: 10,
    side: 'new',
    body: 'This needs a fix',
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

describe('InlineCommentCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPatchComment.mockResolvedValue({ ...makeDraftComment(), status: 'accepted' });
  });

  it('renders severity chip, bucket chip, and body', () => {
    render(<InlineCommentCard comment={makeDraftComment()} taskId="t1" onUpdated={() => {}} />);
    expect(screen.getByText('issue')).toBeTruthy();
    expect(screen.getByText('actionable')).toBeTruthy();
    expect(screen.getByText('This needs a fix')).toBeTruthy();
    expect(screen.getByText(/src\/foo.ts:10/)).toBeTruthy();
  });

  it('clicking Accept calls patchComment with status=accepted', async () => {
    const user = userEvent.setup();
    render(<InlineCommentCard comment={makeDraftComment()} taskId="t1" onUpdated={() => {}} />);
    await user.click(screen.getByText('Accept'));
    expect(mockPatchComment).toHaveBeenCalledWith('t1', 'c1', { status: 'accepted' });
  });

  it('clicking Reject opens the RejectDialog', async () => {
    const user = userEvent.setup();
    render(<InlineCommentCard comment={makeDraftComment()} taskId="t1" onUpdated={() => {}} />);
    await user.click(screen.getByText('Reject'));
    expect(screen.getByTestId('reject-dialog')).toBeTruthy();
  });

  it('RejectDialog "Reject only" calls patch without rejection_why', async () => {
    const user = userEvent.setup();
    mockPatchComment.mockResolvedValue({ ...makeDraftComment(), status: 'rejected' });
    render(<InlineCommentCard comment={makeDraftComment()} taskId="t1" onUpdated={() => {}} />);
    await user.click(screen.getByText('Reject'));
    await user.click(screen.getByText('Reject only'));
    await waitFor(() => {
      expect(mockPatchComment).toHaveBeenCalledWith('t1', 'c1', { status: 'rejected' });
    });
  });

  it('RejectDialog "Reject + remember" calls patch with rejection_why', async () => {
    const user = userEvent.setup();
    mockPatchComment.mockResolvedValue({ ...makeDraftComment(), status: 'rejected' });
    render(<InlineCommentCard comment={makeDraftComment()} taskId="t1" onUpdated={() => {}} />);
    await user.click(screen.getByText('Reject'));
    await user.click(screen.getByText('Reject + remember'));
    await waitFor(() => {
      expect(mockPatchComment).toHaveBeenCalledWith('t1', 'c1', {
        status: 'rejected',
        rejection_why: 'the reason',
      });
    });
  });

  it('clicking Edit shows textarea for body', async () => {
    const user = userEvent.setup();
    render(<InlineCommentCard comment={makeDraftComment()} taskId="t1" onUpdated={() => {}} />);
    await user.click(screen.getByText('Edit'));
    expect(screen.getByDisplayValue('This needs a fix')).toBeTruthy();
  });

  it('kind=suggestion shows patch chip and diff preview', () => {
    render(
      <InlineCommentCard
        comment={makeDraftComment({
          kind: 'suggestion',
          existing_code: 'old code',
          suggested_code: 'new code',
        })}
        taskId="t1"
        onUpdated={() => {}}
      />,
    );
    expect(screen.getByText('🔧 patch')).toBeTruthy();
    expect(screen.getByText(/- old code/)).toBeTruthy();
    expect(screen.getByText(/\+ new code/)).toBeTruthy();
  });

  it('stale comment shows yellow border class and stale badge', () => {
    const { container } = render(
      <InlineCommentCard
        comment={makeDraftComment({ status: 'stale' })}
        taskId="t1"
        onUpdated={() => {}}
      />,
    );
    expect(container.querySelector('.border-yellow-600')).toBeTruthy();
    expect(screen.getAllByText(/stale/).length).toBeGreaterThan(0);
  });

  it('auto-resolved comment shows resolved chip and is dimmed', () => {
    const { container } = render(
      <InlineCommentCard
        comment={makeDraftComment({
          auto_resolved_at: '2026-05-28',
          auto_resolved_reason: 'fixed upstream',
        })}
        taskId="t1"
        onUpdated={() => {}}
      />,
    );
    expect(screen.getByText('✓ resolved')).toBeTruthy();
    expect(container.querySelector('.opacity-60')).toBeTruthy();
  });

  it('re_flag_of renders re-flag badge with link', () => {
    render(
      <InlineCommentCard
        comment={makeDraftComment({ re_flag_of: 'abc123' })}
        taskId="t1"
        onUpdated={() => {}}
      />,
    );
    expect(screen.getByText(/↻ re-flag of/)).toBeTruthy();
  });
});
