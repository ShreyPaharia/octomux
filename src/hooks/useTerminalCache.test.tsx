import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { _resetPerTaskUiState, setPerTaskUiState } from './perTaskUiState';
import { useTerminalCache } from './useTerminalCache';

function wrapper({ children }: { children: React.ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

describe('useTerminalCache', () => {
  beforeEach(() => {
    _resetPerTaskUiState();
  });

  it('seeds LRU from perTaskUiState on task switch', () => {
    setPerTaskUiState('task-A', { activeWindow: 2, mode: 'agents' });

    const { result, rerender } = renderHook(
      ({ taskId, activeWindow }) =>
        useTerminalCache({
          taskId,
          activeWindow,
          validWindowIndexes: new Set([0, 1, 2]),
        }),
      {
        wrapper,
        initialProps: { taskId: 'task-B', activeWindow: null as number | null },
      },
    );

    expect(result.current.terminalLRU).toEqual([]);

    rerender({ taskId: 'task-A', activeWindow: 2 });

    expect(result.current.terminalLRU).toEqual([2]);
  });

  it('promotes active window to front of LRU', () => {
    const { result, rerender } = renderHook(
      ({ activeWindow }) =>
        useTerminalCache({
          taskId: 'task-1',
          activeWindow,
          validWindowIndexes: new Set([0, 1, 2]),
        }),
      {
        wrapper,
        initialProps: { activeWindow: 0 as number | null },
      },
    );

    expect(result.current.terminalLRU).toEqual([0]);

    rerender({ activeWindow: 1 });
    expect(result.current.terminalLRU).toEqual([1, 0]);

    rerender({ activeWindow: 2 });
    expect(result.current.terminalLRU).toEqual([2, 1, 0]);
  });

  it('evicts invalid window indexes from LRU', () => {
    const { result, rerender } = renderHook(
      ({ activeWindow, validWindowIndexes }) =>
        useTerminalCache({ taskId: 'task-1', activeWindow, validWindowIndexes }),
      {
        wrapper,
        initialProps: {
          activeWindow: 2 as number | null,
          validWindowIndexes: new Set([0, 1, 2]),
        },
      },
    );

    expect(result.current.terminalLRU).toEqual([2]);

    rerender({ activeWindow: 1, validWindowIndexes: new Set([0, 1, 2]) });
    expect(result.current.terminalLRU).toEqual([1, 2]);

    rerender({ activeWindow: 1, validWindowIndexes: new Set([0, 1]) });
    expect(result.current.terminalLRU).toEqual([1]);
  });
});
