import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInlineCommentZones } from './useInlineCommentZones';
import type { InlineCommentWithOutdated } from '@/lib/api';

interface FakeAccessor {
  addZone: (zone: { afterLineNumber: number; heightInPx?: number; domNode: HTMLDivElement }) => string;
  removeZone: (id: string) => void;
  layoutZone: (id: string) => void;
}

function createFakeEditor() {
  let nextId = 1;
  const zones = new Map<string, { afterLineNumber: number; domNode: HTMLDivElement }>();
  const addZoneCalls: string[] = [];
  const removeZoneCalls: string[] = [];
  const layoutZoneCalls: string[] = [];

  const accessor: FakeAccessor = {
    addZone: (zone) => {
      const id = `z${nextId++}`;
      zones.set(id, zone);
      addZoneCalls.push(id);
      return id;
    },
    removeZone: (id) => {
      zones.delete(id);
      removeZoneCalls.push(id);
    },
    layoutZone: (id) => {
      layoutZoneCalls.push(id);
    },
  };

  let onMouseDownCb: ((e: unknown) => void) | null = null;

  const codeEditor = {
    changeViewZones: (cb: (a: FakeAccessor) => void) => cb(accessor),
    onMouseDown: (cb: (e: unknown) => void) => {
      onMouseDownCb = cb;
      return { dispose: vi.fn() };
    },
    getModel: () => ({
      getLineContent: (n: number) => `line ${n}`,
    }),
  };

  const diffEditor = {
    getModifiedEditor: () => codeEditor,
    getOriginalEditor: () => codeEditor,
  };

  return {
    editor: diffEditor as never,
    zones,
    addZoneCalls,
    removeZoneCalls,
    layoutZoneCalls,
    fireGutterClick: (line: number) => {
      onMouseDownCb?.({ target: { type: 4, position: { lineNumber: line } } });
    },
  };
}

function comment(o: Partial<InlineCommentWithOutdated> = {}): InlineCommentWithOutdated {
  return {
    id: 'c1',
    task_id: 't1',
    agent_id: null,
    file_path: 'a.ts',
    line: 10,
    side: 'new',
    original_commit_sha: 'abc',
    body: 'hi',
    created_at: '2026-05-02 00:00:00',
    resolved_at: null,
    outdated: false,
    ...o,
  };
}

const noopHandlers = {
  onOpenComposer: vi.fn(),
  onCancelComposer: vi.fn(),
  onPostComment: vi.fn(),
  onQueueDraft: vi.fn(),
  onReply: vi.fn(),
  onResolve: vi.fn(),
  onDelete: vi.fn(),
  onEdit: vi.fn(),
};

describe('useInlineCommentZones', () => {
  it('does nothing when editor is null', () => {
    const { result } = renderHook(() =>
      useInlineCommentZones({
        editor: null,
        filePath: 'a.ts',
        comments: [comment()],
        agents: [],
        rangeIsBase: true,
        outdatedUnavailable: false,
        openComposer: null,
        ...noopHandlers,
      }),
    );
    expect(result.current).toEqual([]);
  });

  it('creates one zone per (line, side) when comments are provided', () => {
    const fake = createFakeEditor();
    renderHook(() =>
      useInlineCommentZones({
        editor: fake.editor,
        filePath: 'a.ts',
        comments: [
          comment({ id: 'c1', line: 10, side: 'new' }),
          comment({ id: 'c2', line: 20, side: 'old' }),
        ],
        agents: [],
        rangeIsBase: true,
        outdatedUnavailable: false,
        openComposer: null,
        ...noopHandlers,
      }),
    );
    expect(fake.addZoneCalls.length).toBe(2);
  });

  it('removes a zone when its comment is removed', () => {
    const fake = createFakeEditor();
    const { rerender } = renderHook(
      (props: { comments: InlineCommentWithOutdated[] }) =>
        useInlineCommentZones({
          editor: fake.editor,
          filePath: 'a.ts',
          comments: props.comments,
          agents: [],
          rangeIsBase: true,
          outdatedUnavailable: false,
          openComposer: null,
          ...noopHandlers,
        }),
      { initialProps: { comments: [comment({ id: 'c1', line: 10, side: 'new' })] } },
    );
    expect(fake.addZoneCalls.length).toBe(1);

    act(() => {
      rerender({ comments: [] });
    });
    expect(fake.removeZoneCalls.length).toBe(1);
  });

  it('opens a composer zone when openComposer matches the file', () => {
    const fake = createFakeEditor();
    const { rerender } = renderHook(
      (props: { open: { filePath: string; line: number; side: 'old' | 'new' } | null }) =>
        useInlineCommentZones({
          editor: fake.editor,
          filePath: 'a.ts',
          comments: [],
          agents: [],
          rangeIsBase: true,
          outdatedUnavailable: false,
          openComposer: props.open,
          ...noopHandlers,
        }),
      { initialProps: { open: null as { filePath: string; line: number; side: 'old' | 'new' } | null } },
    );
    expect(fake.addZoneCalls.length).toBe(0);

    act(() => {
      rerender({ open: { filePath: 'a.ts', line: 5, side: 'new' } });
    });
    expect(fake.addZoneCalls.length).toBe(1);
  });

  it('gutter click on an unannotated line fires onOpenComposer', () => {
    const fake = createFakeEditor();
    const onOpenComposer = vi.fn();
    renderHook(() =>
      useInlineCommentZones({
        editor: fake.editor,
        filePath: 'a.ts',
        comments: [],
        agents: [],
        rangeIsBase: true,
        outdatedUnavailable: false,
        openComposer: null,
        ...noopHandlers,
        onOpenComposer,
      }),
    );
    fake.fireGutterClick(7);
    expect(onOpenComposer).toHaveBeenCalledWith(7, 'new');
  });

  it('gutter click on a line with an existing thread does NOT fire onOpenComposer', () => {
    const fake = createFakeEditor();
    const onOpenComposer = vi.fn();
    renderHook(() =>
      useInlineCommentZones({
        editor: fake.editor,
        filePath: 'a.ts',
        comments: [comment({ id: 'c1', line: 7, side: 'new' })],
        agents: [],
        rangeIsBase: true,
        outdatedUnavailable: false,
        openComposer: null,
        ...noopHandlers,
        onOpenComposer,
      }),
    );
    fake.fireGutterClick(7);
    expect(onOpenComposer).not.toHaveBeenCalled();
  });

  it('cleans up zones on unmount', () => {
    const fake = createFakeEditor();
    const { unmount } = renderHook(() =>
      useInlineCommentZones({
        editor: fake.editor,
        filePath: 'a.ts',
        comments: [comment({ id: 'c1', line: 10, side: 'new' })],
        agents: [],
        rangeIsBase: true,
        outdatedUnavailable: false,
        openComposer: null,
        ...noopHandlers,
      }),
    );
    expect(fake.addZoneCalls.length).toBe(1);
    unmount();
    expect(fake.removeZoneCalls.length).toBe(1);
  });
});
