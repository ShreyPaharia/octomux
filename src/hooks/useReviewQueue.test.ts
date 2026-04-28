import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReviewQueue } from './useReviewQueue.js';

describe('useReviewQueue', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts empty for a fresh task', () => {
    const { result } = renderHook(() => useReviewQueue('t1'));
    expect(result.current.comments).toEqual([]);
  });

  it('add() appends a comment', () => {
    const { result } = renderHook(() => useReviewQueue('t1'));
    act(() => {
      result.current.add({ filePath: 'src/foo.ts', line: 10, lineText: '> if (x) {', body: 'wat' });
    });
    expect(result.current.comments).toHaveLength(1);
  });

  it('persists across hook re-mounts via localStorage', () => {
    const { result, unmount } = renderHook(() => useReviewQueue('t1'));
    act(() => {
      result.current.add({ filePath: 'src/foo.ts', line: 10, lineText: '> x', body: 'wat' });
    });
    unmount();
    const { result: result2 } = renderHook(() => useReviewQueue('t1'));
    expect(result2.current.comments).toHaveLength(1);
  });

  it('isolates by task id', () => {
    const { result: a } = renderHook(() => useReviewQueue('t1'));
    act(() => a.current.add({ filePath: 'a', line: 1, lineText: '', body: 'A' }));
    const { result: b } = renderHook(() => useReviewQueue('t2'));
    expect(b.current.comments).toEqual([]);
  });

  it('remove() drops the comment by id', () => {
    const { result } = renderHook(() => useReviewQueue('t1'));
    act(() => result.current.add({ filePath: 'a', line: 1, lineText: '', body: 'A' }));
    const id = result.current.comments[0].id;
    act(() => result.current.remove(id));
    expect(result.current.comments).toEqual([]);
  });

  it('clear() empties the queue', () => {
    const { result } = renderHook(() => useReviewQueue('t1'));
    act(() => result.current.add({ filePath: 'a', line: 1, lineText: '', body: 'A' }));
    act(() => result.current.add({ filePath: 'b', line: 2, lineText: '', body: 'B' }));
    act(() => result.current.clear());
    expect(result.current.comments).toEqual([]);
  });

  it('format() emits the agent-message body', () => {
    const { result } = renderHook(() => useReviewQueue('t1'));
    act(() => {
      result.current.add({ filePath: 'src/a.ts', line: 10, lineText: '> if (x) {', body: 'this is dead' });
      result.current.add({ filePath: 'src/b.ts', line: 5, lineText: '> y', body: 'rename y' });
    });
    const msg = result.current.format();
    expect(msg).toContain('Review feedback (2 comments):');
    expect(msg).toContain('src/a.ts:10');
    expect(msg).toContain('this is dead');
    expect(msg).toContain('src/b.ts:5');
    expect(msg).toContain('rename y');
  });
});
