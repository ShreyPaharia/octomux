import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { api, type ReviewDetail, type DiffSummaryResponse } from '../lib/api';
import { subscribe } from '../lib/event-source';
import { WalkthroughHeader, type Walkthrough } from '../components/review/WalkthroughHeader';
import { buildGroups, orderedPathsFromGroups } from '@/lib/review-file-groups';
import { ReviewFileTree } from '../components/review/ReviewFileTree';
import { PublishBar } from '../components/review/PublishBar';
import { HeadAdvancedBanner } from '../components/review/HeadAdvancedBanner';
import { DiffViewer } from '../components/DiffViewer';
import { CommentsSidePanel } from '../components/CommentsSidePanel';
import { TaskCommentsContext, useTaskComments } from '../hooks/useTaskComments';
import type { DiffFileListHandle } from '../components/DiffFileList';

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
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filesInDiff, setFilesInDiff] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [showCommentsPanel, setShowCommentsPanel] = useState(defaultCommentsPanelOpen);
  const diffListRef = useRef<DiffFileListHandle | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(COMMENTS_PANEL_KEY, String(showCommentsPanel));
    } catch {
      // ignore
    }
  }, [showCommentsPanel]);

  const refresh = useCallback(() => {
    if (!id) return;
    api
      .getReviewDetail(id)
      .then(setDetail)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!id) return;
    return subscribe((event) => {
      const e = event as { type: string; payload: { taskId?: string } };
      if (!('taskId' in e.payload) || e.payload.taskId !== id) return;
      if (e.type === 'review:drafts-ready' || e.type === 'review:published') {
        refresh();
      }
    });
  }, [id, refresh]);

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

  const orderedFileOrder = useMemo(
    () => orderedPathsFromGroups(orderedGroups),
    [orderedGroups],
  );

  const handleSelectFile = useCallback((path: string) => {
    setSelectedPath(path);
    diffListRef.current?.scrollToFile(path);
  }, []);

  const handleJumpToComment = useCallback(
    (filePath: string, line: number, side: 'old' | 'new', commentId: string) => {
      setSelectedPath(filePath);
      diffListRef.current?.revealLineInFile(filePath, line, side);
      taskComments.setFocusedId(commentId);
      window.setTimeout(() => {
        if (taskComments.focusedId === commentId) taskComments.setFocusedId(null);
      }, 1600);
    },
    [taskComments],
  );

  if (error) return <div className="p-6 text-red-500">{error}</div>;
  if (!detail) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  const draftCount = detail.comments.filter((c) => c.status === 'draft').length;
  const acceptedCount = detail.comments.filter((c) => c.status === 'accepted').length;
  const staleCount = detail.comments.filter((c) => c.status === 'stale').length;

  const isRunning =
    detail.latest_run?.status === 'running' || detail.all_runs.some((r) => r.status === 'running');

  return (
    <TaskCommentsContext.Provider value={taskComments}>
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
        />

        {walkthrough && <WalkthroughHeader walkthrough={walkthrough} />}

        <div className="flex min-h-0 flex-1">
          <aside
            data-testid="review-file-tree-pane"
            className="glass-chrome flex w-[300px] shrink-0 flex-col overflow-hidden border-r border-glass-edge"
          >
            <ReviewFileTree
              files={filesInDiff}
              walkthrough={walkthrough}
              comments={detail.comments}
              selectedPath={selectedPath}
              reviewedFiles={reviewedFiles}
              onToggleReviewed={handleToggleReviewed}
              onSelect={handleSelectFile}
            />
          </aside>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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

          {showCommentsPanel && (
            <CommentsSidePanel
              agents={[]}
              filesInDiff={filesInDiffSet}
              rangeIsBase={true}
              onJumpTo={handleJumpToComment}
              onClose={() => setShowCommentsPanel(false)}
            />
          )}
        </div>
      </div>
    </TaskCommentsContext.Provider>
  );
}
