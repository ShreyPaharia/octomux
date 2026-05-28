import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { api } from '../../lib/api';
import { subscribe } from '../../lib/event-source';

interface HeadAdvancedBannerProps {
  taskId: string;
  currentSha: string;
  onRefresh: () => void;
}

export function HeadAdvancedBanner({ taskId, currentSha, onRefresh }: HeadAdvancedBannerProps) {
  const [newSha, setNewSha] = useState<string | null>(null);
  const [reRunning, setReRunning] = useState(false);

  useEffect(() => {
    return subscribe((event) => {
      const e = event as {
        type: string;
        payload: { taskId?: string; newHeadSha?: string; reviewRunId?: string };
      };
      if (!e.payload.taskId || e.payload.taskId !== taskId) return;
      if (e.type === 'review:head-advanced' && e.payload.newHeadSha) {
        setNewSha(e.payload.newHeadSha);
      }
      if (e.type === 'review:drafts-ready') {
        setNewSha(null);
        onRefresh();
      }
    });
  }, [taskId, onRefresh]);

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
      await api.requestReReview(taskId);
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
