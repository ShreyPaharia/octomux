import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/StatusBadge';
import { TerminalView } from '@/components/TerminalView';
import { AgentTabs } from '@/components/AgentTabs';
import { DiffViewer } from '@/components/DiffViewer';
import { DraftEditForm } from '@/components/DraftEditForm';
import { EmptyState } from '@/components/EmptyState';
import { MoveAgentDialog } from '@/components/MoveAgentDialog';
import { TaskSettingUpView } from '@/components/TaskSettingUpView';
import { TaskErrorView } from '@/components/TaskErrorView';
import { ReviewBaseRefBanner } from '@/components/ReviewBaseRefBanner';
import { DiffRangePicker } from '@/components/DiffRangePicker';
import { CommentQueueDrawer } from '@/components/CommentQueueDrawer';
import { CommentsSidePanel } from '@/components/CommentsSidePanel';
import type { DiffFileListHandle } from '@/components/DiffFileList';
import { useReviewQueue } from '@/hooks/useReviewQueue';
import { useTaskComments, TaskCommentsContext } from '@/hooks/useTaskComments';
import { DIFF_KEYBINDS, useDiffKeyboardNav } from '@/hooks/useDiffKeyboardNav';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

import { useTask } from '@/lib/hooks';
import { api, diffRangeToParam, type DiffRange, type DiffSummaryResponse } from '@/lib/api';
import { repoName } from '@/lib/utils';
import { PullRequestIcon, TerminalRectIcon } from '@/components/icons';
import { TaskActivityPanel } from '@/components/TaskActivityPanel';
import { TaskRefsPanel } from '@/components/TaskRefsPanel';
import { TaskHooksPanel } from '@/components/TaskHooksPanel';
import { JiraLinkHelper } from '@/components/integrations/JiraLinkHelper';
import type { RunMode } from '../../server/types';

export const SHIP_EVENT = 'octomux:open-pr-sheet';

const MODE_LABEL: Record<RunMode, string> = {
  new: 'N',
  existing: 'E',
  none: 'Ø',
  scratch: 'S',
};

const MODE_TOOLTIP: Record<RunMode, string> = {
  new: 'new worktree',
  existing: 'attached existing',
  none: 'in-place (no worktree)',
  scratch: 'scratch',
};

type TaskMode = 'agents' | 'editor' | 'diff' | 'info';

// Per-task UI state preserved across task switches (session-only, not persisted to disk).
interface PerTaskUiState {
  activeWindow: number | null;
  mode: TaskMode;
}
const perTaskUiState = new Map<string, PerTaskUiState>();

/** Reset per-task UI state — exposed for tests only. */
export function _resetPerTaskUiState() {
  perTaskUiState.clear();
}

/** Floating "?" chip that surfaces the diff keybind cheat sheet in a popover. */
function DiffKeybindCheatSheet() {
  return (
    <div className="pointer-events-none absolute bottom-3 right-3">
      <Popover>
        <PopoverTrigger
          aria-label="Show diff keyboard shortcuts"
          data-testid="diff-keybind-help"
          className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-full border border-glass-edge bg-glass-l1 text-xs text-muted-foreground hover:text-foreground"
        >
          ?
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Diff shortcuts
          </div>
          <ul className="mt-2 space-y-1">
            {DIFF_KEYBINDS.map((b) => (
              <li key={b.keys} className="flex items-center justify-between gap-3 text-xs">
                <kbd className="rounded border border-glass-edge bg-glass-l1 px-1.5 py-0.5 font-mono text-[10px]">
                  {b.keys}
                </kbd>
                <span className="text-muted-foreground">{b.description}</span>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const taskId = id ?? '';
  const { task, loading, error, refresh } = useTask(taskId);
  const [activeWindow, setActiveWindow] = useState<number | null>(null);

  const [resuming, setResuming] = useState(false);
  const [mode, setMode] = useState<TaskMode>('agents');
  const [creatingEditor, setCreatingEditor] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const agentParam = searchParams.get('agent');

  // ─── Diff range URL state ──────────────────────────────────────────────────
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

  // Local override for user_window_index so we can set it immediately from
  // the createUserTerminal API response instead of waiting for the next poll.
  const [localUserWindowIndex, setLocalUserWindowIndex] = useState<number | null>(null);
  // Derive userWindowIndex — prefer server-persisted data, fall back to local override.
  const userWindowIndex = task?.user_window_index ?? localUserWindowIndex;

  // --- Per-task state save/restore on task switch ---
  // Refs let the switch effect read current values without depending on them,
  // so it only fires when taskId actually changes.
  const prevTaskIdRef = useRef<string>(taskId);
  const activeWindowRef = useRef(activeWindow);
  const modeRef = useRef(mode);
  activeWindowRef.current = activeWindow;
  modeRef.current = mode;

  useEffect(() => {
    const prevId = prevTaskIdRef.current;
    if (prevId !== taskId) {
      // Save outgoing task state
      perTaskUiState.set(prevId, {
        activeWindow: activeWindowRef.current,
        mode: modeRef.current,
      });
      // Restore incoming task state (or reset to defaults)
      const saved = perTaskUiState.get(taskId);
      setActiveWindow(saved?.activeWindow ?? null);
      setMode(saved?.mode ?? 'agents');
      setLocalUserWindowIndex(null);
      prevTaskIdRef.current = taskId;
    }
  }, [taskId]);

  // Keep the map in sync as user interacts
  useEffect(() => {
    if (taskId) {
      perTaskUiState.set(taskId, { activeWindow, mode });
    }
  }, [taskId, activeWindow, mode]);

  // Initialize activeWindow from URL ?agent= param or first agent's window_index
  const firstAgentWindow = task?.agents?.[0]?.window_index ?? null;
  useEffect(() => {
    if (agentParam && task?.agents) {
      const agent = task.agents.find((a) => a.id === agentParam);
      if (agent) {
        setActiveWindow(agent.window_index);
        return;
      }
    }
    if (activeWindow === null && firstAgentWindow !== null) {
      setActiveWindow(firstAgentWindow);
    }
  }, [firstAgentWindow, activeWindow, agentParam, task?.agents]);

  // Mark the task as viewed once when the page opens for this task id.
  // Fire-and-forget — no loading state, no error toast.
  useEffect(() => {
    if (!taskId) return;
    api.markTaskViewed(taskId).catch((err) => {
      console.warn('Failed to mark task viewed:', err);
    });
  }, [taskId]);

  // Auto-switch back to agents when task enters non-running state.
  // Diff mode is allowed to persist so users can keep reviewing a closed task's diff.
  useEffect(() => {
    if (task && task.runtime_state !== 'running') {
      setMode((m) => (m === 'editor' ? 'agents' : m));
      setLocalUserWindowIndex(null);
    }
  }, [task?.runtime_state]);

  const [movingAgentId, setMovingAgentId] = useState<string | null>(null);
  const [closeConfirm, setCloseConfirm] = useState(false);

  // ─── Review cockpit state ────────────────────────────────────────────────
  const reviewQueue = useReviewQueue(taskId);
  const [diffSummary, setDiffSummary] = useState<DiffSummaryResponse | null>(null);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [filesInDiff, setFilesInDiff] = useState<string[]>([]);
  const [showCommentsPanel, setShowCommentsPanel] = useState(false);
  const diffListRef = useRef<DiffFileListHandle | null>(null);
  const focusClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      const s = await api.getTaskDiffSummary(taskId, range);
      setDiffSummary(s);
    } catch {
      // swallow — banner is best-effort, DiffViewer surfaces its own errors
    }
  }, [taskId, range]);

  const handleBaseChange = useCallback(
    async (newBaseBranch: string) => {
      if (!taskId) return;
      await api.updateTaskBase(taskId, newBaseBranch);
      // Reset range to full diff and refetch summary under the new base.
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
        if (currentlyReviewed) await api.unmarkReviewed(taskId, filePath);
        else await api.markReviewed(taskId, filePath);
        await refetchDiff();
      } catch (err) {
        console.error('Failed to toggle reviewed:', err);
      }
    },
    [taskId, refetchDiff],
  );

  const activeAgentId = useMemo(() => {
    const ags = task?.agents ?? [];
    if (activeWindow !== null) {
      const a = ags.find((x) => x.window_index === activeWindow && x.status !== 'stopped');
      if (a) return a.id;
    }
    return ags.find((x) => x.status !== 'stopped')?.id ?? null;
  }, [task?.agents, activeWindow]);

  const handleSendBatch = useCallback(async () => {
    if (!taskId || !activeAgentId || reviewQueue.comments.length === 0) return;
    const body = reviewQueue.format();
    const drafts = reviewQueue.comments;

    // Persist each queued draft. Failures stay in the queue with a toast so the
    // human can retry; successes are removed.
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
      await api.sendAgentMessage(taskId, activeAgentId, body);
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

  const isDiffMode = mode === 'diff';
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

  const handleShip = useCallback(() => {
    if (!taskId) return;
    // T7 will mount the PR sheet listener. Route stub deferred — event-only for now.
    window.dispatchEvent(new CustomEvent(SHIP_EVENT, { detail: { taskId } }));
  }, [taskId]);

  const handleAddAgent = useCallback(
    async (prompt?: string) => {
      if (!taskId) return;
      try {
        const agent = await api.addAgent(taskId, prompt ? { prompt } : undefined);
        setActiveWindow(agent.window_index);
        refresh();
      } catch (err) {
        console.error('Failed to add agent:', err);
      }
    },
    [taskId, refresh],
  );

  const handleStopAgent = useCallback(
    async (agentId: string) => {
      if (!taskId) return;
      try {
        const taskAgents = task?.agents || [];
        const stoppedAgent = taskAgents.find((a) => a.id === agentId);
        await api.stopAgent(taskId, agentId);
        // If we stopped the active tab, switch to the first remaining running agent
        if (stoppedAgent && stoppedAgent.window_index === activeWindow) {
          const nextAgent = taskAgents.find((a) => a.id !== agentId && a.status !== 'stopped');
          if (nextAgent) setActiveWindow(nextAgent.window_index);
        }
        refresh();
      } catch (err) {
        console.error('Failed to stop agent:', err);
      }
    },
    [taskId, refresh, task, activeWindow],
  );

  const handleClose = useCallback(async () => {
    if (!taskId) return;
    try {
      await api.updateTask(taskId, { status: 'closed' });
      setCloseConfirm(false);
      refresh();
    } catch (err) {
      console.error('Failed to close task:', err);
    }
  }, [taskId, refresh]);

  const handleStart = useCallback(async () => {
    if (!taskId) return;
    try {
      await api.startTask(taskId);
      refresh();
    } catch (err) {
      console.error('Failed to start task:', err);
    }
  }, [taskId, refresh]);

  const handleDelete = useCallback(async () => {
    if (!taskId) return;
    try {
      await api.deleteTask(taskId);
      navigate('/tasks');
    } catch (err) {
      console.error('Failed to delete task:', err);
    }
  }, [taskId, navigate]);

  const handleResume = useCallback(async () => {
    if (!taskId) return;
    setResuming(true);
    try {
      await api.updateTask(taskId, { status: 'running' });
      refresh();
    } catch (err) {
      console.error('Failed to resume task:', err);
    } finally {
      setResuming(false);
    }
  }, [taskId, refresh]);

  const handleAddTerminal = useCallback(async () => {
    if (!taskId) return;
    try {
      const terminal = await api.createTerminal(taskId);
      setActiveWindow(terminal.window_index);
      refresh();
    } catch (err) {
      console.error('Failed to create terminal:', err);
    }
  }, [taskId, refresh]);

  const handleCloseTerminal = useCallback(
    async (terminalId: string) => {
      if (!taskId) return;
      try {
        const terminals = task?.user_terminals || [];
        const closedTerminal = terminals.find((t) => t.id === terminalId);
        await api.closeTerminal(taskId, terminalId);
        // If we closed the active tab, switch to first agent or next terminal
        if (closedTerminal && closedTerminal.window_index === activeWindow) {
          const agents = task?.agents || [];
          const runningAgent = agents.find((a) => a.status !== 'stopped');
          const otherTerminal = terminals.find((t) => t.id !== terminalId);
          setActiveWindow(runningAgent?.window_index ?? otherTerminal?.window_index ?? null);
        }
        refresh();
      } catch (err) {
        console.error('Failed to close terminal:', err);
      }
    },
    [taskId, refresh, task, activeWindow],
  );

  const handleToggleEditor = useCallback(async () => {
    if (mode === 'editor') {
      setMode('agents');
      return;
    }
    if (creatingEditor) return;
    setCreatingEditor(true);
    try {
      const result = await api.createUserTerminal(taskId);
      if (result.editor === 'vscode' || result.editor === 'cursor') {
        // External editor opened — stay on agents view
        setLocalUserWindowIndex(null);
      } else {
        setLocalUserWindowIndex(result.windowIndex);
        setMode('editor');
      }
      refresh();
    } catch (err) {
      console.error('Failed to create user terminal:', err);
    } finally {
      setCreatingEditor(false);
    }
  }, [mode, taskId, creatingEditor, refresh]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Loading...
      </div>
    );
  }

  if (!task) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <p className="text-destructive">{error || 'Task not found'}</p>
        <Button variant="outline" onClick={() => navigate('/tasks')}>
          Back to Tasks
        </Button>
      </div>
    );
  }

  const agents = task.agents || [];
  const isRunning = task.runtime_state === 'running';
  const isDraft = task.runtime_state === 'idle' && !task.initial_prompt;
  const canResume =
    (task.runtime_state === 'idle' || task.runtime_state === 'error') && !!task.worktree;
  const runMode: RunMode = task.run_mode ?? 'new';
  const isScratch = runMode === 'scratch';
  const canShowDiff = !isScratch && task.runtime_state !== 'idle';

  const isTerminalAlive = task.runtime_state === 'running' || task.runtime_state === 'setting_up';
  const hasTerminal =
    !!task.tmux_session && agents.length > 0 && activeWindow !== null && isTerminalAlive;

  return (
    <div className="flex h-full flex-col">
      {/* L1 glass header — 18px vertical / 24px horizontal padding, 17px title */}
      <div
        data-testid="task-detail-header"
        className="bg-glass-l1 glass-blur-l1 flex items-center justify-between gap-3 border-b border-glass-edge px-6 py-[18px]"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <h1
            title={task.title}
            aria-label={task.title}
            className="truncate text-[17px] font-semibold leading-none tracking-tight"
          >
            {task.title}
          </h1>
          <span
            data-testid="mode-badge"
            title={MODE_TOOLTIP[runMode]}
            aria-label={`run mode: ${MODE_TOOLTIP[runMode]}`}
            className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-[#2f2f2f] bg-[#1a1a1a] px-1.5 font-mono text-[10px] font-bold text-[#8a8a8a]"
          >
            {MODE_LABEL[runMode]}
          </span>
          <StatusBadge status={task.derived_status || task.runtime_state} />
        </div>
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          {canResume && (
            <Button variant="default" size="sm" disabled={resuming} onClick={handleResume}>
              {resuming ? '...' : 'Resume'}
            </Button>
          )}

          {canShowDiff && (
            <Button
              size="sm"
              data-testid="ship-button"
              onClick={handleShip}
              className="gap-1.5 border border-[#22C55EAA] bg-[#22C55E1F] text-[#DCFCE7] shadow-[0_0_0_1px_rgba(34,197,94,0.4),0_0_18px_-4px_rgba(34,197,94,0.7)] hover:bg-[#22C55E33] hover:text-white"
            >
              <PullRequestIcon size={14} aria-hidden />
              <span className="font-semibold tracking-wider uppercase">Ship</span>
            </Button>
          )}

          {isRunning && !!task.tmux_session && (
            <Button
              variant="outline"
              size="sm"
              className="border-[#2f2f2f] text-[#8a8a8a]"
              onClick={handleToggleEditor}
            >
              &lt;&gt; EDITOR
            </Button>
          )}
          {canShowDiff && (
            <Button
              variant="outline"
              size="sm"
              data-testid="diff-toggle"
              data-active={mode === 'diff' ? 'true' : undefined}
              className={
                mode === 'diff'
                  ? 'border-[#3B82F666] bg-[#3B82F61F] text-[#3B82F6] hover:bg-[#3B82F633] hover:text-[#3B82F6]'
                  : 'border-[#2f2f2f] text-[#8a8a8a]'
              }
              onClick={() => setMode(mode === 'diff' ? 'agents' : 'diff')}
            >
              DIFF
            </Button>
          )}
          {!isDraft && (
            <Button
              variant="outline"
              size="sm"
              data-testid="info-toggle"
              data-active={mode === 'info' ? 'true' : undefined}
              className={
                mode === 'info'
                  ? 'border-[#3B82F666] bg-[#3B82F61F] text-[#3B82F6] hover:bg-[#3B82F633] hover:text-[#3B82F6]'
                  : 'border-[#2f2f2f] text-[#8a8a8a]'
              }
              onClick={() => setMode(mode === 'info' ? 'agents' : 'info')}
            >
              INFO
            </Button>
          )}
          {isDraft && (
            <Button variant="default" size="sm" onClick={handleStart}>
              Start
            </Button>
          )}
          {isRunning &&
            (closeConfirm ? (
              <div
                role="alertdialog"
                aria-label="Confirm close task"
                data-testid="close-confirm"
                className="bg-glass-l2 glass-blur-l2 flex items-center gap-2 border border-[#EF4444AA] px-2 py-1 text-[11px] text-[#FEE2E2]"
              >
                <span className="font-semibold tracking-wider uppercase">Close task?</span>
                <button
                  className="px-1.5 py-0.5 text-[#b5b5bd] hover:text-white"
                  onClick={() => setCloseConfirm(false)}
                >
                  Cancel
                </button>
                <button
                  data-testid="close-confirm-accept"
                  className="border border-[#EF4444AA] bg-[#EF44441F] px-1.5 py-0.5 font-bold uppercase text-[#FEE2E2] hover:bg-[#EF444433]"
                  onClick={handleClose}
                >
                  Confirm
                </button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="border-[#EF4444AA] bg-[#EF44441F] text-[#FEE2E2] hover:bg-[#EF444433] hover:text-white"
                onClick={() => setCloseConfirm(true)}
              >
                CLOSE
              </Button>
            ))}
        </div>
      </div>

      {/* Error display — only when status !== 'error' (dedicated error view shows error) */}
      {task.error && task.runtime_state !== 'error' && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {task.error}
        </div>
      )}

      {/* Thin metadata bar — L1 lighter (5% white + 30px blur), 10/24 padding, 10% bottom stroke */}
      {!isScratch && (
        <div
          data-testid="task-detail-meta"
          className="flex items-center gap-5 px-6 py-[10px]"
          style={{
            background: 'rgba(255,255,255,0.05)',
            backdropFilter: 'blur(30px)',
            WebkitBackdropFilter: 'blur(30px)',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          {task.repo_path && (
            <>
              <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-[#6a6a6a]">
                REPO
              </span>
              <span className="text-[11px] text-[#8a8a8a]">{repoName(task.repo_path)}</span>
            </>
          )}
          {task.branch && (
            <>
              {task.repo_path && <span className="text-[11px] text-[#2f2f2f]">|</span>}
              <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-[#6a6a6a]">
                {runMode === 'existing' ? 'WORKTREE HEAD' : 'BRANCH'}
              </span>
              <span className="text-[11px] font-medium text-[#3B82F6]">
                {runMode === 'none' ? `${task.branch} (working tree)` : task.branch}
              </span>
            </>
          )}
          {task.base_branch && (
            <>
              <span className="text-[11px] text-[#2f2f2f]">|</span>
              <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-[#6a6a6a]">
                BASE
              </span>
              <span className="text-[11px] text-[#8a8a8a]">{task.base_branch}</span>
            </>
          )}
          {task.pr_url && (
            <>
              <span className="text-[11px] text-[#2f2f2f]">|</span>
              <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-[#6a6a6a]">
                PR
              </span>
              <a
                href={task.pr_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] font-medium text-[#3B82F6] hover:underline"
              >
                #{task.pr_number}
              </a>
            </>
          )}
        </div>
      )}

      {/* Dedicated lifecycle state: setting_up */}
      {task.runtime_state === 'setting_up' && !hasTerminal && mode === 'agents' && (
        <TaskSettingUpView task={task} />
      )}

      {/* Dedicated lifecycle state: error */}
      {task.runtime_state === 'error' && mode === 'agents' && (
        <TaskErrorView task={task} onRetry={handleResume} onDelete={handleDelete} />
      )}

      {/* Agent view — shown in agents mode. Skip entirely when a dedicated
          lifecycle state (setting_up / error) is rendering above. */}
      {task.runtime_state === 'error' ||
      (task.runtime_state === 'setting_up' && !hasTerminal) ? null : hasTerminal ? (
        <div className={mode === 'agents' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
          <AgentTabs
            agents={agents}
            activeIndex={activeWindow}
            onSelect={setActiveWindow}
            onAddAgent={handleAddAgent}
            onStopAgent={handleStopAgent}
            canAddAgent={isRunning}
            userTerminals={isRunning ? task.user_terminals || [] : []}
            onAddTerminal={isRunning ? handleAddTerminal : undefined}
            onCloseTerminal={isRunning ? handleCloseTerminal : undefined}
            onMoveAgent={isRunning ? (id) => setMovingAgentId(id) : undefined}
            onDetachAgent={
              isRunning
                ? async (id) => {
                    try {
                      await api.moveAgentToTask(id, null);
                      navigate(`/chats/${id}`);
                    } catch (err) {
                      console.error('Failed to detach agent:', err);
                    }
                  }
                : undefined
            }
          />
          {movingAgentId && (
            <MoveAgentDialog
              open={!!movingAgentId}
              onOpenChange={(open) => !open && setMovingAgentId(null)}
              agentId={movingAgentId}
              currentTaskId={task.id}
              agentLabel={task.agents?.find((a) => a.id === movingAgentId)?.label}
              onMoved={() => {
                setMovingAgentId(null);
                refresh();
              }}
            />
          )}
          <div className="min-h-0 flex-1 overflow-hidden p-1">
            <TerminalView
              taskId={task.id}
              windowIndex={activeWindow!}
              visible={mode === 'agents'}
            />
          </div>
        </div>
      ) : isDraft ? (
        <div className={mode === 'agents' ? 'min-h-0 flex-1 overflow-y-auto' : 'hidden'}>
          <DraftEditForm task={task} onSaved={refresh} onStart={handleStart} />
          <div
            data-testid="task-detail-panels"
            className="border-t border-glass-edge px-6 py-4"
          >
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              <TaskActivityPanel taskId={task.id} />
              <div>
                <TaskRefsPanel taskId={task.id} initialRefs={task.external_refs} />
                <JiraLinkHelper taskId={task.id} />
              </div>
              <TaskHooksPanel taskId={task.id} />
            </div>
          </div>
        </div>
      ) : (
        <div
          className={
            mode === 'agents'
              ? 'flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground'
              : 'hidden'
          }
        >
          {task.runtime_state === 'idle' && !isDraft ? (
            <>
              <TerminalRectIcon size={32} className="text-muted-foreground/50" />
              <span className="text-sm">Terminal session ended</span>
              {canResume && (
                <Button variant="default" size="sm" disabled={resuming} onClick={handleResume}>
                  {resuming ? 'Resuming...' : 'Resume'}
                </Button>
              )}
            </>
          ) : (
            <EmptyState
              icon={<TerminalRectIcon />}
              heading="No agents running"
              subtext="Add an agent to start working on this task"
              action={
                isRunning ? (
                  <Button variant="default" size="sm" onClick={() => handleAddAgent()}>
                    Add Agent
                  </Button>
                ) : undefined
              }
            />
          )}
        </div>
      )}

      {/* Diff view — review cockpit */}
      {mode === 'diff' && canShowDiff && (
        <TaskCommentsContext.Provider value={taskComments}>
          <div className="relative flex min-h-0 flex-1 flex-col">
            {diffSummary && diffSummary.base_ref ? (
              <ReviewBaseRefBanner
                baseRef={diffSummary.base_ref}
                baseIsStale={!!diffSummary.base_is_stale}
                totalCount={diffSummary.total_count ?? 0}
                reviewedCount={diffSummary.reviewed_count ?? 0}
                onRefresh={refetchDiff}
                onJumpToNextUnreviewed={jumpToNextUnreviewed}
                currentRangeLabel={currentRangeLabel}
                rangePicker={
                  <DiffRangePicker
                    taskId={task.id}
                    currentBaseBranch={task.base_branch}
                    range={range}
                    onRangeChange={setRange}
                    onBaseChange={handleBaseChange}
                  />
                }
                rightSlot={
                  <Button
                    variant="outline"
                    size="xs"
                    data-testid="comments-toggle"
                    data-active={showCommentsPanel ? 'true' : undefined}
                    className={
                      showCommentsPanel
                        ? 'border-[#22D3EE] bg-[#22D3EE1F] text-[#22D3EE]'
                        : 'border-[#2f2f2f] text-[#8a8a8a]'
                    }
                    onClick={() => setShowCommentsPanel((v) => !v)}
                  >
                    Comments ({taskComments.byId.size})
                  </Button>
                }
              />
            ) : null}
            <div className="flex min-h-0 flex-1">
              <div className="flex min-w-0 flex-1 flex-col">
                <DiffViewer
                  taskId={task.id}
                  isRunning={task.runtime_state === 'running'}
                  onSelectionChange={setActiveFilePath}
                  onSummaryLoaded={setDiffSummary}
                  onToggleReviewed={handleToggleReviewed}
                  range={range}
                  listRef={diffListRef}
                  enableComments={true}
                  agents={task.agents ?? []}
                  onFilesChange={setFilesInDiff}
                />
              </div>
              {showCommentsPanel ? (
                <CommentsSidePanel
                  agents={task.agents ?? []}
                  filesInDiff={filesInDiffSet}
                  rangeIsBase={range.kind === 'base'}
                  onJumpTo={handleJumpToComment}
                  onClose={() => setShowCommentsPanel(false)}
                />
              ) : null}
              {reviewQueue.comments.length > 0 ? (
                <CommentQueueDrawer
                  comments={reviewQueue.comments}
                  onRemove={reviewQueue.remove}
                  onJumpTo={(p) => setActiveFilePath(p)}
                  onSend={handleSendBatch}
                />
              ) : null}
            </div>
            <DiffKeybindCheatSheet />
          </div>
        </TaskCommentsContext.Provider>
      )}

      {/* Editor view — only shown for nvim (external editors stay on agents view) */}
      {userWindowIndex !== null && mode === 'editor' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden p-1">
            <TerminalView taskId={task.id} windowIndex={userWindowIndex} />
          </div>
        </div>
      )}

      {/* Info view — Activity / Refs / Hooks panels, opened via the INFO toolbar button */}
      {mode === 'info' && !isDraft && (
        <div
          data-testid="task-detail-panels"
          className="min-h-0 flex-1 overflow-y-auto px-6 py-4"
        >
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <TaskActivityPanel taskId={task.id} />
            <div>
              <TaskRefsPanel taskId={task.id} initialRefs={task.external_refs} />
              <JiraLinkHelper taskId={task.id} />
            </div>
            <TaskHooksPanel taskId={task.id} />
          </div>
        </div>
      )}
    </div>
  );
}
