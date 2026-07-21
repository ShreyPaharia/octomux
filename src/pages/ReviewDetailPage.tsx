import { useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { taskApi, type DiffSummaryResponse } from '../lib/api/taskApi';
import type { InlineCommentDTO } from '../lib/api/reviewApi';
import { useReviewDetail } from '../lib/hooks';
import { WalkthroughPanel } from '../components/review/WalkthroughPanel';
import type { Walkthrough } from '../components/review/walkthrough-types';
import { buildGroups, orderedPathsFromGroups } from '@/lib/review-file-groups';
import { ReviewFileTree } from '../components/review/ReviewFileTree';
import { ReviewContextStrip } from '../components/review/ReviewContextStrip';
import { PublishBar } from '../components/review/PublishBar';
import { HeadAdvancedBanner } from '../components/review/HeadAdvancedBanner';
import { FindingQueue } from '../components/review/FindingQueue';
import { PublishedHistoryPanel } from '../components/review/PublishedHistoryPanel';
import { DiffViewer } from '../components/DiffViewer';
import type { DiffFileListHandle } from '../components/DiffFileList';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

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

  const handleSelectFinding = useCallback((comment: InlineCommentDTO) => {
    setSelectedFindingId(comment.id);
    setSelectedPath(comment.file_path);
    diffListRef.current?.revealLineInFile(comment.file_path, comment.line, comment.side);
  }, []);

  const handleJumpToFindingCode = useCallback((comment: InlineCommentDTO) => {
    setSelectedPath(comment.file_path);
    diffListRef.current?.revealLineInFile(comment.file_path, comment.line, comment.side);
  }, []);

  if (error) return <div className="p-4 text-red-500 md:p-6">{error}</div>;
  if (!detail) return <div className="p-4 text-sm text-muted-foreground md:p-6">Loading…</div>;

  const comments = detail.comments;
  const draftCount = comments.filter((c) => c.status === 'draft').length;
  const acceptedCount = comments.filter((c) => c.status === 'accepted').length;
  const staleCount = comments.filter((c) => c.status === 'stale').length;

  const isRunning =
    detail.latest_run?.status === 'running' || detail.all_runs.some((r) => r.status === 'running');

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
      />

      <PublishedHistoryPanel history={detail.published_history} />

      {walkthrough ? <WalkthroughPanel walkthrough={walkthrough} /> : null}

      <ReviewContextStrip groups={orderedGroups} selectedPath={selectedPath} />

      <div className="flex min-h-0 flex-1">
        <aside
          data-testid="finding-queue-pane"
          className="glass-chrome flex w-full max-w-md shrink-0 flex-col overflow-hidden border-r border-glass-edge lg:w-[360px]"
        >
          <FindingQueue
            taskId={id!}
            comments={comments}
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
  );
}
