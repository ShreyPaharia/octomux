import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { reviewApi } from '@/lib/api/reviewApi';
import { useServerEvents } from '../../lib/use-server-events';

interface HeadAdvancedBannerProps {
  taskId: string;
  currentSha: string;
  onRefresh: () => void;
}

export function HeadAdvancedBanner({ taskId, currentSha, onRefresh }: HeadAdvancedBannerProps) {
  const [newSha, setNewSha] = useState<string | null>(null);
  const [reRunning, setReRunning] = useState(false);

  useServerEvents(
    (event) => {
      if (event.type === 'review:head-advanced' && event.payload.newHeadSha) {
        setNewSha(event.payload.newHeadSha);
      } else if (event.type === 'review:drafts-ready') {
        setNewSha(null);
        onRefresh();
      }
    },
    (event) => event.payload.taskId === taskId,
  );

  // Dismiss if current SHA matches new SHA (refreshed externally)
  useEffect(() => {
    if (newSha && newSha === currentSha) {
      setNewSha(null);
    }
  }, [newSha, currentSha]);

  if (!newSha) return null;

  async function handleReRun() {
    setReRunning(true);
    try {
      await reviewApi.requestReReview(taskId);
      toast.success('Incremental re-review started');
    } catch (e) {
      toast.error(`Re-run failed: ${(e as Error).message}`);
    } finally {
      setReRunning(false);
    }
  }

  return (
    <div className="flex items-center gap-3 bg-yellow-900/30 border-b border-yellow-600 px-6 py-2 text-sm text-yellow-300">
      <span>
        PR head advanced to <code className="font-mono text-xs">{newSha.slice(0, 8)}</code>
      </span>
      <Button
        variant="outline"
        size="xs"
        onClick={handleReRun}
        disabled={reRunning}
        className="border-yellow-600 text-yellow-300 hover:bg-yellow-900/50"
      >
        {reRunning ? 'Starting…' : 'Re-run incremental review'}
      </Button>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => setNewSha(null)}
        className="ml-auto text-yellow-400"
      >
        Dismiss
      </Button>
    </div>
  );
}
