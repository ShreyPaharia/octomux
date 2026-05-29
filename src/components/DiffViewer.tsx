import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { api, type DiffFileEntry, type DiffRange } from '@/lib/api';
import type { Agent } from '../../server/types';
import { getReviewed, setReviewed as persistReviewed } from '@/lib/diff-state';
import { DIFF_REVIEW_BADGE } from '@/lib/design-tokens';
import { DiffFileTree } from './DiffFileTree';
import { DiffFileList, type DiffFileListHandle } from './DiffFileList';

const POLL_INTERVAL_MS = 2000;

export interface QueuedReviewComment {
  id: string;
  filePath: string;
  line: number;
  lineText: string;
  body: string;
}

interface Props {
  taskId?: string;
  isRunning?: boolean;
  // Controlled / standalone-content mode (used by the review composer).
  // When `oldContent`/`newContent`/`path` are passed directly, the component
  // renders a simple line-by-line view of the new content with an inline
  // comment composer per line, instead of fetching diff data via the API.
  oldContent?: string;
  newContent?: string;
  path?: string;
  onAddComment?: (c: { filePath: string; line: number; lineText: string; body: string }) => void;
  queuedComments?: QueuedReviewComment[];
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
  /** Opt-in to inline comment threads (uses TaskCommentsContext). When true,
   *  callers must wrap with <TaskCommentsContext.Provider>. */
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
}

export function DiffViewer(props: Props) {
  const {
    taskId,
    isRunning,
    oldContent: standaloneOld,
    newContent: standaloneNew,
    path: standalonePath,
    onAddComment,
    queuedComments,
    onSelectionChange,
    onSummaryLoaded,
    onToggleReviewed,
    range,
    listRef,
    enableComments,
    agents,
    onFilesChange,
    hideFileTree,
    fileOrder,
    groups,
  } = props;

  // Standalone / composer mode — renders the new-content lines as clickable
  // buttons with an inline comment composer. No taskId needed.
  if (standaloneNew !== undefined && standalonePath !== undefined && standaloneOld !== undefined) {
    return (
      <InlineComposerDiff
        path={standalonePath}
        newContent={standaloneNew}
        onAddComment={onAddComment}
        queuedComments={queuedComments ?? []}
      />
    );
  }

  if (taskId === undefined) {
    return null;
  }

  return (
    <ApiDiffViewer
      taskId={taskId}
      isRunning={isRunning ?? false}
      onSelectionChange={onSelectionChange}
      onSummaryLoaded={onSummaryLoaded}
      onToggleReviewed={onToggleReviewed}
      range={range}
      listRef={listRef}
      enableComments={enableComments}
      agents={agents}
      onFilesChange={onFilesChange}
      hideFileTree={hideFileTree}
      fileOrder={fileOrder}
      groups={groups}
    />
  );
}

interface InlineComposerDiffProps {
  path: string;
  newContent: string;
  onAddComment?: (c: { filePath: string; line: number; lineText: string; body: string }) => void;
  queuedComments: QueuedReviewComment[];
}

function InlineComposerDiff({
  path,
  newContent,
  onAddComment,
  queuedComments,
}: InlineComposerDiffProps) {
  const [activeLine, setActiveLine] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const lines = newContent.split('\n');

  const openComposer = (line: number) => {
    setActiveLine(line);
    setDraft('');
  };

  const close = () => {
    setActiveLine(null);
    setDraft('');
  };

  const save = (line: number, lineText: string) => {
    if (!onAddComment) {
      close();
      return;
    }
    onAddComment({ filePath: path, line, lineText, body: draft });
    close();
  };

  return (
    <div className="font-mono text-sm">
      {lines.map((lineText, idx) => {
        const lineNum = idx + 1; // 1-indexed
        const pills = queuedComments.filter((c) => c.filePath === path && c.line === lineNum);
        return (
          <div key={lineNum} data-line={lineNum}>
            <button
              type="button"
              className="block w-full text-left hover:bg-accent/30"
              onClick={() => openComposer(lineNum)}
            >
              {lineText}
            </button>
            {pills.map((c) => (
              <div key={c.id} className="text-xs italic">
                {c.body}
              </div>
            ))}
            {activeLine === lineNum ? (
              <input
                autoFocus
                placeholder="Leave a comment"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    save(lineNum, lineText);
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    close();
                  }
                }}
                className="block w-full border border-glass-edge bg-glass-l1 px-2 py-1 text-sm"
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ApiDiffViewer({
  taskId,
  isRunning,
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
}: {
  taskId: string;
  isRunning: boolean;
  onSelectionChange?: (path: string | null) => void;
  onSummaryLoaded?: (summary: import('@/lib/api').DiffSummaryResponse) => void;
  onToggleReviewed?: (path: string, currentlyReviewed: boolean) => void;
  range?: DiffRange;
  listRef?: RefObject<DiffFileListHandle | null>;
  enableComments?: boolean;
  agents?: Agent[];
  onFilesChange?: (paths: string[]) => void;
  hideFileTree?: boolean;
  fileOrder?: string[];
  groups?: import('@/lib/review-file-groups').RenderGroup[];
}) {
  const isBaseRange = !range || range.kind === 'base';
  const [files, setFiles] = useState<DiffFileEntry[]>([]);
  const [ignoredTruncated, setIgnoredTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseShaUnavailable, setBaseShaUnavailable] = useState(false);
  const [baseUnavailable, setBaseUnavailable] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [reviewed, setReviewedState] = useState<Set<string>>(new Set());
  const [activeFile, setActiveFile] = useState<string | null>(null);

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

  // Notify host when the file set changes.
  useEffect(() => {
    onFilesChange?.(orderedFiles.map((f) => f.path));
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

  useEffect(() => {
    onSelectionChange?.(activeFile);
  }, [activeFile, onSelectionChange]);

  const loadSummary = useCallback(async () => {
    try {
      const s = await api.getTaskDiffSummary(taskId, range);
      setFiles(s.files);
      setIgnoredTruncated(s.ignoredTruncated ?? false);
      onSummaryLoaded?.(s);
      setError(null);
      setBaseShaUnavailable(false);
      setBaseUnavailable(false);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('base_sha not available')) {
        setFiles([]);
        setBaseShaUnavailable(true);
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
        {!hideFileTree && reviewCounts.total > 0 ? (
          <div className="diff-pane-header flex shrink-0 items-center justify-end gap-2 border-b border-glass-edge px-4 py-2">
            <span
              data-testid="review-progress"
              aria-label={`${reviewCounts.done} of ${reviewCounts.total} reviewed`}
              className={DIFF_REVIEW_BADGE}
            >
              {reviewCounts.done} / {reviewCounts.total} reviewed
            </span>
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
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default DiffViewer;
