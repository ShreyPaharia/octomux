import '@/lib/monaco-env';
import { Suspense, forwardRef, lazy, useCallback, useMemo, useState } from 'react';
import type { DiffOnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import type { DiffFileEntry, FileDiffResponse } from '@/lib/api';
import type { Agent } from '../../server/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useInlineCommentZones } from '@/hooks/useInlineCommentZones';
import { useTaskCommentsContext } from '@/hooks/useTaskComments';

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
  },
  ref,
) {
  const path = file.path;
  const placeholderHeight = estimateHeight(file);
  const [height, setHeight] = useState<number>(placeholderHeight);
  const [editorInstance, setEditorInstance] = useState<editor.IStandaloneDiffEditor | null>(null);

  const showEditor =
    !file.ignored && !file.tooLarge && !file.binary && !error && diff !== null && !diff.isDirectory;
  const showLoadingPlaceholder =
    !file.ignored && !file.tooLarge && !file.binary && !error && (!mounted || loading || !diff);

  const handleMount = useCallback<DiffOnMount>(
    (ed) => {
      onEditorMount?.(path, ed);
      const recompute = () => {
        const orig = ed.getOriginalEditor().getContentHeight();
        const mod = ed.getModifiedEditor().getContentHeight();
        const h = Math.max(orig, mod, MIN_HEIGHT);
        setHeight(h);
      };
      ed.getOriginalEditor().onDidContentSizeChange(recompute);
      ed.getModifiedEditor().onDidContentSizeChange(recompute);
      recompute();
      setEditorInstance(ed);
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
      className="border border-glass-edge bg-[#0B0C0F]"
    >
      <header
        className={cn(
          'sticky top-0 z-10 flex items-center justify-between gap-3 px-4 py-[10px]',
          'border-b border-[rgba(255,255,255,0.06)]',
        )}
        style={{ background: '#101217' }}
      >
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
              'truncate font-mono text-[11px] text-[#B5B5BD]',
              reviewed && 'text-muted-foreground line-through',
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
      <div className="min-w-0">
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
        ) : showLoadingPlaceholder ? (
          <div
            className="flex items-center justify-center text-xs text-muted-foreground"
            style={{ height: placeholderHeight }}
          >
            {loading ? `Loading ${path}…` : ''}
          </div>
        ) : showEditor && diff ? (
          <Suspense
            fallback={
              <div
                className="flex items-center justify-center text-xs text-muted-foreground"
                style={{ height: placeholderHeight }}
              >
                Loading editor…
              </div>
            }
          >
            <div style={{ height }}>
              <MonacoDiff
                key={`${path}:${expanded ? 'e' : 'c'}`}
                height="100%"
                original={diff.oldContent}
                modified={diff.newContent}
                language={extToLanguage(path)}
                theme="vs-dark"
                onMount={handleMount}
                options={{
                  readOnly: true,
                  renderSideBySide: true,
                  automaticLayout: true,
                  minimap: { enabled: false },
                  hideUnchangedRegions: { enabled: !expanded },
                  scrollBeyondLastLine: false,
                  scrollbar: { alwaysConsumeMouseWheel: false },
                }}
              />
            </div>
            {portals}
          </Suspense>
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
  const ctx = useTaskCommentsContext();
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
