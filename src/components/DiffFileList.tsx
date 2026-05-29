import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { editor } from 'monaco-editor';
import {
  api,
  diffRangeToParam,
  type DiffFileEntry,
  type DiffRange,
  type FileDiffResponse,
} from '@/lib/api';
import type { Agent } from '../../server/types';
import { getDiffExpanded, setDiffExpanded } from '@/lib/diff-state';
import { findHunkLine } from '@/lib/diff-hunks';
import { useScrollSpy } from '@/hooks/useScrollSpy';
import { useDiffKeyboardNav } from '@/hooks/useDiffKeyboardNav';
import { DiffFileRow } from './DiffFileRow';
import type { RenderGroup } from '@/lib/review-file-groups';

const HASH_PREFIX = '#file=';
const PROGRAMMATIC_SCROLL_MS = 700;
/** Prefetch file bodies slightly before scroll; keep modest so Monaco mounts with real width. */
const PREFETCH_ROOT_MARGIN = '40% 0px';

export interface DiffFileListHandle {
  scrollToFile: (path: string) => void;
  /** Reveal a specific line on the modified side (or original side if `side==='old'`)
   *  of the given file. Scrolls to the file first, then centers the line in the editor. */
  revealLineInFile: (path: string, line: number, side?: 'old' | 'new') => void;
}

interface Props {
  taskId: string;
  files: DiffFileEntry[];
  reviewed: Set<string>;
  onToggleReviewed: (path: string) => void;
  onActiveChange?: (path: string | null) => void;
  range?: DiffRange;
  agents?: Agent[];
  rangeIsBase?: boolean;
  enableComments?: boolean;
  /** When provided, render sticky group-name dividers above each group's files. */
  groups?: RenderGroup[];
}

function readHashPath(): string | null {
  if (typeof window === 'undefined') return null;
  const h = window.location.hash;
  if (!h.startsWith(HASH_PREFIX)) return null;
  try {
    return decodeURIComponent(h.slice(HASH_PREFIX.length));
  } catch {
    return null;
  }
}

export const DiffFileList = forwardRef<DiffFileListHandle, Props>(function DiffFileList(
  {
    taskId,
    files,
    reviewed,
    onToggleReviewed,
    onActiveChange,
    range,
    agents = [],
    rangeIsBase = true,
    enableComments = false,
    groups,
  },
  ref,
) {
  const rangeKey = diffRangeToParam(range) ?? 'base';
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const editorsRef = useRef<Map<string, editor.IStandaloneDiffEditor>>(new Map());
  const programmaticScrollUntil = useRef<number>(0);

  const [loaded, setLoaded] = useState<Map<string, FileDiffResponse>>(() => new Map());
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map());
  const [visible, setVisible] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Map<string, boolean>>(() => new Map());
  const expandedFallback = useRef<Map<string, boolean>>(new Map());

  const orderedFiles = useMemo(() => {
    // Render non-ignored first, then ignored, preserving sidebar order.
    return [...files.filter((f) => !f.ignored), ...files.filter((f) => f.ignored)];
  }, [files]);

  const filesByPath = useMemo(() => {
    const m = new Map<string, DiffFileEntry>();
    for (const f of files) m.set(f.path, f);
    return m;
  }, [files]);

  // ─── Scroll-spy (active file = top of viewport band) ─────────────────────
  const spy = useScrollSpy({ programmaticScrollUntil });
  const activeFile = spy.activeId;

  useEffect(() => {
    onActiveChange?.(activeFile);
  }, [activeFile, onActiveChange]);

  // ─── Prefetch IntersectionObserver (~2 viewports of buffer) ──────────────
  // We don't remove paths from `visible` once seen — once mounted, stays
  // mounted to preserve scroll position and avoid layout thrash.
  const prefetchObserverRef = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const entry of entries) {
            const path = (entry.target as HTMLElement).dataset.filePath;
            if (!path) continue;
            if (entry.isIntersecting && !next.has(path)) {
              next.add(path);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      },
      { rootMargin: PREFETCH_ROOT_MARGIN },
    );
    prefetchObserverRef.current = observer;
    for (const el of rowRefs.current.values()) observer.observe(el);
    return () => {
      observer.disconnect();
      prefetchObserverRef.current = null;
    };
  }, []);

  // ─── Row registration ────────────────────────────────────────────────────
  const registerRow = useCallback(
    (path: string, el: HTMLElement | null) => {
      const prev = rowRefs.current.get(path);
      if (prev && prev !== el) {
        spy.unobserve(prev);
        prefetchObserverRef.current?.unobserve(prev);
      }
      if (el) {
        rowRefs.current.set(path, el);
        spy.observe(el, path);
        prefetchObserverRef.current?.observe(el);
      } else {
        rowRefs.current.delete(path);
      }
    },
    [spy],
  );

  // ─── Polling preservation: drop loaded entries whose post_blob_sha changed
  useEffect(() => {
    setLoaded((prev) => {
      const next = new Map<string, FileDiffResponse>();
      let changed = false;
      const stillPresent = new Set(filesByPath.keys());
      for (const [path, body] of prev) {
        if (!stillPresent.has(path)) {
          changed = true;
          continue;
        }
        next.set(path, body);
      }
      // Best-effort sha-change eviction: we don't store the sha alongside
      // body, so use the file's previous sha vs new sha if available. Since
      // we don't keep the previous sha, we conservatively keep entries on
      // path-match. The next visible-trigger will re-fetch only files whose
      // sha indicates change via a separate map.
      return changed ? next : prev;
    });
    setErrors((prev) => {
      let changed = false;
      const next = new Map<string, string>();
      for (const [path, msg] of prev) {
        if (filesByPath.has(path)) next.set(path, msg);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [filesByPath]);

  // Track post_blob_sha per loaded path so we can evict on sha change.
  const loadedShas = useRef<Map<string, string | null | undefined>>(new Map());
  useEffect(() => {
    setLoaded((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [path, prevSha] of loadedShas.current) {
        const file = filesByPath.get(path);
        if (!file) continue;
        const newSha = file.post_blob_sha;
        if (newSha !== undefined && prevSha !== undefined && newSha !== prevSha) {
          next.delete(path);
          loadedShas.current.delete(path);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [filesByPath]);

  // ─── Fetch bodies for newly visible files ─────────────────────────────────
  useEffect(() => {
    for (const path of visible) {
      const file = filesByPath.get(path);
      if (!file) continue;
      if (file.ignored || file.tooLarge || file.binary) continue;
      if (loaded.has(path) || loading.has(path) || errors.has(path)) continue;

      setLoading((prev) => {
        if (prev.has(path)) return prev;
        const next = new Set(prev);
        next.add(path);
        return next;
      });

      api
        .getTaskDiffFile(taskId, path, range)
        .then((d) => {
          setLoaded((prev) => {
            const next = new Map(prev);
            next.set(path, d);
            return next;
          });
          loadedShas.current.set(path, file.post_blob_sha);
        })
        .catch((err: Error) => {
          setErrors((prev) => {
            const next = new Map(prev);
            next.set(path, err.message);
            return next;
          });
        })
        .finally(() => {
          setLoading((prev) => {
            if (!prev.has(path)) return prev;
            const next = new Set(prev);
            next.delete(path);
            return next;
          });
        });
    }
  }, [visible, filesByPath, loaded, loading, errors, taskId, range]);

  // When the range changes, drop cached file bodies so we refetch under the new range.
  useEffect(() => {
    setLoaded(new Map());
    setErrors(new Map());
    loadedShas.current.clear();
  }, [rangeKey]);

  // ─── Initial hash scroll ─────────────────────────────────────────────────
  const didInitialScrollRef = useRef(false);
  useEffect(() => {
    if (didInitialScrollRef.current) return;
    if (orderedFiles.length === 0) return;
    const target = readHashPath();
    if (!target) {
      didInitialScrollRef.current = true;
      return;
    }
    const el = rowRefs.current.get(target);
    if (!el) return; // wait for row to mount
    didInitialScrollRef.current = true;
    programmaticScrollUntil.current = performance.now() + PROGRAMMATIC_SCROLL_MS;
    spy.setActiveId(target);
    el.scrollIntoView({ block: 'start' });
  }, [orderedFiles, spy]);

  // ─── Scroll-to-file (sidebar click + imperative handle) ───────────────────
  const scrollToFile = useCallback(
    (path: string) => {
      const el = rowRefs.current.get(path);
      if (!el) return;
      programmaticScrollUntil.current = performance.now() + PROGRAMMATIC_SCROLL_MS;
      spy.setActiveId(path);
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      try {
        const url = `${window.location.pathname}${window.location.search}${HASH_PREFIX}${encodeURIComponent(path)}`;
        window.history.replaceState(null, '', url);
      } catch {
        // ignore (older browsers / opaque origin)
      }
    },
    [spy],
  );

  const revealLineInFile = useCallback(
    (path: string, line: number, side: 'old' | 'new' = 'new') => {
      scrollToFile(path);
      const reveal = (attempt = 0) => {
        const ed = editorsRef.current.get(path);
        if (!ed) {
          if (attempt < 30) requestAnimationFrame(() => reveal(attempt + 1));
          return;
        }
        const sub = side === 'old' ? ed.getOriginalEditor() : ed.getModifiedEditor();
        sub.revealLineInCenter(line);
        sub.setPosition({ lineNumber: line, column: 1 });
      };
      requestAnimationFrame(() => reveal());
    },
    [scrollToFile],
  );

  useImperativeHandle(ref, () => ({ scrollToFile, revealLineInFile }), [
    scrollToFile,
    revealLineInFile,
  ]);

  // ─── Expanded state per file (persisted) ─────────────────────────────────
  const isExpanded = useCallback(
    (path: string) => {
      const state = expanded.get(path);
      if (state !== undefined) return state;
      try {
        return getDiffExpanded(taskId, path);
      } catch {
        return expandedFallback.current.get(path) ?? false;
      }
    },
    [expanded, taskId],
  );

  const toggleExpanded = useCallback(
    (path: string) => {
      const next = !isExpanded(path);
      setExpanded((prev) => {
        const m = new Map(prev);
        m.set(path, next);
        return m;
      });
      try {
        setDiffExpanded(taskId, path, next);
      } catch {
        expandedFallback.current.set(path, next);
      }
    },
    [isExpanded, taskId],
  );

  // ─── Editor registry for J/K/N/P nav ─────────────────────────────────────
  const handleEditorMount = useCallback((path: string, ed: editor.IStandaloneDiffEditor) => {
    editorsRef.current.set(path, ed);
  }, []);

  // ─── Keyboard nav ────────────────────────────────────────────────────────
  const navigateFile = useCallback(
    (direction: 1 | -1) => {
      const non = orderedFiles.filter((f) => !f.ignored);
      if (non.length === 0) return;
      const cur = activeFile ? non.findIndex((f) => f.path === activeFile) : -1;
      let nextIdx: number;
      if (cur === -1) {
        nextIdx = direction === 1 ? 0 : non.length - 1;
      } else {
        nextIdx = (cur + direction + non.length) % non.length;
      }
      scrollToFile(non[nextIdx].path);
    },
    [orderedFiles, activeFile, scrollToFile],
  );

  const navigateHunk = useCallback(
    (direction: 1 | -1) => {
      const non = orderedFiles.filter((f) => !f.ignored);
      if (non.length === 0) return;
      const startPath = activeFile ?? non[0].path;
      const startIdx = non.findIndex((f) => f.path === startPath);
      if (startIdx === -1) return;

      // Try the active file first.
      const ed = editorsRef.current.get(startPath);
      if (ed) {
        const changes = ed.getLineChanges();
        if (changes && changes.length > 0) {
          const modified = ed.getModifiedEditor();
          const cursorLine = modified.getPosition()?.lineNumber ?? 1;
          // findHunkLine wraps; use a non-wrapping check first.
          const sorted = [...changes].sort(
            (a, b) => a.modifiedStartLineNumber - b.modifiedStartLineNumber,
          );
          let target: number | null = null;
          if (direction === 1) {
            for (const c of sorted) {
              if (c.modifiedStartLineNumber > cursorLine) {
                target = c.modifiedStartLineNumber;
                break;
              }
            }
          } else {
            for (let i = sorted.length - 1; i >= 0; i--) {
              if (sorted[i].modifiedStartLineNumber < cursorLine) {
                target = sorted[i].modifiedStartLineNumber;
                break;
              }
            }
          }
          if (target != null) {
            modified.setPosition({ lineNumber: target, column: 1 });
            modified.revealLineInCenterIfOutsideViewport(target, 0);
            modified.focus();
            return;
          }
        }
      }

      // No more hunks in the active file — advance to the next file with hunks.
      for (let off = 1; off <= non.length; off++) {
        const idx = (startIdx + direction * off + non.length) % non.length;
        const candidate = non[idx];
        const candEd = editorsRef.current.get(candidate.path);
        if (candEd) {
          const changes = candEd.getLineChanges();
          if (changes && changes.length > 0) {
            const sorted = [...changes].sort(
              (a, b) => a.modifiedStartLineNumber - b.modifiedStartLineNumber,
            );
            const target =
              direction === 1
                ? sorted[0].modifiedStartLineNumber
                : sorted[sorted.length - 1].modifiedStartLineNumber;
            const modified = candEd.getModifiedEditor();
            scrollToFile(candidate.path);
            // Defer cursor placement until after the smooth scroll begins.
            requestAnimationFrame(() => {
              modified.setPosition({ lineNumber: target, column: 1 });
              modified.revealLineInCenterIfOutsideViewport(target, 0);
            });
            return;
          }
        } else {
          // Editor not mounted yet — just scroll to it.
          scrollToFile(candidate.path);
          return;
        }
      }

      // Fallback: pick the active editor's first/last hunk via wrap.
      if (ed) {
        const changes = ed.getLineChanges();
        const target = findHunkLine(
          changes,
          ed.getModifiedEditor().getPosition()?.lineNumber ?? 1,
          direction,
        );
        if (target != null) {
          const modified = ed.getModifiedEditor();
          modified.setPosition({ lineNumber: target, column: 1 });
          modified.revealLineInCenterIfOutsideViewport(target, 0);
        }
      }
    },
    [orderedFiles, activeFile, scrollToFile],
  );

  useDiffKeyboardNav({
    onNextFile: () => navigateFile(1),
    onPrevFile: () => navigateFile(-1),
    onNextHunk: () => navigateHunk(1),
    onPrevHunk: () => navigateHunk(-1),
  });

  // ─── Group header map: first file path in each group → group info ────────
  // Used to inject sticky dividers inline in the flat file list.
  const groupHeaderMap = useMemo(() => {
    const m = new Map<string, { name: string; count: number; summary?: string }>();
    if (!groups) return m;
    for (const g of groups) {
      const firstPresent = g.files.find((gf) => filesByPath.has(gf.path));
      if (firstPresent) {
        m.set(firstPresent.path, { name: g.name, count: g.files.length, summary: g.summary });
      }
    }
    return m;
  }, [groups, filesByPath]);

  // ─── Render ─────────────────────────────────────────────────────────────
  if (orderedFiles.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No changes
      </div>
    );
  }

  return (
    <div
      ref={scrollContainerRef}
      className="flex h-full min-w-0 flex-col overflow-x-hidden overflow-y-auto"
    >
      {orderedFiles.map((file) => {
        const path = file.path;
        const exp = isExpanded(path);
        const groupHeader = groupHeaderMap.size > 0 ? groupHeaderMap.get(path) : undefined;
        return (
          <div key={path}>
            {groupHeader && (
              <div data-testid={`diff-group-section-${groupHeader.name}`}>
                <div className="sticky top-0 z-10 border-b border-glass-edge bg-glass-l1/95 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur">
                  {groupHeader.name}
                  <span className="ml-1 font-normal opacity-60">({groupHeader.count})</span>
                </div>
                {groupHeader.summary && (
                  <div
                    data-testid={`diff-group-summary-${groupHeader.name}`}
                    className="border-b border-glass-edge bg-glass-l1/40 px-4 py-2 text-xs text-foreground"
                  >
                    {groupHeader.summary}
                  </div>
                )}
              </div>
            )}
            <DiffFileRow
              ref={(el) => registerRow(path, el)}
              file={file}
              diff={loaded.get(path) ?? null}
              loading={loading.has(path)}
              error={errors.get(path) ?? null}
              mounted={visible.has(path)}
              expanded={exp}
              reviewed={reviewed.has(path)}
              active={activeFile === path}
              showReviewToggle={!file.ignored}
              onToggleReviewed={() => onToggleReviewed(path)}
              onToggleExpanded={() => toggleExpanded(path)}
              onEditorMount={handleEditorMount}
              agents={agents}
              rangeIsBase={rangeIsBase}
              enableComments={enableComments}
            />
          </div>
        );
      })}
    </div>
  );
});

export default DiffFileList;
