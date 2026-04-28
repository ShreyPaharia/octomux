import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffOnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { api, type DiffFileEntry, type FileDiffResponse } from '@/lib/api';
import {
  getDiffExpanded,
  setDiffExpanded,
  getReviewed,
  setReviewed as persistReviewed,
} from '@/lib/diff-state';
import { Button } from '@/components/ui/button';
import { DiffFileTree } from './DiffFileTree';

const MonacoDiff = lazy(() =>
  import('@monaco-editor/react').then((mod) => ({ default: mod.DiffEditor })),
);

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
  // the currently-selected file path for keyboard nav and the review banner.
  onSelectionChange?: (path: string | null) => void;
  // Optional notifier so a parent can refresh its own copy of the diff summary
  // after the API view fetches a new one (used for `reviewed_count` / banner).
  onSummaryLoaded?: (summary: import('@/lib/api').DiffSummaryResponse) => void;
  // When provided, the file tree's reviewed checkbox calls this instead of the
  // local-storage backed flow — TaskDetail uses the API.
  onToggleReviewed?: (path: string, currentlyReviewed: boolean) => void;
}

function extToLanguage(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    md: 'markdown',
    css: 'css',
    html: 'html',
    py: 'python',
    go: 'go',
    rs: 'rust',
    sh: 'shell',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'ini',
  };
  return map[ext] ?? 'plaintext';
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
}: {
  taskId: string;
  isRunning: boolean;
  onSelectionChange?: (path: string | null) => void;
  onSummaryLoaded?: (summary: import('@/lib/api').DiffSummaryResponse) => void;
  onToggleReviewed?: (path: string, currentlyReviewed: boolean) => void;
}) {
  const [files, setFiles] = useState<DiffFileEntry[]>([]);
  const [ignoredTruncated, setIgnoredTruncated] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<FileDiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [baseShaUnavailable, setBaseShaUnavailable] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [expandedAll, setExpandedAll] = useState(false);
  const expandedFallback = useRef<Record<string, boolean>>({});
  const [reviewed, setReviewedState] = useState<Set<string>>(new Set());

  // Hydrate reviewed set from localStorage whenever the file list changes.
  useEffect(() => {
    const next = new Set<string>();
    for (const f of files) {
      if (getReviewed(taskId, f.path)) next.add(f.path);
    }
    setReviewedState(next);
  }, [taskId, files]);

  const toggleReviewed = useCallback(
    (path: string) => {
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
    [taskId],
  );

  const reviewCounts = useMemo(() => {
    const nonIgnored = files.filter((f) => !f.ignored);
    const total = nonIgnored.length;
    const done = nonIgnored.filter((f) => reviewed.has(f.path)).length;
    return { done, total };
  }, [files, reviewed]);

  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const editorKeyRef = useRef<string | null>(null);
  const viewStates = useRef<Map<string, editor.IDiffEditorViewState>>(new Map());

  const viewStateKey = useCallback(
    (path: string, expanded: boolean) => `${taskId}::${path}::${expanded ? 'e' : 'c'}`,
    [taskId],
  );

  const saveActiveViewState = useCallback(() => {
    const ed = editorRef.current;
    const k = editorKeyRef.current;
    if (!ed || !k) return;
    const s = ed.saveViewState();
    if (s) viewStates.current.set(k, s);
  }, []);

  const handleSelect = useCallback(
    (path: string) => {
      saveActiveViewState();
      setSelected(path);
    },
    [saveActiveViewState],
  );

  const handleEditorMount = useCallback<DiffOnMount>(
    (ed) => {
      editorRef.current = ed;
      const k = selected ? viewStateKey(selected, expandedAll) : null;
      editorKeyRef.current = k;
      if (!k) return;
      const saved = viewStates.current.get(k);
      if (!saved) return;
      const disposable = ed.onDidUpdateDiff(() => {
        ed.restoreViewState(saved);
        disposable.dispose();
      });
    },
    [selected, expandedAll, viewStateKey],
  );

  const selectedRef = useRef<string | null>(null);
  useEffect(() => {
    selectedRef.current = selected;
    onSelectionChange?.(selected);
  }, [selected, onSelectionChange]);

  const loadSummary = useCallback(async () => {
    try {
      const s = await api.getTaskDiffSummary(taskId);
      setFiles(s.files);
      setIgnoredTruncated(s.ignoredTruncated ?? false);
      onSummaryLoaded?.(s);
      setError(null);
      setBaseShaUnavailable(false);
      const cur = selectedRef.current;
      if (!cur && s.files.length > 0) setSelected(s.files[0].path);
      else if (cur && !s.files.find((f) => f.path === cur)) {
        setSelected(s.files[0]?.path ?? null);
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('base_sha not available')) {
        setFiles([]);
        setBaseShaUnavailable(true);
        setError(null);
      } else {
        setError(msg);
      }
    } finally {
      setSummaryLoading(false);
    }
  }, [taskId, onSummaryLoaded]);

  useEffect(() => {
    loadSummary();
    if (!isRunning) return;
    const t = setInterval(loadSummary, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [loadSummary, isRunning]);

  useEffect(() => {
    if (!selected) {
      setFileDiff(null);
      setExpandedAll(false);
      return;
    }
    const stored = (() => {
      try {
        return getDiffExpanded(taskId, selected);
      } catch {
        return expandedFallback.current[selected] ?? false;
      }
    })();
    setExpandedAll(stored);
    let cancelled = false;
    setFileLoading(true);
    setError(null); // clear stale error on new selection
    api
      .getTaskDiffFile(taskId, selected)
      .then((d) => {
        if (!cancelled) setFileDiff(d);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setFileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, selected]);

  const toggleExpandedAll = useCallback(() => {
    if (!selected) return;
    const next = !expandedAll;
    setExpandedAll(next);
    try {
      setDiffExpanded(taskId, selected, next);
    } catch {
      expandedFallback.current[selected] = next;
    }
  }, [taskId, selected, expandedAll]);

  const showToolbar = Boolean(
    selected && fileDiff && !fileDiff.tooLarge && !fileDiff.binary && !error,
  );

  if (baseShaUnavailable) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Diff unavailable (base_sha not captured)
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
    <div className="flex h-full min-h-0 gap-3 p-3">
      <aside
        data-testid="diff-file-list"
        className="bg-glass-l1 glass-blur-l1 flex w-[260px] shrink-0 flex-col overflow-hidden border border-glass-edge"
      >
        {summaryLoading && files.length === 0 ? (
          <div className="p-4 text-xs text-muted-foreground">Loading diff...</div>
        ) : (
          <DiffFileTree
            files={files}
            selected={selected}
            onSelect={handleSelect}
            taskId={taskId}
            ignoredTruncated={ignoredTruncated}
            reviewed={reviewed}
            onToggleReview={toggleReviewed}
            onToggleReviewed={onToggleReviewedProp}
          />
        )}
      </aside>
      <main
        data-testid="diff-pane"
        className="flex min-w-0 flex-1 flex-col overflow-hidden border border-glass-edge"
        style={{
          background: '#0B0C0F',
          boxShadow: '0 8px 24px -6px rgba(0,0,0,0.5)',
        }}
      >
        <div
          className="flex items-center justify-between gap-3 px-4 py-[10px]"
          style={{ background: '#101217', borderBottom: '1px solid rgba(255,255,255,0.06)' }}
        >
          <span className="flex min-w-0 items-center gap-3">
            {showToolbar && selected ? (
              <span className="truncate font-mono text-[11px] text-[#B5B5BD]">{selected}</span>
            ) : null}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {reviewCounts.total > 0 ? (
              <span
                data-testid="review-progress"
                aria-label={`${reviewCounts.done} of ${reviewCounts.total} reviewed`}
                className="bg-glass-l1 glass-blur-l1 inline-flex items-center gap-1 border border-[#22D3EE] px-1.5 py-0.5 font-mono text-[11px] tracking-wider text-[#22D3EE]"
              >
                {reviewCounts.done} / {reviewCounts.total} reviewed
              </span>
            ) : null}
            {showToolbar && selected ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={toggleExpandedAll}
                aria-label={expandedAll ? 'Collapse all' : 'Expand all'}
              >
                {expandedAll ? 'Collapse all' : 'Expand all'}
              </Button>
            ) : null}
          </span>
        </div>
        <div className="min-h-0 flex-1">
          {error && selected ? (
            <div className="flex h-full items-center justify-center text-sm text-destructive">
              {error}
            </div>
          ) : !selected ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a file to view its diff
            </div>
          ) : fileLoading && !fileDiff ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading {selected}...
            </div>
          ) : fileDiff?.tooLarge ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {selected} is too large to display (&gt;1 MiB). Open the worktree directly.
            </div>
          ) : fileDiff?.binary ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {selected} is a binary file.
            </div>
          ) : fileDiff ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Loading editor...
                </div>
              }
            >
              <MonacoDiff
                key={`${selected}:${expandedAll ? 'expanded' : 'collapsed'}`}
                height="100%"
                original={fileDiff.oldContent}
                modified={fileDiff.newContent}
                language={extToLanguage(selected)}
                theme="vs-dark"
                onMount={handleEditorMount}
                options={{
                  readOnly: true,
                  renderSideBySide: true,
                  minimap: { enabled: true },
                  hideUnchangedRegions: { enabled: !expandedAll },
                  scrollBeyondLastLine: false,
                }}
              />
            </Suspense>
          ) : null}
        </div>
      </main>
    </div>
  );
}

export default DiffViewer;
