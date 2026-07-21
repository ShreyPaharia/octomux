import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { taskApi, type DiffFileEntry, type DiffRange } from '@/lib/api/taskApi';
import type { Agent } from '@octomux/types';
import {
  getReviewed,
  setReviewed as persistReviewed,
  getDiffSideBySide,
  setDiffSideBySide,
} from '@/lib/diff-state';
import { DIFF_REVIEW_BADGE } from '@/lib/design-tokens';
import { DiffFileTree } from './DiffFileTree';
import { DiffFileList, type DiffFileListHandle } from './DiffFileList';

const POLL_INTERVAL_MS = 2000;

interface Props {
  taskId: string;
  isRunning?: boolean;
  // Optional notifier so a parent (e.g. TaskDetail's review cockpit) can mirror
  // the currently-active file path for keyboard nav and the review banner.
  onSelectionChange?: (path: string | null) => void;
  // Optional notifier so a parent can refresh its own copy of the diff summary
  // after the API view fetches a new one (used for `reviewed_count` / banner).
  onSummaryLoaded?: (summary: import('@/lib/api').DiffSummaryResponse) => void;
  // When provided, the file tree's reviewed checkbox calls this instead of the
  // local-storage backed flow — TaskDetail uses the API.
  onToggleReviewed?: (path: string, currentlyReviewed: boolean) => void;
  // Diff range — selects which slice of history to view (default: full task diff).
  range?: DiffRange;
  /** Forward an imperative handle for programmatic scroll/reveal — used by the
   *  comments side panel. */
  listRef?: RefObject<DiffFileListHandle | null>;
  /** Opt-in to inline comment threads (uses CommentsContext). When true,
   *  callers must wrap with <CommentsContext.Provider>. */
  enableComments?: boolean;
  agents?: Agent[];
  /** Notifier fired whenever the list of files in the diff changes. The host
   *  uses this to mark "no longer in diff" comments in the side panel. */
  onFilesChange?: (paths: string[]) => void;
  /** Hide the built-in left file tree. Hosts (e.g. the review cockpit) use
   *  this when they render their own grouped tree alongside the diff. */
  hideFileTree?: boolean;
  /** When provided, sort the rendered file list to match this path order.
   *  Paths not in the list are appended after the ordered set, preserving
   *  their API order. */
  fileOrder?: string[];
  /** When provided, render sticky group-name dividers above each group's files
   *  in the diff stream. */
  groups?: import('@/lib/review-file-groups').RenderGroup[];
  /** Hide per-file walkthrough explainers in the diff stream (review cockpit uses ReviewContextStrip). */
  hideExplainers?: boolean;
}

export function DiffViewer({
  taskId,
  isRunning = false,
  onSelectionChange,
  onSummaryLoaded,
  onToggleReviewed: onToggleReviewedProp,
  range,
  listRef: externalListRef,
  enableComments = false,
  agents = [],
  onFilesChange,
  hideFileTree = false,
  fileOrder,
  groups,
  hideExplainers = false,
}: Props) {
  const isBaseRange = !range || range.kind === 'base';
  const [files, setFiles] = useState<DiffFileEntry[]>([]);
  const [ignoredTruncated, setIgnoredTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseShaUnavailable, setBaseShaUnavailable] = useState(false);
  const [baseUnavailable, setBaseUnavailable] = useState(false);
  const [baseBranchMissing, setBaseBranchMissing] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [reviewed, setReviewedState] = useState<Set<string>>(new Set());
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [sideBySide, setSideBySide] = useState<boolean>(getDiffSideBySide);

  const toggleView = useCallback(() => {
    setSideBySide((prev) => {
      const next = !prev;
      setDiffSideBySide(next);
      return next;
    });
  }, []);

  const internalListRef = useRef<DiffFileListHandle | null>(null);
  const listRef = externalListRef ?? internalListRef;

  const orderedFiles = useMemo(() => {
    if (!fileOrder || fileOrder.length === 0) return files;
    const indexOf = new Map(fileOrder.map((p, i) => [p, i]));
    const known = files.filter((f) => indexOf.has(f.path));
    const unknown = files.filter((f) => !indexOf.has(f.path));
    known.sort((a, b) => indexOf.get(a.path)! - indexOf.get(b.path)!);
    return [...known, ...unknown];
  }, [files, fileOrder]);

  // Notify host when the file set changes — but only when the *content* of the
  // path list actually changes. `orderedFiles` is a fresh array on every render
  // (it sorts by the `fileOrder` prop), and hosts commonly derive `fileOrder`
  // from the very paths we emit here (e.g. ReviewDetailPage groups them). Firing
  // unconditionally turns that into an infinite render loop: emit → host setState
  // → new `fileOrder` ref → new `orderedFiles` ref → emit again. Guarding on
  // content keeps the URL/location update from being starved by that loop.
  const lastEmittedPathsRef = useRef<string[] | null>(null);
  useEffect(() => {
    const paths = orderedFiles.map((f) => f.path);
    const prev = lastEmittedPathsRef.current;
    if (prev && prev.length === paths.length && prev.every((p, i) => p === paths[i])) {
      return;
    }
    lastEmittedPathsRef.current = paths;
    onFilesChange?.(paths);
  }, [orderedFiles, onFilesChange]);

  // Hydrate reviewed set from the API in review-cockpit mode, otherwise localStorage.
  useEffect(() => {
    const next = new Set<string>();
    for (const f of files) {
      const isReviewed = onToggleReviewedProp ? !!f.reviewed : getReviewed(taskId, f.path);
      if (isReviewed) next.add(f.path);
    }
    setReviewedState(next);
  }, [taskId, files, onToggleReviewedProp]);

  const toggleReviewed = useCallback(
    (path: string) => {
      const currentlyReviewed = reviewed.has(path);
      if (onToggleReviewedProp) {
        setReviewedState((prev) => {
          const next = new Set(prev);
          if (currentlyReviewed) next.delete(path);
          else next.add(path);
          return next;
        });
        onToggleReviewedProp(path, currentlyReviewed);
        return;
      }
      setReviewedState((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
          persistReviewed(taskId, path, false);
        } else {
          next.add(path);
          persistReviewed(taskId, path, true);
        }
        return next;
      });
    },
    [taskId, reviewed, onToggleReviewedProp],
  );

  const reviewCounts = useMemo(() => {
    const nonIgnored = files.filter((f) => !f.ignored);
    const total = nonIgnored.length;
    const done = nonIgnored.filter((f) => reviewed.has(f.path)).length;
    return { done, total };
  }, [files, reviewed]);

  // Every reviewable file marked done — collapse the header to a compact bar.
  const allReviewed = reviewCounts.total > 0 && reviewCounts.done === reviewCounts.total;

  // Unmark every reviewed file so the full review header returns.
  const reopenReview = useCallback(() => {
    for (const f of files) {
      if (!f.ignored && reviewed.has(f.path)) toggleReviewed(f.path);
    }
  }, [files, reviewed, toggleReviewed]);

  useEffect(() => {
    onSelectionChange?.(activeFile);
  }, [activeFile, onSelectionChange]);

  const loadSummary = useCallback(async () => {
    try {
      const s = await taskApi.getTaskDiffSummary(taskId, range);
      setFiles(s.files);
      setIgnoredTruncated(s.ignoredTruncated ?? false);
      onSummaryLoaded?.(s);
      setError(null);
      setBaseShaUnavailable(false);
      setBaseUnavailable(false);
      setBaseBranchMissing(false);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('base_sha not available')) {
        setFiles([]);
        setBaseShaUnavailable(true);
        setError(null);
      } else if (msg.includes('base_branch_missing')) {
        // Definite: the base branch is gone on origin AND locally. Not a
        // connectivity blip — polling won't recover it, so say so plainly.
        setFiles([]);
        setBaseBranchMissing(true);
        setError(null);
      } else if (msg.includes('base_unavailable')) {
        // Transient: couldn't reach origin AND no cached base SHA. Keep any
        // previously-rendered files visible so we don't flash empty; the next
        // poll should recover.
        setBaseUnavailable(true);
        setError(null);
      } else {
        setError(msg);
      }
    } finally {
      setSummaryLoading(false);
    }
  }, [taskId, onSummaryLoaded, range]);

  useEffect(() => {
    loadSummary();
    // Polling only makes sense for the live full diff. Historical commit/range
    // views don't change underneath us.
    if (!isRunning || !isBaseRange) return;
    const t = setInterval(loadSummary, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [loadSummary, isRunning, isBaseRange]);

  const handleSelect = useCallback((path: string) => {
    listRef.current?.scrollToFile(path);
  }, []);

  if (baseShaUnavailable) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Diff unavailable (base_sha not captured)
      </div>
    );
  }

  if (baseBranchMissing) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Base branch no longer exists on origin or locally &mdash; set a new diff base
      </div>
    );
  }

  if (baseUnavailable && files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Couldn&rsquo;t reach origin to resolve diff base &mdash; retrying&hellip;
      </div>
    );
  }

  if (error && !files.length) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-destructive">
        {error}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0">
      {!hideFileTree && (
        <aside
          data-testid="diff-file-list"
          className="glass-chrome flex w-[260px] shrink-0 flex-col overflow-hidden border-r border-glass-edge"
        >
          {summaryLoading && files.length === 0 ? (
            <div className="p-4 text-xs text-muted-foreground">Loading diff...</div>
          ) : (
            <DiffFileTree
              files={files}
              selected={activeFile}
              onSelect={handleSelect}
              taskId={taskId}
              ignoredTruncated={ignoredTruncated}
              reviewed={reviewed}
            />
          )}
        </aside>
      )}
      <div
        data-testid="diff-pane"
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-glass-l0"
      >
        {!hideFileTree && orderedFiles.length > 0 ? (
          <div
            data-testid="diff-pane-header"
            data-collapsed={allReviewed ? 'true' : 'false'}
            className="diff-pane-header flex shrink-0 items-center justify-between gap-2 overflow-hidden border-b border-glass-edge px-4 py-2 transition-all duration-200 ease-out"
          >
            <button
              type="button"
              data-testid="diff-view-toggle"
              onClick={toggleView}
              aria-label={sideBySide ? 'Switch to unified diff' : 'Switch to side-by-side diff'}
              title={sideBySide ? 'Switch to unified diff' : 'Switch to side-by-side diff'}
              className="rounded-md border border-glass-edge px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-glass-l2/60 hover:text-foreground"
            >
              {sideBySide ? 'Unified' : 'Side-by-side'}
            </button>
            {reviewCounts.total > 0 ? (
              allReviewed ? (
                <span className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {reviewCounts.total} {reviewCounts.total === 1 ? 'file' : 'files'} reviewed
                  </span>
                  <button
                    type="button"
                    data-testid="reopen-review"
                    onClick={reopenReview}
                    className="rounded-md border border-glass-edge px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-glass-l2/60 hover:text-foreground"
                  >
                    Reopen review
                  </button>
                </span>
              ) : (
                <span
                  data-testid="review-progress"
                  aria-label={`${reviewCounts.done} of ${reviewCounts.total} reviewed`}
                  className={DIFF_REVIEW_BADGE}
                >
                  {reviewCounts.done} / {reviewCounts.total} reviewed
                </span>
              )
            ) : null}
          </div>
        ) : null}
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {orderedFiles.length === 0 ? null : (
            <DiffFileList
              ref={listRef}
              taskId={taskId}
              files={orderedFiles}
              reviewed={reviewed}
              onToggleReviewed={toggleReviewed}
              onActiveChange={setActiveFile}
              range={range}
              agents={agents}
              rangeIsBase={isBaseRange}
              enableComments={enableComments}
              groups={groups}
              sideBySide={sideBySide}
              hideExplainers={hideExplainers}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default DiffViewer;
