import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type ReviewDetail, type DiffSummaryResponse } from '../lib/api';
import { useResource } from '../lib/use-resource';
import { WalkthroughPanel } from '../components/review/WalkthroughPanel';
import type { Walkthrough } from '../components/review/walkthrough-types';
import { buildGroups, orderedPathsFromGroups } from '@/lib/review-file-groups';
import { ReviewFileTree } from '../components/review/ReviewFileTree';
import { ReviewContextStrip } from '../components/review/ReviewContextStrip';
import { PublishBar } from '../components/review/PublishBar';
import { HeadAdvancedBanner } from '../components/review/HeadAdvancedBanner';
import { DiffViewer } from '../components/DiffViewer';
import { CommentsSidePanel } from '../components/CommentsSidePanel';
import { CommentsContext, useTaskComments } from '../hooks/useTaskComments';
import type { DiffFileListHandle } from '../components/DiffFileList';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
const COMMENTS_PANEL_KEY = 'octomux:review:comments-panel-open';

function defaultCommentsPanelOpen(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const stored = localStorage.getItem(COMMENTS_PANEL_KEY);
    if (stored !== null) return stored === 'true';
  } catch {
    // localStorage unavailable
  }
  return window.innerWidth >= 1440;
}

export default function ReviewDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const {
    data: detail,
    error,
    refresh,
  } = useResource<ReviewDetail>(id ? `review:${id}` : null, () => api.getReviewDetail(id!), {
    events: (e) =>
      e.payload.taskId === id &&
      (e.type === 'review:drafts-ready' || e.type === 'review:published'),
  });
  const [filesInDiff, setFilesInDiff] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [showCommentsPanel, setShowCommentsPanel] = useState(defaultCommentsPanelOpen);
  const [mobileFileTreeOpen, setMobileFileTreeOpen] = useState(false);
  const diffListRef = useRef<DiffFileListHandle | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(COMMENTS_PANEL_KEY, String(showCommentsPanel));
    } catch {
      // ignore
    }
  }, [showCommentsPanel]);

  const taskComments = useTaskComments(id);

  const [reviewedFiles, setReviewedFiles] = useState<Set<string>>(new Set());

  const handleToggleReviewed = useCallback(
    async (path: string, currentlyReviewed: boolean) => {
      setReviewedFiles((prev) => {
        const next = new Set(prev);
        if (currentlyReviewed) next.delete(path);
        else next.add(path);
        return next;
      });
      try {
        if (currentlyReviewed) await api.unmarkReviewed(id!, path);
        else await api.markReviewed(id!, path);
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

  const filesInDiffSet = useMemo(() => new Set(filesInDiff), [filesInDiff]);

  const walkthrough = useMemo<Walkthrough | null>(() => {
    const raw = detail?.latest_run?.walkthrough;
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Walkthrough;
    } catch {
      return null;
    }
  }, [detail]);

  const orderedGroups = useMemo(
    () => buildGroups(filesInDiff, walkthrough),
    [filesInDiff, walkthrough],
  );

  const orderedFileOrder = useMemo(() => orderedPathsFromGroups(orderedGroups), [orderedGroups]);

  const handleSelectFile = useCallback((path: string) => {
    setSelectedPath(path);
    diffListRef.current?.scrollToFile(path);
    setMobileFileTreeOpen(false);
  }, []);

  const handleJumpToComment = useCallback(
    (filePath: string, line: number, side: 'old' | 'new', commentId: string) => {
      setSelectedPath(filePath);
      diffListRef.current?.revealLineInFile(filePath, line, side);
      taskComments.setFocusedId(commentId);
      setShowCommentsPanel(false);
      window.setTimeout(() => {
        if (taskComments.focusedId === commentId) taskComments.setFocusedId(null);
      }, 1600);
    },
    [taskComments],
  );

  if (error) return <div className="p-4 text-red-500 md:p-6">{error}</div>;
  if (!detail) return <div className="p-4 text-sm text-muted-foreground md:p-6">Loading…</div>;

  const draftCount = detail.comments.filter((c) => c.status === 'draft').length;
  const acceptedCount = detail.comments.filter((c) => c.status === 'accepted').length;
  const staleCount = detail.comments.filter((c) => c.status === 'stale').length;

  const isRunning =
    detail.latest_run?.status === 'running' || detail.all_runs.some((r) => r.status === 'running');

  const fileTree = (
    <ReviewFileTree
      files={filesInDiff}
      walkthrough={walkthrough}
      comments={detail.comments}
      selectedPath={selectedPath}
      reviewedFiles={reviewedFiles}
      onToggleReviewed={handleToggleReviewed}
      onSelect={handleSelectFile}
    />
  );

  const commentsPanel = (
    <CommentsSidePanel
      agents={[]}
      filesInDiff={filesInDiffSet}
      rangeIsBase={true}
      onJumpTo={handleJumpToComment}
      onClose={() => setShowCommentsPanel(false)}
      className="h-full w-full max-w-none lg:w-80"
    />
  );

  return (
    <CommentsContext.Provider value={taskComments}>
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
          totalCommentsCount={taskComments.byId.size}
          showCommentsPanel={showCommentsPanel}
          onToggleCommentsPanel={() => setShowCommentsPanel((v) => !v)}
          isRunning={isRunning}
          onPublished={refresh}
          onReRun={refresh}
          onDeleted={() => navigate('/reviews')}
        />

        {walkthrough && <WalkthroughPanel walkthrough={walkthrough} />}

        <ReviewContextStrip groups={orderedGroups} selectedPath={selectedPath} />

        <div className="flex min-h-0 flex-1">
          <aside
            data-testid="review-file-tree-pane"
            className="glass-chrome hidden w-[320px] shrink-0 flex-col overflow-hidden border-r border-glass-edge lg:flex"
          >
            {fileTree}
          </aside>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-glass-edge px-4 py-2 lg:hidden">
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="review-mobile-files-button"
                onClick={() => setMobileFileTreeOpen(true)}
              >
                Files{filesInDiff.length > 0 ? ` (${filesInDiff.length})` : ''}
              </Button>
              {selectedPath ? (
                <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                  {selectedPath}
                </span>
              ) : null}
            </div>

            <DiffViewer
              taskId={id!}
              isRunning={isRunning}
              range={{ kind: 'base' }}
              listRef={diffListRef}
              enableComments
              onFilesChange={setFilesInDiff}
              onSelectionChange={setSelectedPath}
              onSummaryLoaded={handleSummaryLoaded}
              onToggleReviewed={handleToggleReviewed}
              hideFileTree
              fileOrder={orderedFileOrder}
              groups={orderedGroups}
            />
          </div>

          {showCommentsPanel ? (
            <div className="hidden shrink-0 lg:flex">{commentsPanel}</div>
          ) : null}
        </div>

        {showCommentsPanel ? (
          <div
            className="fixed inset-0 z-50 flex lg:hidden"
            data-testid="review-mobile-comments-overlay"
          >
            <button
              type="button"
              className="absolute inset-0 bg-black/60"
              aria-label="Close comments"
              onClick={() => setShowCommentsPanel(false)}
            />
            <div className="relative ml-auto h-full w-full max-w-sm">{commentsPanel}</div>
          </div>
        ) : null}

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
      </div>
    </CommentsContext.Provider>
  );
}
