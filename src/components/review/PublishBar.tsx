import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { reviewApi, type PublishedReviewVerdict } from '@/lib/api/reviewApi';
import { taskApi } from '@/lib/api/taskApi';
import { displayReviewTitle } from '@/lib/review-display';
import { DIFF_REVIEW_BADGE } from '@/lib/design-tokens';
import { cn } from '@/lib/utils';
import { ConfirmDeleteReviewDialog } from './ConfirmDeleteReviewDialog';
import { ReviewProgressBar } from './ReviewProgressBar';

interface PublishBarProps {
  taskId: string;
  prTitle: string;
  prNumber: number;
  prUrl?: string | null;
  acceptedCount: number;
  draftCount: number;
  staleCount: number;
  reviewedDone: number;
  reviewedTotal: number;
  isRunning: boolean;
  onPublished: () => void;
  onReRun: () => void;
  onDeleted?: () => void;
}

const VERDICT_OPTIONS: Array<{ value: PublishedReviewVerdict; label: string }> = [
  { value: 'COMMENT', label: 'Comment' },
  { value: 'APPROVE', label: 'Approve' },
  { value: 'REQUEST_CHANGES', label: 'Request changes' },
];

export function PublishBar({
  taskId,
  prTitle,
  prNumber,
  prUrl,
  acceptedCount,
  draftCount,
  staleCount,
  reviewedDone,
  reviewedTotal,
  isRunning,
  onPublished,
  onReRun,
  onDeleted,
}: PublishBarProps) {
  const [verdict, setVerdict] = useState<PublishedReviewVerdict>('COMMENT');
  const [summary, setSummary] = useState('');
  const [showSummary, setShowSummary] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [reRunning, setReRunning] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const title = displayReviewTitle(prTitle);

  async function handlePublish() {
    if (acceptedCount === 0) return;
    setPublishing(true);
    try {
      await reviewApi.publishReview(taskId, {
        verdict,
        ...(summary.trim() ? { body: summary.trim() } : {}),
      });
      toast.success('Review published to GitHub');
      onPublished();
    } catch (e) {
      toast.error(`Publish failed: ${(e as Error).message}`);
    } finally {
      setPublishing(false);
    }
  }

  async function handleReRun() {
    setReRunning(true);
    try {
      await reviewApi.requestReReview(taskId);
      toast.success('Re-review started');
      onReRun();
    } catch (e) {
      toast.error(`Re-run failed: ${(e as Error).message}`);
    } finally {
      setReRunning(false);
    }
  }

  async function handleDelete() {
    try {
      await taskApi.deleteTask(taskId);
      toast.success('Review deleted');
      onDeleted?.();
    } catch (e) {
      toast.error(`Delete failed: ${(e as Error).message}`);
      throw e;
    }
  }

  return (
    <div className="sticky top-0 z-10 border-b border-glass-edge bg-glass-l2 backdrop-blur-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 sm:px-6">
        <div className="flex min-w-0 flex-1 basis-[min(100%,280px)] items-center gap-2">
          <span className="truncate text-sm font-semibold" title={title}>
            {title}
          </span>
          {prNumber != null && (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">#{prNumber}</span>
          )}
          {prUrl && (
            <a
              href={prUrl}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 text-xs text-primary hover:underline"
            >
              GitHub
            </a>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          {acceptedCount > 0 && (
            <span className={cn(DIFF_REVIEW_BADGE)}>{acceptedCount} accepted</span>
          )}
          {draftCount > 0 && (
            <span className="inline-flex items-center rounded-md border border-glass-edge bg-glass-l1 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
              {draftCount} drafts
            </span>
          )}
          {staleCount > 0 && (
            <span className="inline-flex items-center rounded-md border border-warning/40 bg-warning/15 px-2 py-0.5 font-mono text-[11px] text-warning">
              {staleCount} stale
            </span>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            data-testid="publish-summary-toggle"
            onClick={() => setShowSummary((v) => !v)}
          >
            {showSummary ? 'Hide summary' : 'Add summary'}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={handleReRun}
            disabled={isRunning || reRunning}
          >
            {reRunning ? 'Starting…' : isRunning ? 'Running…' : 'Re-run review'}
          </Button>

          <select
            value={verdict}
            onChange={(e) => setVerdict(e.target.value as PublishedReviewVerdict)}
            className="h-8 rounded-lg border border-glass-edge bg-glass-l1 px-2 text-xs text-foreground outline-none focus:border-ring"
            aria-label="Review verdict"
          >
            {VERDICT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <Button size="sm" onClick={handlePublish} disabled={acceptedCount === 0 || publishing}>
            {publishing ? 'Publishing…' : 'Publish review'}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            data-testid="review-delete-btn"
            onClick={() => setDeleteOpen(true)}
          >
            Delete
          </Button>
        </div>
      </div>

      {showSummary ? (
        <div className="border-t border-glass-edge/50 px-4 py-2 sm:px-6">
          <Textarea
            data-testid="publish-summary-input"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="Optional review summary for GitHub…"
            rows={2}
            className="text-sm"
          />
        </div>
      ) : null}

      <ConfirmDeleteReviewDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        reviewLabel={title}
        onConfirm={handleDelete}
      />

      {reviewedTotal > 0 && (
        <div
          className="flex items-center gap-3 border-t border-glass-edge/50 px-4 pb-2 pt-1.5 sm:px-6"
          data-testid="pr-review-progress"
        >
          <ReviewProgressBar
            done={reviewedDone}
            total={reviewedTotal}
            className="max-w-xs flex-1"
          />
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            {reviewedDone}/{reviewedTotal} files reviewed
          </span>
        </div>
      )}
    </div>
  );
}
