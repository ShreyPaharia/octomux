import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useRef } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { apiMock, apiProxy } = await vi.hoisted(async () =>
  (await import('../test-helpers')).setupApiMock(),
);
vi.mock('@/lib/api', async () => {
  const actual = (await vi.importActual('@/lib/api')) as Record<string, unknown>;
  return { ...actual, api: apiProxy };
});

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({ original, modified }: { original: string; modified: string }) => {
    const idRef = useRef<number | null>(null);
    if (idRef.current === null) idRef.current = Math.random();
    return (
      <div data-testid="monaco-diff">
        <pre data-testid="orig">{original}</pre>
        <pre data-testid="mod">{modified}</pre>
      </div>
    );
  },
}));

import { DiffFileList, type DiffFileListHandle } from './DiffFileList';
import type { DiffFileEntry } from '@/lib/api';

// ─── Controllable IntersectionObserver stub ──────────────────────────────────
type IOEntry = Partial<IntersectionObserverEntry> & { isIntersecting: boolean };

interface ControllableIO {
  instances: TestIO[];
  trigger: (target: Element, partial: IOEntry) => void;
  triggerAll: (partial: Partial<IOEntry>) => void;
}

class TestIO implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin: string = '';
  readonly thresholds: readonly number[] = [];
  cb: IntersectionObserverCallback;
  targets = new Set<Element>();
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
  }
  observe(t: Element) {
    this.targets.add(t);
  }
  unobserve(t: Element) {
    this.targets.delete(t);
  }
  disconnect() {
    this.targets.clear();
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function installControllableIO(): ControllableIO {
  const instances: TestIO[] = [];
  const Ctor = function (cb: IntersectionObserverCallback) {
    const inst = new TestIO(cb);
    instances.push(inst);
    return inst;
  } as unknown as typeof IntersectionObserver;
  globalThis.IntersectionObserver = Ctor;

  return {
    instances,
    trigger(target, partial) {
      for (const inst of instances) {
        if (!inst.targets.has(target)) continue;
        const entry = {
          target,
          intersectionRatio: partial.isIntersecting ? 1 : 0,
          boundingClientRect: target.getBoundingClientRect(),
          intersectionRect: target.getBoundingClientRect(),
          rootBounds: null,
          time: 0,
          ...partial,
        } as IntersectionObserverEntry;
        inst.cb([entry], inst);
      }
    },
    triggerAll(partial) {
      for (const inst of instances) {
        for (const target of inst.targets) {
          const entry = {
            target,
            isIntersecting: true,
            intersectionRatio: 1,
            boundingClientRect: target.getBoundingClientRect(),
            intersectionRect: target.getBoundingClientRect(),
            rootBounds: null,
            time: 0,
            ...partial,
          } as IntersectionObserverEntry;
          inst.cb([entry], inst);
        }
      }
    },
  };
}

const PRIOR_IO = globalThis.IntersectionObserver;

beforeEach(() => {
  apiMock.getTaskDiffFile.mockReset().mockImplementation((_id: string, p: string) =>
    Promise.resolve({
      oldContent: `${p}-old`,
      newContent: `${p}-new`,
      status: 'M' as const,
      tooLarge: false,
      binary: false,
      isDirectory: false,
    }),
  );
  history.replaceState(null, '', '/');
});

afterEach(() => {
  globalThis.IntersectionObserver = PRIOR_IO;
});

const FILES: DiffFileEntry[] = [
  { path: 'a.ts', status: 'M', additions: 1, deletions: 0 },
  { path: 'b.ts', status: 'A', additions: 5, deletions: 0 },
  { path: 'c.ts', status: 'M', additions: 2, deletions: 0 },
];

describe('DiffFileList', () => {
  it('emits onActiveChange to the topmost intersecting row', async () => {
    const io = installControllableIO();
    const onActive = vi.fn();
    render(
      <DiffFileList
        taskId="t1"
        files={FILES}
        reviewed={new Set()}
        onToggleReviewed={() => {}}
        onActiveChange={onActive}
      />,
    );

    // Mark a.ts and b.ts as intersecting; expect a.ts (rendered first) to
    // win as active.
    const aEl = await screen.findByTestId('diff-row-a.ts');
    const bEl = await screen.findByTestId('diff-row-b.ts');

    act(() => {
      io.trigger(aEl, { isIntersecting: true });
      io.trigger(bEl, { isIntersecting: true });
    });

    await waitFor(() => expect(onActive).toHaveBeenCalledWith('a.ts'));
    expect(aEl).toHaveAttribute('data-active', 'true');

    // Now scroll past a.ts: a.ts no longer intersects, b.ts does.
    act(() => {
      io.trigger(aEl, { isIntersecting: false });
      io.trigger(bEl, { isIntersecting: true });
    });

    await waitFor(() => expect(onActive).toHaveBeenLastCalledWith('b.ts'));
  });

  it('lazy-mounts editors only after the row becomes visible', async () => {
    const io = installControllableIO();
    render(
      <DiffFileList taskId="t1" files={FILES} reviewed={new Set()} onToggleReviewed={() => {}} />,
    );

    // No file is "visible" yet — Monaco should not be mounted.
    expect(screen.queryByTestId('monaco-diff')).not.toBeInTheDocument();
    expect(apiMock.getTaskDiffFile).not.toHaveBeenCalled();

    const aEl = await screen.findByTestId('diff-row-a.ts');
    act(() => {
      io.trigger(aEl, { isIntersecting: true });
    });

    await waitFor(() => {
      expect(apiMock.getTaskDiffFile).toHaveBeenCalledWith('t1', 'a.ts', undefined);
    });
    await waitFor(() => expect(screen.getAllByTestId('monaco-diff')).toHaveLength(1));

    // b.ts and c.ts still un-mounted.
    expect(apiMock.getTaskDiffFile).toHaveBeenCalledTimes(1);
  });

  it('sidebar click via imperative scrollToFile updates the URL hash', async () => {
    const io = installControllableIO();
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;

    function Wrapper() {
      const ref = useRef<DiffFileListHandle | null>(null);
      return (
        <>
          <button data-testid="trigger" onClick={() => ref.current?.scrollToFile('b.ts')}>
            scroll
          </button>
          <DiffFileList
            ref={ref}
            taskId="t1"
            files={FILES}
            reviewed={new Set()}
            onToggleReviewed={() => {}}
          />
        </>
      );
    }

    render(<Wrapper />);
    await screen.findByTestId('diff-row-b.ts');

    await userEvent.click(screen.getByTestId('trigger'));

    expect(scrollSpy).toHaveBeenCalled();
    expect(window.location.hash).toBe('#file=b.ts');

    // The optimistic active id should immediately become 'b.ts' even before
    // any IntersectionObserver entries fire.
    expect(screen.getByTestId('diff-row-b.ts')).toHaveAttribute('data-active', 'true');

    void io;
  });

  it('honors #file=<path> hash on mount by scrolling to that row', async () => {
    installControllableIO();
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    history.replaceState(null, '', '/#file=' + encodeURIComponent('b.ts'));

    render(
      <DiffFileList taskId="t1" files={FILES} reviewed={new Set()} onToggleReviewed={() => {}} />,
    );

    await screen.findByTestId('diff-row-b.ts');
    expect(scrollSpy).toHaveBeenCalled();
  });

  it('exposes revealLineInFile on the imperative handle', async () => {
    installControllableIO();
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;

    function Wrapper() {
      const ref = useRef<DiffFileListHandle | null>(null);
      return (
        <>
          <button data-testid="trigger" onClick={() => ref.current?.revealLineInFile('b.ts', 5)}>
            reveal
          </button>
          <DiffFileList
            ref={ref}
            taskId="t1"
            files={FILES}
            reviewed={new Set()}
            onToggleReviewed={() => {}}
          />
        </>
      );
    }

    render(<Wrapper />);
    await screen.findByTestId('diff-row-b.ts');

    await userEvent.click(screen.getByTestId('trigger'));

    expect(scrollSpy).toHaveBeenCalled();
    expect(window.location.hash).toBe('#file=b.ts');
  });

  it('skips fetching ignored, tooLarge, or binary files', async () => {
    const io = installControllableIO();
    render(
      <DiffFileList
        taskId="t1"
        files={[
          { path: '.env', status: 'A', additions: 1, deletions: 0, ignored: true },
          { path: 'big', status: 'M', additions: 0, deletions: 0, tooLarge: true },
          { path: 'pic.png', status: 'A', additions: 0, deletions: 0, binary: true },
        ]}
        reviewed={new Set()}
        onToggleReviewed={() => {}}
      />,
    );
    const env = await screen.findByTestId('diff-row-.env');
    const big = await screen.findByTestId('diff-row-big');
    const pic = await screen.findByTestId('diff-row-pic.png');
    act(() => {
      io.trigger(env, { isIntersecting: true });
      io.trigger(big, { isIntersecting: true });
      io.trigger(pic, { isIntersecting: true });
    });
    // Allow microtasks
    await Promise.resolve();
    expect(apiMock.getTaskDiffFile).not.toHaveBeenCalled();
  });
});
