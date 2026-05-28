import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { api, type PublishedReviewVerdict } from '../../lib/api';

interface PublishBarProps {
  taskId: string;
  acceptedCount: number;
  draftCount: number;
  staleCount: number;
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
  acceptedCount,
  draftCount,
  staleCount,
  isRunning,
  onPublished,
  onReRun,
}: PublishBarProps) {
  const [verdict, setVerdict] = useState<PublishedReviewVerdict>('COMMENT');
  const [publishing, setPublishing] = useState(false);
  const [reRunning, setReRunning] = useState(false);

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
    <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-glass-edge bg-glass-l2 px-6 py-2 backdrop-blur-sm">
      {/* Counts */}
      <span className="text-xs text-muted-foreground">
        {acceptedCount} accepted · {draftCount} drafts{staleCount > 0 && ` · ${staleCount} stale`}
      </span>

      <div className="ml-auto flex items-center gap-2">
        {/* Re-run button */}
        <Button variant="outline" size="sm" onClick={handleReRun} disabled={isRunning || reRunning}>
          {reRunning ? 'Starting…' : isRunning ? 'Running…' : 'Re-run review'}
        </Button>

        {/* Verdict select */}
        <select
          value={verdict}
          onChange={(e) => setVerdict(e.target.value as PublishedReviewVerdict)}
          className="h-7 rounded-md border border-glass-edge bg-glass-l1 px-2 text-xs text-foreground outline-none focus:border-ring"
          aria-label="Review verdict"
        >
          {VERDICT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        {/* Publish button */}
        <Button size="sm" onClick={handlePublish} disabled={acceptedCount === 0 || publishing}>
          {publishing ? 'Publishing…' : 'Publish review'}
        </Button>
      </div>
    </div>
  );
}
