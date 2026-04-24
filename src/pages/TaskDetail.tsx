import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/StatusBadge';
import { TerminalView } from '@/components/TerminalView';
import { AgentTabs } from '@/components/AgentTabs';
import { DiffViewer } from '@/components/DiffViewer';
import { DraftEditForm } from '@/components/DraftEditForm';
import { EmptyState } from '@/components/EmptyState';
import { MoveAgentDialog } from '@/components/MoveAgentDialog';

import { useTask } from '@/lib/hooks';
import { api } from '@/lib/api';
import { repoName } from '@/lib/utils';
import { PullRequestIcon, TerminalRectIcon } from '@/components/icons';
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

// Per-task UI state preserved across task switches (session-only, not persisted to disk).
interface PerTaskUiState {
  activeWindow: number | null;
  mode: 'agents' | 'editor' | 'diff';
}
const perTaskUiState = new Map<string, PerTaskUiState>();

/** Reset per-task UI state — exposed for tests only. */
export function _resetPerTaskUiState() {
  perTaskUiState.clear();
}

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const taskId = id ?? '';
  const { task, loading, error, refresh } = useTask(taskId);
  const [activeWindow, setActiveWindow] = useState<number | null>(null);

  const [resuming, setResuming] = useState(false);
  const [mode, setMode] = useState<'agents' | 'editor' | 'diff'>('agents');
  const [creatingEditor, setCreatingEditor] = useState(false);
  const [searchParams] = useSearchParams();
  const agentParam = searchParams.get('agent');

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
    if (task && task.status !== 'running') {
      setMode((m) => (m === 'editor' ? 'agents' : m));
      setLocalUserWindowIndex(null);
    }
  }, [task?.status]);

  const [movingAgentId, setMovingAgentId] = useState<string | null>(null);
  const [closeConfirm, setCloseConfirm] = useState(false);

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
  const isRunning = task.status === 'running';
  const isDraft = task.status === 'draft';
  const canResume = (task.status === 'closed' || task.status === 'error') && !!task.worktree;
  const runMode: RunMode = task.run_mode ?? 'new';
  const isScratch = runMode === 'scratch';
  const canShowDiff = !isScratch && task.status !== 'draft';

  const isTerminalAlive = task.status === 'running' || task.status === 'setting_up';
  const hasTerminal =
    !!task.tmux_session && agents.length > 0 && activeWindow !== null && isTerminalAlive;

  return (
    <div className="flex h-full flex-col">
      {/* L1 glass header — compact 12px vertical padding */}
      <div
        data-testid="task-detail-header"
        className="bg-glass-l1 glass-blur-l1 flex items-center justify-between gap-3 border-b border-glass-edge px-4 py-3"
      >
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-[15px] font-semibold leading-none">{task.title}</h1>
          <span
            data-testid="mode-badge"
            title={MODE_TOOLTIP[runMode]}
            aria-label={`run mode: ${MODE_TOOLTIP[runMode]}`}
            className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-[#2f2f2f] bg-[#1a1a1a] px-1.5 font-mono text-[10px] font-bold text-[#8a8a8a]"
          >
            {MODE_LABEL[runMode]}
          </span>
          <StatusBadge status={task.derived_status || task.status} />
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

          <span
            aria-label="open command palette"
            title="Command palette (⌘K)"
            className="bg-glass-l1 glass-blur-l1 hidden h-7 items-center gap-0.5 border border-glass-edge px-1.5 font-mono text-[11px] tracking-wider text-[#b5b5bd] sm:inline-flex"
          >
            <span className="text-[13px] leading-none">⌘</span>
            <span>K</span>
          </span>

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
              className={
                mode === 'diff'
                  ? 'border-[#2f2f2f] text-[#3B82F6]'
                  : 'border-[#2f2f2f] text-[#8a8a8a]'
              }
              onClick={() => setMode(mode === 'diff' ? 'agents' : 'diff')}
            >
              DIFF
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

      {/* Error display */}
      {task.error && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {task.error}
        </div>
      )}

      {/* Thin metadata bar — L1 lighter (5% white + 30px blur), 6px vertical padding */}
      {!isScratch && (
        <div
          className="flex items-center gap-5 border-b border-glass-edge px-6 py-[6px]"
          style={{
            background: 'rgba(255,255,255,0.05)',
            backdropFilter: 'blur(30px)',
            WebkitBackdropFilter: 'blur(30px)',
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

      {/* Agent view — shown in agents mode */}
      {hasTerminal ? (
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
        </div>
      ) : (
        <div
          className={
            mode === 'agents'
              ? 'flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground'
              : 'hidden'
          }
        >
          {task.status === 'setting_up' ? (
            'Setting up terminal...'
          ) : task.status === 'closed' || task.status === 'error' ? (
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

      {/* Diff view */}
      {mode === 'diff' && canShowDiff && (
        <div className="flex min-h-0 flex-1 flex-col">
          <DiffViewer taskId={task.id} isRunning={task.status === 'running'} />
        </div>
      )}

      {/* Editor view — only shown for nvim (external editors stay on agents view) */}
      {userWindowIndex !== null && mode === 'editor' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden p-1">
            <TerminalView taskId={task.id} windowIndex={userWindowIndex} />
          </div>
        </div>
      )}
    </div>
  );
}
