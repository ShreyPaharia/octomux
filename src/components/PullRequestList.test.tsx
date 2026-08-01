import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PullRequestList } from './PullRequestList';
import type { TaskPullRequest } from '@octomux/types';

function makePr(overrides: Partial<TaskPullRequest> = {}): TaskPullRequest {
  return {
    id: 'pr-1',
    task_id: 'task-1',
    branch: 'agents/task-1',
    base_branch: 'main',
    number: null,
    url: null,
    head_sha: null,
    title: null,
    state: 'open',
    created_at: '2026-01-01 00:00:00',
    updated_at: '2026-01-01 00:00:00',
    ...overrides,
  };
}

describe('PullRequestList', () => {
  it('renders nothing for empty array', () => {
    const { container } = render(<PullRequestList pullRequests={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a row per PR', () => {
    const prs = [
      makePr({ id: 'pr-a', branch: 'feat/a', number: 1, state: 'open' }),
      makePr({ id: 'pr-b', branch: 'feat/b', number: 2, state: 'merged' }),
    ];
    render(<PullRequestList pullRequests={prs} />);
    expect(screen.getByTestId('pr-row-pr-a')).toBeInTheDocument();
    expect(screen.getByTestId('pr-row-pr-b')).toBeInTheDocument();
  });

  it('shows rollup with open/merged/closed counts', () => {
    const prs = [
      makePr({ id: 'pr-1', state: 'open' }),
      makePr({ id: 'pr-2', state: 'open' }),
      makePr({ id: 'pr-3', state: 'merged' }),
      makePr({ id: 'pr-4', state: 'closed' }),
    ];
    render(<PullRequestList pullRequests={prs} />);
    const rollup = screen.getByTestId('pr-rollup');
    expect(rollup).toHaveTextContent('2 open');
    expect(rollup).toHaveTextContent('1 merged');
    expect(rollup).toHaveTextContent('1 closed');
  });

  it('rollup omits zero-count states', () => {
    const prs = [makePr({ id: 'pr-1', state: 'open' })];
    render(<PullRequestList pullRequests={prs} />);
    const rollup = screen.getByTestId('pr-rollup');
    expect(rollup.textContent).toBe('1 open');
    expect(rollup.textContent).not.toContain('merged');
    expect(rollup.textContent).not.toContain('closed');
  });

  it('renders PR number as a link when url is present', () => {
    const pr = makePr({
      id: 'pr-link',
      number: 42,
      url: 'https://github.com/org/repo/pull/42',
    });
    render(<PullRequestList pullRequests={[pr]} />);
    const link = screen.getByRole('link', { name: '#42' });
    expect(link).toHaveAttribute('href', 'https://github.com/org/repo/pull/42');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('renders branch name when number and url are null', () => {
    const pr = makePr({ id: 'pr-no-num', branch: 'agents/abc123', number: null, url: null });
    render(<PullRequestList pullRequests={[pr]} />);
    expect(screen.getAllByText('agents/abc123').length).toBeGreaterThan(0);
  });

  it('shows state badge for each PR', () => {
    const prs = [
      makePr({ id: 'pr-open', state: 'open' }),
      makePr({ id: 'pr-merged', state: 'merged' }),
      makePr({ id: 'pr-closed', state: 'closed' }),
    ];
    render(<PullRequestList pullRequests={prs} />);
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByText('merged')).toBeInTheDocument();
    expect(screen.getByText('closed')).toBeInTheDocument();
  });
});
