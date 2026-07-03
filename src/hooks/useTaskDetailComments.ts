import { useCallback } from 'react';
import { toast } from 'sonner';
import { useReviewQueue } from '@/hooks/useReviewQueue';
import { useTaskComments } from '@/hooks/useTaskComments';

export interface UseTaskDetailCommentsOptions {
  taskId: string;
}

export function useTaskDetailComments({ taskId }: UseTaskDetailCommentsOptions) {
  const reviewQueue = useReviewQueue(taskId);

  const handleQueueDraft = useCallback(
    (draft: {
      filePath: string;
      line: number;
      side: 'old' | 'new';
      body: string;
      lineText: string;
    }) => {
      reviewQueue.add({
        filePath: draft.filePath,
        line: draft.line,
        lineText: draft.lineText,
        body: draft.body,
      });
    },
    [reviewQueue],
  );

  const taskComments = useTaskComments(taskId, {
    onError: (msg) => toast.error(msg),
    onQueueDraft: handleQueueDraft,
  });

  return { reviewQueue, taskComments };
}
