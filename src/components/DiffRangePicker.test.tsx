import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);

vi.mock('@/lib/api', async () => {
  const actual = (await vi.importActual('@/lib/api')) as Record<string, unknown>;
  return { ...actual, api: apiProxy };
});

const { DiffRangePicker } = await import('./DiffRangePicker');

beforeEach(() => {
  vi.restoreAllMocks();
  (apiMock as any).listTaskBranches = vi.fn().mockResolvedValue({
    branches: ['main', 'develop', 'feature/x'],
    current: 'feature/x',
    default: 'main',
  });
  (apiMock as any).listTaskCommits = vi.fn().mockResolvedValue({
    commits: [
      {
        sha: 'abcdef0123456789abcdef0123456789abcdef01',
        short_sha: 'abcdef0',
        subject: 'fix(diff): something',
        author: 'Alice',
        author_email: 'alice@example.com',
        authored_at: '2026-04-30T12:00:00Z',
      },
    ],
    truncated: false,
  });
  (apiMock as any).updateTaskBase = vi.fn().mockResolvedValue({});
});

describe('DiffRangePicker', () => {
  it('renders branches and selecting + saving calls onBaseChange', async () => {
    const onBaseChange = vi.fn().mockResolvedValue(undefined);
    const onRangeChange = vi.fn();
    render(
      <DiffRangePicker
        taskId="t1"
        currentBaseBranch="main"
        range={{ kind: 'base' }}
        onBaseChange={onBaseChange}
        onRangeChange={onRangeChange}
      />,
    );
    fireEvent.click(screen.getByTestId('diff-range-picker-trigger'));
    await waitFor(() => screen.getByText('develop'));
    fireEvent.click(screen.getByText('develop'));
    fireEvent.click(screen.getByTestId('diff-range-picker-save-base'));
    await waitFor(() => expect(onBaseChange).toHaveBeenCalledWith('develop'));
    expect(onRangeChange).toHaveBeenCalledWith({ kind: 'base' });
  });

  it('selecting Single commit loads commits and emits commit:<sha>', async () => {
    const onRangeChange = vi.fn();
    render(
      <DiffRangePicker
        taskId="t1"
        currentBaseBranch="main"
        range={{ kind: 'base' }}
        onBaseChange={vi.fn()}
        onRangeChange={onRangeChange}
      />,
    );
    fireEvent.click(screen.getByTestId('diff-range-picker-trigger'));
    fireEvent.click(screen.getByTestId('diff-range-radio-commit'));
    const row = await screen.findByTestId('commit-row-abcdef0');
    fireEvent.click(within(row).getByText('fix(diff): something'));
    expect(onRangeChange).toHaveBeenCalledWith({
      kind: 'commit',
      sha: 'abcdef0123456789abcdef0123456789abcdef01',
    });
  });

  it('working radio emits range=working immediately', async () => {
    const onRangeChange = vi.fn();
    render(
      <DiffRangePicker
        taskId="t1"
        currentBaseBranch="main"
        range={{ kind: 'base' }}
        onBaseChange={vi.fn()}
        onRangeChange={onRangeChange}
      />,
    );
    fireEvent.click(screen.getByTestId('diff-range-picker-trigger'));
    fireEvent.click(screen.getByTestId('diff-range-radio-working'));
    expect(onRangeChange).toHaveBeenCalledWith({ kind: 'working' });
  });

  it('shows truncated banner when listTaskCommits returns truncated=true', async () => {
    (apiMock as any).listTaskCommits = vi.fn().mockResolvedValue({
      commits: [
        {
          sha: '1111111111111111111111111111111111111111',
          short_sha: '1111111',
          subject: 'first',
          author: 'A',
          author_email: 'a@a',
          authored_at: '2026-04-30T12:00:00Z',
        },
      ],
      truncated: true,
    });
    render(
      <DiffRangePicker
        taskId="t1"
        currentBaseBranch="main"
        range={{ kind: 'base' }}
        onBaseChange={vi.fn()}
        onRangeChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('diff-range-picker-trigger'));
    fireEvent.click(screen.getByTestId('diff-range-radio-commit'));
    await waitFor(() => screen.getByText(/most recent 200 commits/i));
  });
});
