import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
