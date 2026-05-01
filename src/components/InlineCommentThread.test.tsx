import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { InlineCommentThread } from './InlineCommentThread';
import type { InlineCommentWithOutdated } from '@/lib/api';
import { makeAgent } from '../test-helpers';

function comment(o: Partial<InlineCommentWithOutdated> = {}): InlineCommentWithOutdated {
  return {
    id: 'c1',
    task_id: 't1',
    agent_id: null,
    file_path: 'src/foo.ts',
    line: 10,
    side: 'new',
    original_commit_sha: 'abc1234567',
    body: 'looks good',
    created_at: '2026-05-02 00:00:00',
    resolved_at: null,
    outdated: false,
    ...o,
  };
}

const noopHandlers = {
  onReply: vi.fn(),
  onResolve: vi.fn(),
  onDelete: vi.fn(),
  onEdit: vi.fn(),
};

describe('InlineCommentThread', () => {
  it('renders the comment body and author', () => {
    render(
      <InlineCommentThread
        comments={[comment()]}
        agents={[]}
        rangeIsBase={true}
        outdatedUnavailable={false}
        {...noopHandlers}
      />,
    );
    expect(screen.getByText('looks good')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
  });

  it('shows agent label and green dot for agent comments', () => {
    const agent = makeAgent({ id: 'agent-99', label: 'GPT' });
    render(
      <InlineCommentThread
        comments={[comment({ agent_id: 'agent-99' })]}
        agents={[agent]}
        rangeIsBase={true}
        outdatedUnavailable={false}
        {...noopHandlers}
      />,
    );
    expect(screen.getByText('GPT')).toBeInTheDocument();
  });

  it('shows the Outdated chip when outdated and on base range', () => {
    render(
      <InlineCommentThread
        comments={[comment({ outdated: true })]}
        agents={[]}
        rangeIsBase={true}
        outdatedUnavailable={false}
        {...noopHandlers}
      />,
    );
    expect(screen.getByText('Outdated')).toBeInTheDocument();
  });

  it('hides Outdated chip and shows "Posted on" pill on non-base ranges', () => {
    render(
      <InlineCommentThread
        comments={[comment({ outdated: true })]}
        agents={[]}
        rangeIsBase={false}
        outdatedUnavailable={false}
        {...noopHandlers}
      />,
    );
    expect(screen.queryByText('Outdated')).not.toBeInTheDocument();
    expect(screen.getByText(/Posted on abc1234/)).toBeInTheDocument();
  });

  it('shows Unknown chip when outdated_unavailable on base range', () => {
    render(
      <InlineCommentThread
        comments={[comment()]}
        agents={[]}
        rangeIsBase={true}
        outdatedUnavailable={true}
        {...noopHandlers}
      />,
    );
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('shows Resolved chip and Unresolve action when resolved_at is set', () => {
    const onResolve = vi.fn();
    render(
      <InlineCommentThread
        comments={[comment({ resolved_at: '2026-05-02 00:01:00' })]}
        agents={[]}
        rangeIsBase={true}
        outdatedUnavailable={false}
        {...noopHandlers}
        onResolve={onResolve}
      />,
    );
    expect(screen.getByText('Resolved')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unresolve comment' }));
    expect(onResolve).toHaveBeenCalledWith('c1', false);
  });

  it('Resolve button toggles to resolved=true', () => {
    const onResolve = vi.fn();
    render(
      <InlineCommentThread
        comments={[comment()]}
        agents={[]}
        rangeIsBase={true}
        outdatedUnavailable={false}
        {...noopHandlers}
        onResolve={onResolve}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Resolve comment' }));
    expect(onResolve).toHaveBeenCalledWith('c1', true);
  });

  it('hides Edit/Delete actions on agent comments (not own)', () => {
    render(
      <InlineCommentThread
        comments={[comment({ agent_id: 'agent-99' })]}
        agents={[makeAgent({ id: 'agent-99', label: 'A' })]}
        rangeIsBase={true}
        outdatedUnavailable={false}
        {...noopHandlers}
      />,
    );
    expect(screen.queryByText('Edit')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete comment' })).not.toBeInTheDocument();
  });

  it('Delete-own fires onDelete', () => {
    const onDelete = vi.fn();
    render(
      <InlineCommentThread
        comments={[comment()]}
        agents={[]}
        rangeIsBase={true}
        outdatedUnavailable={false}
        {...noopHandlers}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete comment' }));
    expect(onDelete).toHaveBeenCalledWith('c1');
  });

  it('edit mode saves new body via onEdit', () => {
    const onEdit = vi.fn();
    render(
      <InlineCommentThread
        comments={[comment()]}
        agents={[]}
        rangeIsBase={true}
        outdatedUnavailable={false}
        {...noopHandlers}
        onEdit={onEdit}
      />,
    );
    fireEvent.click(screen.getByText('Edit'));
    const ta = screen.getByLabelText('Edit comment') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'updated body' } });
    fireEvent.click(screen.getByText('Save'));
    expect(onEdit).toHaveBeenCalledWith('c1', 'updated body');
  });

  it('Reply submits the textarea body', () => {
    const onReply = vi.fn();
    render(
      <InlineCommentThread
        comments={[comment()]}
        agents={[]}
        rangeIsBase={true}
        outdatedUnavailable={false}
        {...noopHandlers}
        onReply={onReply}
      />,
    );
    const ta = screen.getByLabelText('Reply') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'replying' } });
    fireEvent.click(screen.getByText('Reply'));
    expect(onReply).toHaveBeenCalledWith('replying');
  });

  it('flashes when focusedId matches a comment', () => {
    render(
      <InlineCommentThread
        comments={[comment({ id: 'c1' })]}
        agents={[]}
        rangeIsBase={true}
        outdatedUnavailable={false}
        focusedId="c1"
        {...noopHandlers}
      />,
    );
    const thread = screen.getByTestId('inline-comment-thread');
    expect(thread.dataset.focused).toBe('true');
  });

  it('renders multiple comments in order', () => {
    render(
      <InlineCommentThread
        comments={[
          comment({ id: 'c1', body: 'first' }),
          comment({ id: 'c2', body: 'second' }),
        ]}
        agents={[]}
        rangeIsBase={true}
        outdatedUnavailable={false}
        {...noopHandlers}
      />,
    );
    const items = screen.getAllByTestId(/^inline-comment-c/);
    expect(items.map((el) => el.dataset.commentId)).toEqual(['c1', 'c2']);
    expect(within(items[0]).getByText('first')).toBeInTheDocument();
    expect(within(items[1]).getByText('second')).toBeInTheDocument();
  });
});
