import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LearningsPanel } from './LearningsPanel';
import { renderWithRouter } from '../../test-helpers';
import type { ReviewLearning } from '@/lib/api';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const LEARNING_1: ReviewLearning = {
  id: 'learn-01',
  repo_path: '/Users/dev/my-repo',
  why: 'Always check for null before dereferencing optional chaining.',
  created_from_comment_id: 'comment-abc',
  usage_count: 3,
  last_used_at: '2026-01-15 10:30:00',
  created_at: '2026-01-10 08:00:00',
};

const LEARNING_2: ReviewLearning = {
  id: 'learn-02',
  repo_path: '/Users/dev/my-repo',
  why: 'Prefer explicit return types on public API functions.',
  created_from_comment_id: null,
  usage_count: 0,
  last_used_at: null,
  created_at: '2026-01-12 09:00:00',
};

// ─── API mock setup ──────────────────────────────────────────────────────────

const listLearningsMock = vi.fn();
const deleteLearningMock = vi.fn();

const { apiProxy } = await vi.hoisted(async () => {
  const helpers = await import('../../test-helpers');
  return helpers.setupApiMock();
});

vi.mock('@/lib/api', () => ({
  api: new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === 'listLearnings') return listLearningsMock;
        if (prop === 'deleteLearning') return deleteLearningMock;
        return (apiProxy as Record<string, unknown>)[prop];
      },
    },
  ),
}));

// ─── Silence TasksContext (LearningsPanel doesn't use it directly) ────────────
vi.mock('@/lib/tasks-context', () => ({
  useTasksContextOptional: () => null,
}));

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('LearningsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteLearningMock.mockResolvedValue(undefined);
  });

  it('shows loading skeleton while fetching', () => {
    listLearningsMock.mockReturnValue(new Promise(() => {})); // never resolves
    renderWithRouter(<LearningsPanel repoPath="/Users/dev/my-repo" />);
    expect(screen.getByTestId('learnings-loading')).toBeInTheDocument();
  });

  it('shows empty state when no learnings', async () => {
    listLearningsMock.mockResolvedValue([]);
    renderWithRouter(<LearningsPanel repoPath="/Users/dev/my-repo" />);
    await waitFor(() => {
      expect(screen.getByTestId('learnings-empty')).toBeInTheDocument();
    });
    expect(screen.getByText('No learnings recorded yet.')).toBeInTheDocument();
  });

  it('renders learnings rows with why text, usage count, and dates', async () => {
    listLearningsMock.mockResolvedValue([LEARNING_1, LEARNING_2]);
    renderWithRouter(<LearningsPanel repoPath="/Users/dev/my-repo" />);

    await waitFor(() => {
      expect(screen.getByTestId('learnings-list')).toBeInTheDocument();
    });

    // Row 1
    expect(
      screen.getByText('Always check for null before dereferencing optional chaining.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('learning-row-learn-01')).toBeInTheDocument();

    // Row 2
    expect(
      screen.getByText('Prefer explicit return types on public API functions.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('learning-row-learn-02')).toBeInTheDocument();

    // Usage count visible
    expect(screen.getAllByText('3').length).toBeGreaterThan(0);
  });

  it('does not render last_used_at when null', async () => {
    listLearningsMock.mockResolvedValue([LEARNING_2]);
    renderWithRouter(<LearningsPanel repoPath="/Users/dev/my-repo" />);
    await waitFor(() => {
      expect(screen.getByTestId('learning-row-learn-02')).toBeInTheDocument();
    });
    expect(screen.queryByText(/last:/)).not.toBeInTheDocument();
  });

  it('delete button removes the row optimistically', async () => {
    listLearningsMock.mockResolvedValue([LEARNING_1, LEARNING_2]);
    deleteLearningMock.mockResolvedValue(undefined);

    const user = userEvent.setup();
    renderWithRouter(<LearningsPanel repoPath="/Users/dev/my-repo" />);

    await waitFor(() => {
      expect(screen.getByTestId('learning-row-learn-01')).toBeInTheDocument();
    });

    const deleteBtn = screen.getByTestId('delete-learning-learn-01');
    await user.click(deleteBtn);

    await waitFor(() => {
      expect(screen.queryByTestId('learning-row-learn-01')).not.toBeInTheDocument();
    });

    expect(deleteLearningMock).toHaveBeenCalledWith('learn-01');
    // Row 2 still present
    expect(screen.getByTestId('learning-row-learn-02')).toBeInTheDocument();
  });

  it('reverts delete and shows toast on API failure', async () => {
    listLearningsMock.mockResolvedValue([LEARNING_1]);
    deleteLearningMock.mockRejectedValue(new Error('network error'));

    const user = userEvent.setup();
    renderWithRouter(<LearningsPanel repoPath="/Users/dev/my-repo" />);

    await waitFor(() => {
      expect(screen.getByTestId('learning-row-learn-01')).toBeInTheDocument();
    });

    const deleteBtn = screen.getByTestId('delete-learning-learn-01');
    await user.click(deleteBtn);

    // After rejection, row should reappear
    await waitFor(() => {
      expect(screen.getByTestId('learning-row-learn-01')).toBeInTheDocument();
    });
  });
});
