import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { api, type PublishedReviewVerdict } from '../../lib/api';
import { displayReviewTitle } from '@/lib/review-display';
import { DIFF_REVIEW_BADGE } from '@/lib/design-tokens';
import { cn } from '@/lib/utils';
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
  totalCommentsCount: number;
  showCommentsPanel: boolean;
  onToggleCommentsPanel: () => void;
  isRunning: boolean;
  onPublished: () => void;
  onReRun: () => void;
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
  totalCommentsCount,
  showCommentsPanel,
  onToggleCommentsPanel,
  isRunning,
  onPublished,
  onReRun,
}: PublishBarProps) {
  const [verdict, setVerdict] = useState<PublishedReviewVerdict>('COMMENT');
  const [publishing, setPublishing] = useState(false);
  const [reRunning, setReRunning] = useState(false);

  const title = displayReviewTitle(prTitle);

  async function handlePublish() {
    if (acceptedCount === 0) return;
    setPublishing(true);
    try {
      await api.publishReview(taskId, { verdict });
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
      await api.requestReReview(taskId);
      toast.success('Re-review started');
      onReRun();
    } catch (e) {
      toast.error(`Re-run failed: ${(e as Error).message}`);
    } finally {
      setReRunning(false);
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
            data-testid="comments-toggle"
            data-active={showCommentsPanel ? 'true' : undefined}
            className={
              showCommentsPanel ? 'border-primary/40 bg-primary/15 text-primary' : undefined
            }
            onClick={onToggleCommentsPanel}
          >
            Comments ({totalCommentsCount})
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
        </div>
      </div>

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
