import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { taskApi, type DiffSummaryResponse } from '../lib/api/taskApi';
import type { InlineCommentDTO } from '../lib/api/reviewApi';
import { useReviewDetail } from '../lib/hooks';
import { WalkthroughOrient } from '../components/review/WalkthroughOrient';
import { WalkthroughSpine } from '../components/review/WalkthroughSpine';
import { DiscussionTab } from '../components/review/DiscussionTab';
import type { Walkthrough, WalkthroughHighlight } from '../components/review/walkthrough-types';
import { buildGroups, orderedPathsFromGroups, type RenderGroup } from '@/lib/review-file-groups';
import { activeFindings, historyFindings, isBlocking } from '@/lib/review-findings';
import { ReviewFileTree } from '../components/review/ReviewFileTree';
import { PublishBar } from '../components/review/PublishBar';
import { HeadAdvancedBanner } from '../components/review/HeadAdvancedBanner';
import { FindingQueue } from '../components/review/FindingQueue';
import {
  REVIEW_FINDING_KEYBINDS,
  useReviewFindingKeyboard,
} from '@/hooks/useReviewFindingKeyboard';
import { DiffViewer } from '../components/DiffViewer';
import type { DiffFileListHandle } from '../components/DiffFileList';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type Mode = 'orient' | 'review';
type ReviewView = 'changes' | 'discussion';

export default function ReviewDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { detail, error, refresh } = useReviewDetail(id);
  const [filesInDiff, setFilesInDiff] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(null);
  const [showFileTree, setShowFileTree] = useState(false);
  const [mobileFileTreeOpen, setMobileFileTreeOpen] = useState(false);
  const diffListRef = useRef<DiffFileListHandle | null>(null);
  const publishRef = useRef<() => void>(() => {});
  const pendingReveal = useRef<{ path: string; line?: number; side?: 'old' | 'new' } | null>(null);

  const [reviewedFiles, setReviewedFiles] = useState<Set<string>>(new Set());

  const walkthrough = useMemo<Walkthrough | null>(() => {
    const raw = detail?.latest_run?.walkthrough;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Walkthrough;
    } catch {
      return null;
    }
  }, [detail]);

  // Orient by default when there's a walkthrough to read; straight to the diff otherwise.
  const [mode, setMode] = useState<Mode | null>(null);
  const effectiveMode: Mode = mode ?? (walkthrough ? 'orient' : 'review');
  const [view, setView] = useState<ReviewView>('changes');
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);

  const handleToggleReviewed = useCallback(
    async (path: string, currentlyReviewed: boolean) => {
      setReviewedFiles((prev) => {
        const next = new Set(prev);
        if (currentlyReviewed) next.delete(path);
        else next.add(path);
        return next;
      });
      try {
        if (currentlyReviewed) await taskApi.unmarkReviewed(id!, path);
        else await taskApi.markReviewed(id!, path);
      } catch {
        setReviewedFiles((prev) => {
          const next = new Set(prev);
          if (currentlyReviewed) next.add(path);
          else next.delete(path);
          return next;
        });
      }
    },
    [id],
  );

  const reviewedHydratedRef = useRef(false);
  const handleSummaryLoaded = useCallback((s: DiffSummaryResponse) => {
    if (reviewedHydratedRef.current) return;
    reviewedHydratedRef.current = true;
    const set = new Set<string>();
    for (const f of s.files) if (f.reviewed) set.add(f.path);
    setReviewedFiles(set);
  }, []);

  const orderedGroups = useMemo(
    () => buildGroups(filesInDiff, walkthrough),
    [filesInDiff, walkthrough],
  );
  const orderedFileOrder = useMemo(() => orderedPathsFromGroups(orderedGroups), [orderedGroups]);

  // Orient shows every declared group straight from the walkthrough — it must not
  // wait on the diff to mount (filesInDiff is empty until then).
  const orientGroups = useMemo<RenderGroup[]>(
    () =>
      (walkthrough?.groups ?? []).map((g) => ({
        name: g.name,
        summary: g.summary,
        files: g.files ?? [],
      })),
    [walkthrough],
  );

  // Reveal code in the diff. From orient the diff isn't mounted yet, so defer via
  // pendingReveal until onFilesChange reports the file has loaded.
  const revealCode = useCallback(
    (path: string, line?: number, side?: 'old' | 'new') => {
      setMode('review');
      setView('changes');
      setOverlayOpen(false);
      setSelectedPath(path);
      if (filesInDiff.includes(path)) {
        if (line != null) diffListRef.current?.revealLineInFile(path, line, side);
        else diffListRef.current?.scrollToFile(path);
      } else {
        pendingReveal.current = { path, line, side };
      }
    },
    [filesInDiff],
  );

  useEffect(() => {
    const p = pendingReveal.current;
    if (p && filesInDiff.includes(p.path)) {
      if (p.line != null) diffListRef.current?.revealLineInFile(p.path, p.line, p.side);
      else diffListRef.current?.scrollToFile(p.path);
      pendingReveal.current = null;
    }
  }, [filesInDiff]);

  const handleSelectFile = useCallback((path: string) => {
    setView('changes');
    setSelectedPath(path);
    diffListRef.current?.scrollToFile(path);
    setMobileFileTreeOpen(false);
  }, []);

  const handleSelectFinding = useCallback((comment: InlineCommentDTO) => {
    setSelectedFindingId(comment.id);
    setView('changes');
    setSelectedPath(comment.file_path);
    diffListRef.current?.revealLineInFile(comment.file_path, comment.line, comment.side);
  }, []);

  const handleJumpToFindingCode = useCallback((comment: InlineCommentDTO) => {
    setView('changes');
    setSelectedPath(comment.file_path);
    diffListRef.current?.revealLineInFile(comment.file_path, comment.line, comment.side);
  }, []);

  const handleSelectHighlight = useCallback(
    (h: WalkthroughHighlight) => {
      if (!h.file) return;
      revealCode(h.file, h.line, h.side ?? 'new');
    },
    [revealCode],
  );

  const handleSelectGroup = useCallback(
    (group: RenderGroup) => {
      const first = group.files[0]?.path;
      if (first) revealCode(first);
    },
    [revealCode],
  );

  // File-level keyboard nav (page owns files + publish + cheatsheet).
  const gotoFileByOffset = useCallback(
    (delta: number) => {
      if (orderedFileOrder.length === 0) return;
      const idx = selectedPath ? orderedFileOrder.indexOf(selectedPath) : -1;
      const nextIdx =
        idx === -1
          ? delta > 0
            ? 0
            : orderedFileOrder.length - 1
          : (idx + delta + orderedFileOrder.length) % orderedFileOrder.length;
      handleSelectFile(orderedFileOrder[nextIdx]);
    },
    [orderedFileOrder, selectedPath, handleSelectFile],
  );

  const gotoNextUnreviewed = useCallback(() => {
    if (orderedFileOrder.length === 0) return;
    const start = selectedPath ? orderedFileOrder.indexOf(selectedPath) : -1;
    for (let i = 1; i <= orderedFileOrder.length; i++) {
      const p = orderedFileOrder[(start + i + orderedFileOrder.length) % orderedFileOrder.length];
      if (!reviewedFiles.has(p)) {
        handleSelectFile(p);
        return;
      }
    }
  }, [orderedFileOrder, selectedPath, reviewedFiles, handleSelectFile]);

  useReviewFindingKeyboard({
    onNextFile: () => gotoFileByOffset(1),
    onPrevFile: () => gotoFileByOffset(-1),
    onNextUnreviewed: gotoNextUnreviewed,
    onPublish: () => publishRef.current(),
    onToggleCheatsheet: () => setCheatsheetOpen((v) => !v),
  });

  if (error) return <div className="p-4 text-red-500 md:p-6">{error}</div>;
  if (!detail) return <div className="p-4 text-sm text-muted-foreground md:p-6">Loading…</div>;

  const comments = detail.comments;
  const draftCount = comments.filter((c) => c.status === 'draft').length;
  const acceptedCount = comments.filter((c) => c.status === 'accepted').length;
  const staleCount = comments.filter((c) => c.status === 'stale').length;

  const active = activeFindings(comments);
  const findingCount = active.length;
  const blockingCount = active.filter((c) => isBlocking(c.severity)).length;
  const discussionCount = historyFindings(comments).length + detail.published_history.length;

  const isRunning =
    detail.latest_run?.status === 'running' || detail.all_runs.some((r) => r.status === 'running');

  const orientView = walkthrough ? (
    <WalkthroughOrient
      walkthrough={walkthrough}
      groups={orientGroups}
      blockingCount={blockingCount}
      findingCount={findingCount}
      onStartReview={() => {
        setMode('review');
        setOverlayOpen(false);
      }}
      onSelectHighlight={handleSelectHighlight}
      onSelectGroup={handleSelectGroup}
    />
  ) : null;

  const fileTree = (
    <ReviewFileTree
      files={filesInDiff}
      walkthrough={walkthrough}
      comments={comments}
      selectedPath={selectedPath}
      reviewedFiles={reviewedFiles}
      onToggleReviewed={handleToggleReviewed}
      onSelect={handleSelectFile}
      hideFileSummaries
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <HeadAdvancedBanner taskId={id!} currentSha={detail.task.pr_head_sha} onRefresh={refresh} />

      <PublishBar
        taskId={id!}
        prTitle={detail.task.title}
        prNumber={detail.task.pr_number}
        prUrl={detail.task.pr_url ?? undefined}
        acceptedCount={acceptedCount}
        draftCount={draftCount}
        staleCount={staleCount}
        reviewedDone={reviewedFiles.size}
        reviewedTotal={filesInDiff.length}
        isRunning={isRunning}
        onPublished={refresh}
        onReRun={refresh}
        onDeleted={() => navigate('/reviews')}
        registerPublish={(fn) => {
          publishRef.current = fn;
        }}
      />

      {effectiveMode === 'orient' && orientView ? (
        orientView
      ) : (
        <>
          {walkthrough ? (
            <WalkthroughSpine
              groups={orderedGroups}
              selectedPath={selectedPath}
              onExpand={() => setOverlayOpen(true)}
              onSelectGroup={handleSelectGroup}
            />
          ) : null}

          {/* Changes | Discussion — the one legitimate tab split (triage stays welded to the diff). */}
          <div
            role="tablist"
            aria-label="Review views"
            className="flex shrink-0 items-center gap-1 border-b border-glass-edge px-3 py-1"
          >
            {(['changes', 'discussion'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                data-testid={`review-tab-${v}`}
                onClick={() => setView(v)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors',
                  view === v
                    ? 'bg-glass-l2 text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {v}
                {v === 'discussion' && discussionCount > 0 ? (
                  <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                    {discussionCount}
                  </span>
                ) : null}
              </button>
            ))}
            <button
              type="button"
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (?)"
              data-testid="cheatsheet-btn"
              onClick={() => setCheatsheetOpen(true)}
              className="ml-auto rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              ?
            </button>
          </div>

          {view === 'discussion' ? (
            <DiscussionTab
              taskId={id!}
              comments={comments}
              publishedHistory={detail.published_history}
              onUpdated={refresh}
            />
          ) : (
            <div className="flex min-h-0 flex-1">
              <aside
                data-testid="finding-queue-pane"
                className="glass-chrome flex w-full max-w-md shrink-0 flex-col overflow-hidden border-r border-glass-edge lg:w-[360px]"
              >
                <FindingQueue
                  taskId={id!}
                  comments={comments}
                  groups={orderedGroups}
                  selectedId={selectedFindingId}
                  onSelect={handleSelectFinding}
                  onUpdated={refresh}
                  onJumpToCode={handleJumpToFindingCode}
                />
              </aside>

              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-2 border-b border-glass-edge px-4 py-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid="review-files-toggle"
                    onClick={() => setShowFileTree((v) => !v)}
                    className="hidden lg:inline-flex"
                  >
                    {showFileTree ? 'Hide files' : 'Browse files'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid="review-mobile-files-button"
                    onClick={() => setMobileFileTreeOpen(true)}
                    className="lg:hidden"
                  >
                    Files{filesInDiff.length > 0 ? ` (${filesInDiff.length})` : ''}
                  </Button>
                  {selectedPath ? (
                    <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                      {selectedPath}
                    </span>
                  ) : null}
                </div>

                {showFileTree ? (
                  <div
                    data-testid="review-file-tree-inline"
                    className="hidden max-h-48 shrink-0 overflow-auto border-b border-glass-edge lg:block"
                  >
                    {fileTree}
                  </div>
                ) : null}

                <DiffViewer
                  taskId={id!}
                  isRunning={isRunning}
                  range={{ kind: 'base' }}
                  listRef={diffListRef}
                  onFilesChange={setFilesInDiff}
                  onSelectionChange={setSelectedPath}
                  onSummaryLoaded={handleSummaryLoaded}
                  onToggleReviewed={handleToggleReviewed}
                  hideFileTree
                  hideExplainers
                  fileOrder={orderedFileOrder}
                  groups={orderedGroups}
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* Expand-walkthrough overlay: the full orient view without unmounting the diff. */}
      <Dialog open={overlayOpen} onOpenChange={setOverlayOpen}>
        <DialogContent
          className="flex max-h-[min(88dvh,100dvh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
          showCloseButton
        >
          <DialogHeader className="border-b border-glass-edge px-4 py-3">
            <DialogTitle>Walkthrough</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-hidden">{orientView}</div>
        </DialogContent>
      </Dialog>

      <Dialog open={mobileFileTreeOpen} onOpenChange={setMobileFileTreeOpen}>
        <DialogContent
          className="flex max-h-[min(85dvh,100dvh)] flex-col gap-0 overflow-hidden p-0 sm:max-w-md"
          showCloseButton
        >
          <DialogHeader className="border-b border-glass-edge px-4 py-3">
            <DialogTitle>Changed files</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto">{fileTree}</div>
        </DialogContent>
      </Dialog>

      <Dialog open={cheatsheetOpen} onOpenChange={setCheatsheetOpen}>
        <DialogContent className="sm:max-w-sm" showCloseButton>
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
          </DialogHeader>
          <ul className="space-y-1.5 py-1" data-testid="cheatsheet-list">
            {REVIEW_FINDING_KEYBINDS.map((b) => (
              <li key={b.keys} className="flex items-center justify-between gap-4 text-sm">
                <span className="text-muted-foreground">{b.description}</span>
                <kbd className="rounded border border-glass-edge bg-glass-l1 px-1.5 py-0.5 font-mono text-[11px]">
                  {b.keys}
                </kbd>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}
