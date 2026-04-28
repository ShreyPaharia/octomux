import { useCallback, useEffect, useState } from 'react';

export interface QueuedComment {
  id: string;
  filePath: string;
  line: number;
  lineText: string;
  body: string;
}

const KEY_PREFIX = 'octomux:review-queue:';

function load(taskId: string): QueuedComment[] {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + taskId);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function save(taskId: string, comments: QueuedComment[]): void {
  try {
    localStorage.setItem(KEY_PREFIX + taskId, JSON.stringify(comments));
  } catch {
    // localStorage full or disabled — silently drop persistence
  }
}

export function useReviewQueue(taskId: string) {
  const [comments, setComments] = useState<QueuedComment[]>(() => load(taskId));

  useEffect(() => {
    setComments(load(taskId));
  }, [taskId]);

  useEffect(() => {
    save(taskId, comments);
  }, [taskId, comments]);

  const add = useCallback((draft: Omit<QueuedComment, 'id'>) => {
    setComments((prev) => [
      ...prev,
      { ...draft, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
    ]);
  }, []);

  const remove = useCallback((id: string) => {
    setComments((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const clear = useCallback(() => setComments([]), []);

  const format = useCallback((): string => {
    if (comments.length === 0) return '';
    const lines = [`Review feedback (${comments.length} comments):`, ''];
    for (const c of comments) {
      lines.push(`${c.filePath}:${c.line}`);
      if (c.lineText) lines.push(c.lineText);
      lines.push(c.body);
      lines.push('');
    }
    return lines.join('\n').trim();
  }, [comments]);

  return { comments, add, remove, clear, format };
}
