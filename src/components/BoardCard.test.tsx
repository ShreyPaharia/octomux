import { describe, it, expect, beforeEach, afterEach, vi } from '../bun-test.js';
import { screen, act } from '@testing-library/react';
import { BoardCard } from './BoardCard';
import { makeTask, renderWithRouter } from '../test-helpers';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('BoardCard duration label', () => {
  it('ticks every second for running tasks', () => {
    vi.setSystemTime(new Date('2026-01-01T00:01:14Z'));
    const task = makeTask({ runtime_state: 'running', created_at: '2026-01-01 00:00:00' });

    renderWithRouter(<BoardCard task={task} />);

    expect(screen.getByTestId('task-duration')).toHaveTextContent('Running 1m 14s');

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId('task-duration')).toHaveTextContent('Running 1m 15s');

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId('task-duration')).toHaveTextContent('Running 1m 16s');
  });

  it('shows a static final duration for closed (idle) tasks', () => {
    vi.setSystemTime(new Date('2026-01-01T02:00:00Z'));
    const task = makeTask({
      runtime_state: 'idle',
      created_at: '2026-01-01 00:00:00',
      updated_at: '2026-01-01 00:08:00',
    });

    renderWithRouter(<BoardCard task={task} />);

    expect(screen.getByTestId('task-duration')).toHaveTextContent('Closed after 8m 0s');

    // No ticking for terminal states.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByTestId('task-duration')).toHaveTextContent('Closed after 8m 0s');
  });

  it('shows a static final duration for error tasks', () => {
    vi.setSystemTime(new Date('2026-01-01T02:00:00Z'));
    const task = makeTask({
      runtime_state: 'error',
      created_at: '2026-01-01 00:00:00',
      updated_at: '2026-01-01 00:00:30',
    });

    renderWithRouter(<BoardCard task={task} />);

    expect(screen.getByTestId('task-duration')).toHaveTextContent('Failed after 30s');
  });
});

describe('BoardCard summary/activity fallback', () => {
  it('renders the authored summary when both summary and activity are present', () => {
    const task = makeTask({
      runtime_state: 'running',
      current_summary: 'Wrote the fix',
      current_summary_updated_at: '2026-01-01 00:00:00',
      current_activity: 'Bash: npm test',
      current_activity_updated_at: '2026-01-01 00:00:05',
    });

    renderWithRouter(<BoardCard task={task} />);

    expect(screen.getByText('Wrote the fix')).toBeInTheDocument();
    expect(screen.queryByText('Bash: npm test')).not.toBeInTheDocument();
  });

  it('renders activity when only activity is present', () => {
    const task = makeTask({
      runtime_state: 'running',
      current_summary: null,
      current_summary_updated_at: null,
      current_activity: 'Bash: npm test',
      current_activity_updated_at: '2026-01-01 00:00:05',
    });

    renderWithRouter(<BoardCard task={task} />);

    expect(screen.getByText('Bash: npm test')).toBeInTheDocument();
  });

  it("renders '—' when neither summary nor activity is present", () => {
    const task = makeTask({
      runtime_state: 'running',
      current_summary: null,
      current_summary_updated_at: null,
      current_activity: null,
      current_activity_updated_at: null,
    });

    renderWithRouter(<BoardCard task={task} />);

    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('is not stale when activity is fresh but the authored summary is old', () => {
    vi.setSystemTime(new Date('2026-01-01T02:00:00Z'));
    const task = makeTask({
      runtime_state: 'running',
      current_summary: 'Old summary',
      current_summary_updated_at: '2025-12-01 00:00:00',
      current_activity: 'Bash: npm test',
      current_activity_updated_at: '2026-01-01 01:59:00',
    });

    renderWithRouter(<BoardCard task={task} />);

    const summary = screen.getByText('Old summary');
    expect(summary.className).toContain('text-muted-foreground');
    expect(summary.className).not.toContain('text-muted-soft');
  });
});
