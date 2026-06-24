import '@/lib/monaco-env';
import { Suspense, forwardRef, lazy, useCallback, useMemo, useRef, useState } from 'react';
import type { DiffOnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import type { DiffFileEntry, FileDiffResponse } from '@/lib/api/taskApi';
import type { Agent } from '../../server/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ClampedExplainer } from '@/components/review/ClampedExplainer';
import { useDiffEditorHostSize } from '@/hooks/useDiffEditorHostSize';
import { useDiffEditorLayout } from '@/hooks/useDiffEditorLayout';
import { useInlineCommentZones } from '@/hooks/useInlineCommentZones';
import { useCommentsContext } from '@/hooks/useTaskComments';

const MonacoDiff = lazy(() =>
  import('@monaco-editor/react').then((mod) => ({ default: mod.DiffEditor })),
);

const MIN_HEIGHT = 200;
const MAX_INITIAL_HEIGHT = 800;
const LINE_PX = 18;

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

function estimateHeight(file: DiffFileEntry): number {
  const lines = (file.additions ?? 0) + (file.deletions ?? 0);
  return Math.min(MAX_INITIAL_HEIGHT, Math.max(MIN_HEIGHT, lines * LINE_PX));
}

export interface DiffFileRowProps {
  file: DiffFileEntry;
  diff: FileDiffResponse | null;
  loading: boolean;
  error: string | null;
  mounted: boolean; // when true, MonacoDiff is rendered
  expanded: boolean;
  reviewed: boolean;
  active: boolean;
  showReviewToggle: boolean;
  onToggleReviewed: () => void;
  onToggleExpanded: () => void;
  onEditorMount?: (path: string, ed: editor.IStandaloneDiffEditor) => void;
  /** Agents on the task — used to attribute non-user comments. */
  agents?: Agent[];
  /** Whether the surrounding diff is showing the base range (controls outdated chip). */
  rangeIsBase?: boolean;
  /** When true, inline comment threads render. Defaults to true if a comments
   *  context is available — false in standalone use. */
  enableComments?: boolean;
  /** Walkthrough file summary — shown below the file header in review mode. */
  explainer?: string;
}

export const DiffFileRow = forwardRef<HTMLElement, DiffFileRowProps>(function DiffFileRow(
  {
    file,
    diff,
    loading,
    error,
    mounted,
    expanded,
    reviewed,
    active,
    showReviewToggle,
    onToggleReviewed,
    onToggleExpanded,
    onEditorMount,
    agents = [],
    rangeIsBase = true,
    enableComments = false,
    explainer,
  },
  ref,
) {
  const path = file.path;
  const placeholderHeight = estimateHeight(file);
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const [contentHeight, setContentHeight] = useState<number>(placeholderHeight);
  const [editorInstance, setEditorInstance] = useState<editor.IStandaloneDiffEditor | null>(null);

  const canRenderDiffBody =
    !file.ignored && !file.tooLarge && !file.binary && !error && !diff?.isDirectory;
  const showEditor = canRenderDiffBody && diff !== null;
  const awaitingMount = canRenderDiffBody && !mounted;
  const showLoadingPlaceholder = canRenderDiffBody && mounted && (loading || !diff);

  const hostReady = mounted && showEditor;
  const hostSize = useDiffEditorHostSize(editorHostRef, hostReady);
  const canMountMonaco = hostReady && hostSize.width > 0;
  const editorHeight = Math.max(contentHeight, MIN_HEIGHT);

  useDiffEditorLayout(canMountMonaco ? editorInstance : null, editorHostRef);

  const handleMount = useCallback<DiffOnMount>(
    (ed) => {
      onEditorMount?.(path, ed);
      setEditorInstance(ed);

      const recomputeHeight = () => {
        const host = editorHostRef.current;
        const w = host?.clientWidth ?? 0;
        const orig = ed.getOriginalEditor().getContentHeight();
        const mod = ed.getModifiedEditor().getContentHeight();
        const h = Math.max(orig, mod, MIN_HEIGHT);
        if (w > 0) ed.layout({ width: w, height: h });
        setContentHeight(h);
      };

      ed.getOriginalEditor().onDidContentSizeChange(recomputeHeight);
      ed.getModifiedEditor().onDidContentSizeChange(recomputeHeight);
      requestAnimationFrame(() => {
        recomputeHeight();
        requestAnimationFrame(recomputeHeight);
      });
    },
    [path, onEditorMount],
  );

  const portals = enableComments ? (
    <CommentZonePortals
      editor={editorInstance}
      filePath={path}
      agents={agents}
      rangeIsBase={rangeIsBase}
    />
  ) : null;

  return (
    <section
      ref={ref}
      data-testid={`diff-row-${path}`}
      data-file-path={path}
      data-active={active ? 'true' : undefined}
      data-reviewed={reviewed ? 'true' : 'false'}
      id={`file-${encodeURIComponent(path)}`}
      className="border-b border-glass-edge bg-glass-l0 last:border-b-0"
    >
      <header className="diff-pane-header flex items-center justify-between gap-3 px-4 py-2">
        <span className="flex min-w-0 items-center gap-2">
          {showReviewToggle ? (
            <input
              type="checkbox"
              checked={reviewed}
              aria-label={reviewed ? `Unmark ${path} as reviewed` : `Mark ${path} as reviewed`}
              data-testid={`review-toggle-${path}`}
              onChange={onToggleReviewed}
              className="h-3.5 w-3.5 shrink-0 cursor-pointer"
            />
          ) : null}
          <span
            className={cn(
              'truncate font-mono text-[11px] text-muted-foreground',
              reviewed && 'opacity-60',
            )}
          >
            {path}
          </span>
          <span className="shrink-0 font-mono text-[10px] tabular-nums">
            <span className="text-green-500">+{file.additions}</span>
            <span className="text-muted-foreground"> / </span>
            <span className="text-red-500">-{file.deletions}</span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {showEditor ? (
            <Button
              variant="ghost"
              size="xs"
              onClick={onToggleExpanded}
              aria-label={expanded ? `Collapse all in ${path}` : `Expand all in ${path}`}
            >
              {expanded ? 'Collapse all' : 'Expand all'}
            </Button>
          ) : null}
        </span>
      </header>
      {explainer ? (
        <div
          data-testid={`diff-file-explainer-${path}`}
          className="border-b border-glass-edge/60 bg-glass-l1/30 px-4 py-2"
        >
          <ClampedExplainer
            text={explainer}
            lines={3}
            clampChars={200}
            className="text-xs leading-relaxed text-muted-foreground"
          />
        </div>
      ) : null}
      <div className="min-w-0 w-full">
        {error ? (
          <div className="flex h-32 items-center justify-center text-sm text-destructive">
            {error}
          </div>
        ) : file.tooLarge ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            {path} is too large to display (&gt;1 MiB). Open the worktree directly.
          </div>
        ) : file.binary ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            {path} is a binary file.
          </div>
        ) : diff?.isDirectory ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            {path} resolves to a directory; cannot show diff.
          </div>
        ) : awaitingMount ? (
          <div className="h-px" aria-hidden />
        ) : showLoadingPlaceholder ? (
          <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
            {loading ? `Loading ${path}…` : null}
          </div>
        ) : showEditor && diff ? (
          <div
            ref={editorHostRef}
            className="diff-editor-host w-full min-w-0"
            style={{ height: editorHeight }}
          >
            {canMountMonaco ? (
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    Loading editor…
                  </div>
                }
              >
                <MonacoDiff
                  key={`${path}:${expanded ? 'e' : 'c'}:${hostSize.width}`}
                  width={hostSize.width}
                  height={editorHeight}
                  className="diff-editor-host-inner"
                  original={diff.oldContent}
                  modified={diff.newContent}
                  language={extToLanguage(path)}
                  theme="vs-dark"
                  onMount={handleMount}
                  options={{
                    readOnly: true,
                    renderSideBySide: true,
                    useInlineViewWhenSpaceIsLimited: false,
                    automaticLayout: false,
                    minimap: { enabled: false },
                    hideUnchangedRegions: { enabled: !expanded },
                    scrollBeyondLastLine: false,
                    scrollBeyondLastColumn: 0,
                    fixedOverflowWidgets: false,
                    scrollbar: {
                      alwaysConsumeMouseWheel: false,
                      vertical: 'auto',
                      horizontal: 'auto',
                    },
                  }}
                />
                {portals}
              </Suspense>
            ) : (
              <div className="flex h-full min-h-[200px] items-center justify-center text-xs text-muted-foreground">
                Loading editor…
              </div>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
});

/**
 * Inner component that subscribes to the comments context and drives the
 * Monaco view-zone hook. Kept separate so DiffFileRow can opt out of the
 * context (standalone usage in tests / composer mode) by setting
 * enableComments=false.
 */
function CommentZonePortals({
  editor: editorInstance,
  filePath,
  agents,
  rangeIsBase,
}: {
  editor: editor.IStandaloneDiffEditor | null;
  filePath: string;
  agents: Agent[];
  rangeIsBase: boolean;
}) {
  const ctx = useCommentsContext();
  const fileComments = useMemo(() => ctx.byFile(filePath), [ctx, filePath]);

  const portals = useInlineCommentZones({
    editor: editorInstance,
    filePath,
    comments: fileComments,
    agents,
    rangeIsBase,
    outdatedUnavailable: ctx.outdatedUnavailable,
    openComposer: ctx.openComposer,
    onOpenComposer: useCallback(
      (line: number, side: 'old' | 'new') => ctx.setOpenComposer({ filePath, line, side }),
      [ctx, filePath],
    ),
    onCancelComposer: useCallback(() => ctx.setOpenComposer(null), [ctx]),
    onPostComment: useCallback((input) => ctx.post(input), [ctx]),
    onQueueDraft: useCallback((draft) => ctx.queueDraft(draft), [ctx]),
    onReply: useCallback(
      (parent, body) =>
        ctx.post({
          file_path: parent.file_path,
          line: parent.line,
          side: parent.side,
          body,
        }),
      [ctx],
    ),
    onResolve: useCallback(
      (commentId, resolved) => {
        void ctx.update(commentId, { resolved });
      },
      [ctx],
    ),
    onDelete: useCallback(
      (commentId) => {
        void ctx.remove(commentId);
      },
      [ctx],
    ),
    onEdit: useCallback(
      (commentId, body) => {
        void ctx.update(commentId, { body });
      },
      [ctx],
    ),
    focusedId: ctx.focusedId,
  });

  return <>{portals}</>;
}

export default DiffFileRow;
