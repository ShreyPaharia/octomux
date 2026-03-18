import { renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { makeTask } from '../test-helpers';
import { useAttentionIndicator } from './use-attention-indicator';

describe('useAttentionIndicator', () => {
  beforeEach(() => {
    document.title = 'octomux';
  });

  it.each([
    {
      name: 'no attention tasks → plain title',
      tasks: [makeTask({ status: 'running', derived_status: 'working' })],
      expected: 'octomux',
    },
    {
      name: 'one needs_attention → (1) octomux',
      tasks: [makeTask({ status: 'running', derived_status: 'needs_attention' })],
      expected: '(1) octomux',
    },
    {
      name: 'one error → (1) octomux',
      tasks: [makeTask({ status: 'error' })],
      expected: '(1) octomux',
    },
    {
      name: 'mixed attention and normal → counts only attention',
      tasks: [
        makeTask({ id: '1', status: 'running', derived_status: 'needs_attention' }),
        makeTask({ id: '2', status: 'error' }),
        makeTask({ id: '3', status: 'running', derived_status: 'working' }),
        makeTask({ id: '4', status: 'closed' }),
      ],
      expected: '(2) octomux',
    },
    {
      name: 'empty tasks → plain title',
      tasks: [],
      expected: 'octomux',
    },
  ])('$name', ({ tasks, expected }) => {
    renderHook(() => useAttentionIndicator(tasks));
    expect(document.title).toBe(expected);
  });

  it('resets title on unmount', () => {
    const { unmount } = renderHook(() =>
      useAttentionIndicator([makeTask({ status: 'error' })]),
    );
    expect(document.title).toBe('(1) octomux');
    unmount();
    expect(document.title).toBe('octomux');
  });

  it('updates when tasks change', () => {
    const { rerender } = renderHook(({ tasks }) => useAttentionIndicator(tasks), {
      initialProps: { tasks: [makeTask({ status: 'error' })] },
    });
    expect(document.title).toBe('(1) octomux');

    rerender({ tasks: [makeTask({ status: 'running', derived_status: 'working' })] });
    expect(document.title).toBe('octomux');
  });
});
