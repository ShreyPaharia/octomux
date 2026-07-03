import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import type { DiffFileListHandle } from '@/components/DiffFileList';
import { useDiffKeyboardNav } from '@/hooks/useDiffKeyboardNav';
import {
  diffRangeToParam,
  taskApi,
  type DiffRange,
  type DiffSummaryResponse,
} from '@/lib/api/taskApi';

export interface UseDiffStateOptions {
  taskId: string;
  isDiffMode: boolean;
  activeAgentId: string | null;
  reviewQueue: {
    comments: { id: string; filePath: string; line: number; body: string }[];
    format: () => string;
    remove: (id: string) => void;
  };
  taskComments: {
    post: (input: {
      file_path: string;
      line: number;
      side: 'new';
      body: string;
    }) => Promise<unknown>;
    setFocusedId: (id: string | null) => void;
  };
  refresh: () => void;
}

export interface UseDiffStateResult {
  range: DiffRange;
  setRange: (next: DiffRange) => void;
  diffSummary: DiffSummaryResponse | null;
  setDiffSummary: React.Dispatch<React.SetStateAction<DiffSummaryResponse | null>>;
  activeFilePath: string | null;
  setActiveFilePath: React.Dispatch<React.SetStateAction<string | null>>;
  filesInDiff: string[];
  setFilesInDiff: React.Dispatch<React.SetStateAction<string[]>>;
  filesInDiffSet: Set<string>;
  visibleFiles: NonNullable<DiffSummaryResponse['files']>;
  currentRangeLabel: string;
  diffListRef: React.RefObject<DiffFileListHandle | null>;
  refetchDiff: () => Promise<void>;
  handleBaseChange: (newBaseBranch: string) => Promise<void>;
  handleToggleReviewed: (filePath: string, currentlyReviewed: boolean) => Promise<void>;
  handleJumpToComment: (
    filePath: string,
    line: number,
    side: 'old' | 'new',
    commentId: string,
  ) => void;
  jumpToNextUnreviewed: () => void;
  handleSendBatch: () => Promise<void>;
}

export function useDiffState({
  taskId,
  isDiffMode,
  activeAgentId,
  reviewQueue,
  taskComments,
  refresh,
}: UseDiffStateOptions): UseDiffStateResult {
  const [searchParams, setSearchParams] = useSearchParams();
  const [diffSummary, setDiffSummary] = useState<DiffSummaryResponse | null>(null);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [filesInDiff, setFilesInDiff] = useState<string[]>([]);
  const diffListRef = useRef<DiffFileListHandle | null>(null);
  const focusClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const range = useMemo<DiffRange>(() => {
    const raw = searchParams.get('range');
    if (!raw || raw === 'base') return { kind: 'base' };
    if (raw === 'working') return { kind: 'working' };
    if (raw.startsWith('commit:')) {
      const sha = raw.slice('commit:'.length);
      if (/^[0-9a-f]{4,40}$/i.test(sha)) return { kind: 'commit', sha };
    }
    if (raw.startsWith('range:')) {
      const rest = raw.slice('range:'.length);
      const idx = rest.indexOf('..');
      if (idx > 0) {
        const from = rest.slice(0, idx);
        const to = rest.slice(idx + 2);
        if (from && to) return { kind: 'range', from, to };
      }
    }
    return { kind: 'base' };
  }, [searchParams]);

  const setRange = useCallback(
    (next: DiffRange) => {
      setSearchParams(
        (prev) => {
          const sp = new URLSearchParams(prev);
          const param = diffRangeToParam(next);
          if (param) sp.set('range', param);
          else sp.delete('range');
          return sp;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  useEffect(
    () => () => {
      if (focusClearTimer.current) clearTimeout(focusClearTimer.current);
    },
    [],
  );

  const filesInDiffSet = useMemo(() => new Set(filesInDiff), [filesInDiff]);

  const handleJumpToComment = useCallback(
    (filePath: string, line: number, side: 'old' | 'new', commentId: string) => {
      diffListRef.current?.revealLineInFile(filePath, line, side);
      taskComments.setFocusedId(commentId);
      if (focusClearTimer.current) clearTimeout(focusClearTimer.current);
      focusClearTimer.current = setTimeout(() => {
        taskComments.setFocusedId(null);
      }, 1200);
    },
    [taskComments],
  );

  const visibleFiles = useMemo(
    () => (diffSummary?.files ?? []).filter((f) => !f.ignored),
    [diffSummary],
  );

  const refetchDiff = useCallback(async () => {
    if (!taskId) return;
    try {
      const s = await taskApi.getTaskDiffSummary(taskId, range);
      setDiffSummary(s);
    } catch {
      // swallow — banner is best-effort, DiffViewer surfaces its own errors
    }
  }, [taskId, range]);

  const handleBaseChange = useCallback(
    async (newBaseBranch: string) => {
      if (!taskId) return;
      await taskApi.updateTaskBase(taskId, newBaseBranch);
      setRange({ kind: 'base' });
      await refetchDiff();
      refresh();
    },
    [taskId, refetchDiff, refresh, setRange],
  );

  const currentRangeLabel = useMemo(() => {
    switch (range.kind) {
      case 'base':
        return 'full diff';
      case 'working':
        return 'working tree';
      case 'commit':
        return `commit ${range.sha.slice(0, 7)}`;
      case 'range':
        return `${range.from.slice(0, 7)}..${range.to.slice(0, 7)}`;
    }
  }, [range]);

  const handleToggleReviewed = useCallback(
    async (filePath: string, currentlyReviewed: boolean) => {
      if (!taskId) return;
      try {
        if (currentlyReviewed) await taskApi.unmarkReviewed(taskId, filePath);
        else await taskApi.markReviewed(taskId, filePath);
        await refetchDiff();
      } catch (err) {
        console.error('Failed to toggle reviewed:', err);
      }
    },
    [taskId, refetchDiff],
  );

  const handleSendBatch = useCallback(async () => {
    if (!taskId || !activeAgentId || reviewQueue.comments.length === 0) return;
    const body = reviewQueue.format();
    const drafts = reviewQueue.comments;

    const failed: string[] = [];
    await Promise.all(
      drafts.map(async (d) => {
        const row = await taskComments.post({
          file_path: d.filePath,
          line: d.line,
          side: 'new',
          body: d.body,
        });
        if (row) reviewQueue.remove(d.id);
        else failed.push(d.id);
      }),
    );
    if (failed.length > 0) {
      toast.error(`Failed to save ${failed.length} of ${drafts.length} comments`);
      return;
    }

    try {
      await taskApi.sendAgentMessage(taskId, activeAgentId, body);
    } catch (err) {
      console.error('Failed to send review batch:', err);
      toast.error((err as Error).message);
    }
  }, [taskId, activeAgentId, reviewQueue, taskComments]);

  const moveActiveFile = useCallback(
    (delta: 1 | -1) => {
      if (visibleFiles.length === 0) return;
      const idx = activeFilePath ? visibleFiles.findIndex((f) => f.path === activeFilePath) : -1;
      const next = (idx + delta + visibleFiles.length) % visibleFiles.length;
      setActiveFilePath(visibleFiles[next].path);
    },
    [visibleFiles, activeFilePath],
  );

  const jumpToNextUnreviewed = useCallback(() => {
    if (visibleFiles.length === 0) return;
    const startIdx = activeFilePath ? visibleFiles.findIndex((f) => f.path === activeFilePath) : -1;
    for (let i = 1; i <= visibleFiles.length; i++) {
      const candidate = visibleFiles[(startIdx + i) % visibleFiles.length];
      if (!candidate.reviewed) {
        setActiveFilePath(candidate.path);
        return;
      }
    }
  }, [visibleFiles, activeFilePath]);

  useDiffKeyboardNav({
    onNextFile: isDiffMode ? () => moveActiveFile(1) : undefined,
    onPrevFile: isDiffMode ? () => moveActiveFile(-1) : undefined,
    onToggleReviewed: isDiffMode
      ? () => {
          if (!activeFilePath) return;
          const file = visibleFiles.find((f) => f.path === activeFilePath);
          if (!file) return;
          handleToggleReviewed(activeFilePath, !!file.reviewed);
        }
      : undefined,
    onJumpToNextUnreviewed: isDiffMode ? jumpToNextUnreviewed : undefined,
    onSendBatch: isDiffMode ? handleSendBatch : undefined,
  });

  return {
    range,
    setRange,
    diffSummary,
    setDiffSummary,
    activeFilePath,
    setActiveFilePath,
    filesInDiff,
    setFilesInDiff,
    filesInDiffSet,
    visibleFiles,
    currentRangeLabel,
    diffListRef,
    refetchDiff,
    handleBaseChange,
    handleToggleReviewed,
    handleJumpToComment,
    jumpToNextUnreviewed,
    handleSendBatch,
  };
}
