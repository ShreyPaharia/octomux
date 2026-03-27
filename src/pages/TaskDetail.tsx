import { useState, useCallback, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/StatusBadge';
import { TerminalView } from '@/components/TerminalView';
import { AgentTabs } from '@/components/AgentTabs';
import { DraftEditForm } from '@/components/DraftEditForm';
import { EmptyState } from '@/components/EmptyState';

import { useTask } from '@/lib/hooks';
import { api } from '@/lib/api';

/** Extract the last path segment (repo name) from a full path. */
function repoName(path?: string | null): string {
  if (!path) return '—';
  return path.split('/').filter(Boolean).pop() || path;
}

// Per-task UI state preserved across task switches (session-only, not persisted to disk).
interface PerTaskUiState {
  activeWindow: number | null;
  mode: 'agents' | 'editor';
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
  const [mode, setMode] = useState<'agents' | 'editor'>('agents');
  const [creatingEditor, setCreatingEditor] = useState(false);
  const [externalEditorOpen, setExternalEditorOpen] = useState(false);
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

  // Auto-switch back to agents when task enters non-running state
  useEffect(() => {
    if (task && task.status !== 'running') {
      setMode('agents');
      setLocalUserWindowIndex(null);
      setExternalEditorOpen(false);
    }
  }, [task?.status]);

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
      setExternalEditorOpen(false);
      return;
    }
    if (userWindowIndex === null && !externalEditorOpen) {
      if (creatingEditor) return;
      setCreatingEditor(true);
      try {
        const result = await api.createUserTerminal(taskId);
        if (result.editor === 'vscode' || result.editor === 'cursor') {
          setExternalEditorOpen(true);
        } else {
          setLocalUserWindowIndex(result.windowIndex);
        }
        refresh();
      } catch (err) {
        console.error('Failed to create user terminal:', err);
        return;
      } finally {
        setCreatingEditor(false);
      }
    }
    setMode('editor');
  }, [mode, userWindowIndex, externalEditorOpen, taskId, creatingEditor, refresh]);

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
        <Button variant="outline" onClick={() => navigate('/')}>
          Back to Dashboard
        </Button>
      </div>
    );
  }

  const agents = task.agents || [];
  const isRunning = task.status === 'running';
  const isDraft = task.status === 'draft';
  const canResume = (task.status === 'closed' || task.status === 'error') && !!task.worktree;

  const isTerminalAlive = task.status === 'running' || task.status === 'setting_up';
  const hasTerminal =
    !!task.tmux_session && agents.length > 0 && activeWindow !== null && isTerminalAlive;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2 sm:px-4 sm:py-3">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-base font-semibold sm:text-lg">{task.title}</h1>
              <StatusBadge status={task.derived_status || task.status} />
            </div>
            <p className="hidden max-w-xl truncate text-xs text-muted-foreground sm:block">
              {task.description}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          {canResume && (
            <Button variant="default" size="sm" disabled={resuming} onClick={handleResume}>
              {resuming ? '...' : 'Resume'}
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
          {isDraft && (
            <Button variant="default" size="sm" onClick={handleStart}>
              Start
            </Button>
          )}
          {isRunning && (
            <Button
              variant="outline"
              size="sm"
              className="border-[#2f2f2f] text-[#EF4444]"
              onClick={handleClose}
            >
              CLOSE
            </Button>
          )}
        </div>
      </div>

      {/* Error display */}
      {task.error && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {task.error}
        </div>
      )}

      {/* Metadata bar — always visible */}
      <div className="flex items-center gap-5 border-b border-border bg-[#141414] px-6 py-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#6a6a6a]">REPO</span>
        <span className="text-[11px] text-[#8a8a8a]">{repoName(task.repo_path)}</span>
        <span className="text-[11px] text-[#2f2f2f]">|</span>
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#6a6a6a]">
          BRANCH
        </span>
        <span className="text-[11px] font-medium text-[#3B82F6]">{task.branch}</span>
        {task.base_branch && (
          <>
            <span className="text-[11px] text-[#2f2f2f]">|</span>
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#6a6a6a]">
              BASE
            </span>
            <span className="text-[11px] text-[#8a8a8a]">{task.base_branch}</span>
          </>
        )}
        {task.pr_url && (
          <>
            <span className="text-[11px] text-[#2f2f2f]">|</span>
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#6a6a6a]">
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
          />
          <div className="min-h-0 flex-1 overflow-hidden p-1">
            <TerminalView
              taskId={task.id}
              windowIndex={activeWindow!}
              visible={mode === 'agents'}
            />
          </div>
        </div>
      ) : isDraft ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
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
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-muted-foreground/50"
              >
                <rect width="18" height="18" x="3" y="3" rx="2" />
                <path d="m7 8 4 4-4 4" />
                <path d="M13 16h4" />
              </svg>
              <span className="text-sm">Terminal session ended</span>
              {canResume && (
                <Button variant="default" size="sm" disabled={resuming} onClick={handleResume}>
                  {resuming ? 'Resuming...' : 'Resume'}
                </Button>
              )}
            </>
          ) : (
            <EmptyState
              icon={
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="48"
                  height="48"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect width="18" height="18" x="3" y="3" rx="2" />
                  <path d="m7 8 4 4-4 4" />
                  <path d="M13 16h4" />
                </svg>
              }
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

      {/* Editor view */}
      {mode === 'editor' && (
        <div className="flex min-h-0 flex-1 flex-col">
          {externalEditorOpen ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-muted-foreground/50"
              >
                <path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6" />
                <path d="m21 3-9 9" />
                <path d="M15 3h6v6" />
              </svg>
              <span className="text-sm">Opened in external editor</span>
              <Button
                variant="outline"
                size="sm"
                className="border-[#2f2f2f] text-[#8a8a8a]"
                onClick={handleToggleEditor}
              >
                Back to Agents
              </Button>
            </div>
          ) : userWindowIndex !== null ? (
            <div className="min-h-0 flex-1 overflow-hidden p-1">
              <TerminalView taskId={task.id} windowIndex={userWindowIndex} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
