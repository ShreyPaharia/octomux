import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  api,
  type InlineCommentRow,
  type InlineCommentWithOutdated,
  type PostCommentInput,
  type UpdateCommentInput,
} from '@/lib/api';

export interface OpenComposer {
  filePath: string;
  line: number;
  side: 'old' | 'new';
}

export interface QueueDraftInput {
  filePath: string;
  line: number;
  side: 'old' | 'new';
  body: string;
  lineText: string;
}

export interface TaskCommentsState {
  byId: Map<string, InlineCommentWithOutdated>;
  byFile: (path: string) => InlineCommentWithOutdated[];
  byFileLineSide: (path: string, line: number, side: 'old' | 'new') => InlineCommentWithOutdated[];
  outdatedUnavailable: boolean;
  loading: boolean;
  error: string | null;
  openComposer: OpenComposer | null;
  setOpenComposer: (next: OpenComposer | null) => void;
  focusedId: string | null;
  setFocusedId: (id: string | null) => void;
  refetch: () => Promise<void>;
  post: (input: PostCommentInput) => Promise<InlineCommentRow | null>;
  update: (commentId: string, patch: UpdateCommentInput) => Promise<InlineCommentRow | null>;
  remove: (commentId: string) => Promise<boolean>;
  /** Pushes a draft into the parent's review queue (set up by TaskDetail). */
  queueDraft: (draft: QueueDraftInput) => void;
}

function tempId(): string {
  return `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function indexBy(rows: InlineCommentWithOutdated[]): Map<string, InlineCommentWithOutdated> {
  const m = new Map<string, InlineCommentWithOutdated>();
  for (const r of rows) m.set(r.id, r);
  return m;
}

export function useTaskComments(
  taskId: string | undefined,
  opts?: { onError?: (msg: string) => void; onQueueDraft?: (draft: QueueDraftInput) => void },
): TaskCommentsState {
  const [byId, setById] = useState<Map<string, InlineCommentWithOutdated>>(() => new Map());
  const [outdatedUnavailable, setOutdatedUnavailable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openComposer, setOpenComposer] = useState<OpenComposer | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const byIdRef = useRef(byId);
  byIdRef.current = byId;

  const onErrorRef = useRef(opts?.onError);
  onErrorRef.current = opts?.onError;

  const onQueueDraftRef = useRef(opts?.onQueueDraft);
  onQueueDraftRef.current = opts?.onQueueDraft;

  const queueDraft = useCallback((draft: QueueDraftInput) => {
    onQueueDraftRef.current?.(draft);
  }, []);

  const reportError = useCallback((msg: string) => {
    setError(msg);
    onErrorRef.current?.(msg);
  }, []);

  const refetch = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    try {
      const res = await api.listComments(taskId);
      setById(indexBy(res.comments));
      setOutdatedUnavailable(!!res.outdated_unavailable);
      setError(null);
    } catch (err) {
      reportError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [taskId, reportError]);

  useEffect(() => {
    if (!taskId) {
      setById(new Map());
      setOutdatedUnavailable(false);
      return;
    }
    refetch();
  }, [taskId, refetch]);

  const byFile = useCallback(
    (path: string) => {
      const out: InlineCommentWithOutdated[] = [];
      for (const c of byId.values()) {
        if (c.file_path === path) out.push(c);
      }
      out.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      return out;
    },
    [byId],
  );

  const byFileLineSide = useCallback(
    (path: string, line: number, side: 'old' | 'new') => {
      const out: InlineCommentWithOutdated[] = [];
      for (const c of byId.values()) {
        if (c.file_path === path && c.line === line && c.side === side) out.push(c);
      }
      out.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      return out;
    },
    [byId],
  );

  const post = useCallback(
    async (input: PostCommentInput): Promise<InlineCommentRow | null> => {
      if (!taskId) return null;
      const tmp: InlineCommentWithOutdated = {
        id: tempId(),
        task_id: taskId,
        agent_id: input.agent_id ?? null,
        file_path: input.file_path,
        line: input.line,
        side: input.side,
        original_commit_sha: input.anchor_commit_sha ?? '',
        body: input.body,
        created_at: new Date().toISOString().replace('T', ' ').replace(/\..+$/, ''),
        resolved_at: null,
        outdated: false,
      };
      setById((prev) => {
        const next = new Map(prev);
        next.set(tmp.id, tmp);
        return next;
      });
      try {
        const row = await api.postComment(taskId, input);
        setById((prev) => {
          const next = new Map(prev);
          next.delete(tmp.id);
          next.set(row.id, { ...row, outdated: false });
          return next;
        });
        return row;
      } catch (err) {
        setById((prev) => {
          if (!prev.has(tmp.id)) return prev;
          const next = new Map(prev);
          next.delete(tmp.id);
          return next;
        });
        reportError((err as Error).message);
        return null;
      }
    },
    [taskId, reportError],
  );

  const update = useCallback(
    async (commentId: string, patch: UpdateCommentInput): Promise<InlineCommentRow | null> => {
      if (!taskId) return null;
      const original = byIdRef.current.get(commentId);
      if (!original) return null;
      const optimistic: InlineCommentWithOutdated = {
        ...original,
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.resolved !== undefined
          ? { resolved_at: patch.resolved ? new Date().toISOString() : null }
          : {}),
      };
      setById((prev) => {
        if (!prev.has(commentId)) return prev;
        const next = new Map(prev);
        next.set(commentId, optimistic);
        return next;
      });
      try {
        const row = await api.updateComment(taskId, commentId, patch);
        setById((prev) => {
          const cur = prev.get(commentId);
          if (!cur) return prev;
          const next = new Map(prev);
          next.set(row.id, { ...row, outdated: cur.outdated });
          return next;
        });
        return row;
      } catch (err) {
        setById((prev) => {
          const next = new Map(prev);
          next.set(commentId, original);
          return next;
        });
        reportError((err as Error).message);
        return null;
      }
    },
    [taskId, reportError],
  );

  const remove = useCallback(
    async (commentId: string): Promise<boolean> => {
      if (!taskId) return false;
      const original = byIdRef.current.get(commentId);
      if (!original) return false;
      setById((prev) => {
        if (!prev.has(commentId)) return prev;
        const next = new Map(prev);
        next.delete(commentId);
        return next;
      });
      try {
        await api.deleteComment(taskId, commentId);
        return true;
      } catch (err) {
        setById((prev) => {
          const next = new Map(prev);
          next.set(commentId, original);
          return next;
        });
        reportError((err as Error).message);
        return false;
      }
    },
    [taskId, reportError],
  );

  return {
    byId,
    byFile,
    byFileLineSide,
    outdatedUnavailable,
    loading,
    error,
    openComposer,
    setOpenComposer,
    focusedId,
    setFocusedId,
    refetch,
    post,
    update,
    remove,
    queueDraft,
  };
}

export const TaskCommentsContext = createContext<TaskCommentsState | null>(null);

export function useTaskCommentsContext(): TaskCommentsState {
  const ctx = useContext(TaskCommentsContext);
  if (!ctx) {
    throw new Error('useTaskCommentsContext must be used inside <TaskCommentsContext.Provider>');
  }
  return ctx;
}
