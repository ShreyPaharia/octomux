import { useState, useCallback, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/StatusBadge';
import { TerminalView } from '@/components/TerminalView';
import { AgentTabs } from '@/components/AgentTabs';
import { CreatePRDialog } from '@/components/CreatePRDialog';
import { useTask } from '@/lib/hooks';
import { api } from '@/lib/api';

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const taskId = id ?? '';
  const { task, loading, error, refresh } = useTask(taskId);
  const [activeWindow, setActiveWindow] = useState<number | null>(null);
  const [prDialogOpen, setPrDialogOpen] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [mode, setMode] = useState<'agents' | 'editor'>('agents');
  const [creatingEditor, setCreatingEditor] = useState(false);
  const [searchParams] = useSearchParams();
  const agentParam = searchParams.get('agent');

  // Local override for user_window_index so we can set it immediately from
  // the createUserTerminal API response instead of waiting for the next poll.
  const [localUserWindowIndex, setLocalUserWindowIndex] = useState<number | null>(null);
  // Derive userWindowIndex — prefer server-persisted data, fall back to local override.
  const userWindowIndex = task?.user_window_index ?? localUserWindowIndex;

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
      // Reset local override so the editor terminal is re-created on next toggle
      setLocalUserWindowIndex(null);
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

  const handleToggleEditor = useCallback(async () => {
    if (mode === 'editor') {
      setMode('agents');
      return;
    }
    if (userWindowIndex === null) {
      if (creatingEditor) return; // Prevent duplicate requests
      setCreatingEditor(true);
      try {
        const result = await api.createUserTerminal(taskId);
        // Set the window index immediately from the API response so the
        // editor terminal can mount without waiting for the next poll cycle.
        setLocalUserWindowIndex(result.user_window_index);
        refresh();
      } catch (err) {
        console.error('Failed to create user terminal:', err);
        return;
      } finally {
        setCreatingEditor(false);
      }
    }
    setMode('editor');
  }, [mode, userWindowIndex, taskId, creatingEditor, refresh]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        Loading...
      </div>
    );
  }

  if (!task) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
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
  const canCreatePR =
    !!task.branch && !task.pr_url && (task.status === 'closed' || task.status === 'running');
  const isTerminalAlive = task.status === 'running' || task.status === 'setting_up';
  const hasTerminal =
    !!task.tmux_session && agents.length > 0 && activeWindow !== null && isTerminalAlive;

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate('/')}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              data-icon="inline-start"
            >
              <path d="m15 18-6-6 6-6" />
            </svg>
            Back
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold">{task.title}</h1>
              <StatusBadge status={task.derived_status || task.status} />
            </div>
            <p className="max-w-xl truncate text-xs text-muted-foreground">{task.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {task.pr_url && (
            <a
              href={task.pr_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-400 hover:underline"
            >
              PR #{task.pr_number}
            </a>
          )}
          {canResume && (
            <Button variant="outline" size="sm" disabled={resuming} onClick={handleResume}>
              {resuming ? 'Resuming...' : 'Resume'}
            </Button>
          )}
          {canCreatePR && (
            <Button variant="outline" size="sm" onClick={() => setPrDialogOpen(true)}>
              Create PR
            </Button>
          )}
          {isRunning && !!task.tmux_session && (
            <Button
              variant={mode === 'editor' ? 'default' : 'outline'}
              size="sm"
              onClick={handleToggleEditor}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="16 18 22 12 16 6" />
                <polyline points="8 6 2 12 8 18" />
              </svg>
              Editor
            </Button>
          )}
          {isDraft && (
            <Button variant="outline" size="sm" onClick={handleStart}>
              Start
            </Button>
          )}
          {isRunning && (
            <Button variant="outline" size="sm" onClick={handleClose}>
              Close
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
          />
          <div className="min-h-0 flex-1 overflow-hidden p-2">
            <TerminalView
              taskId={task.id}
              windowIndex={activeWindow!}
              visible={mode === 'agents'}
            />
          </div>
        </div>
      ) : (
        <div
          className={
            mode === 'agents'
              ? 'flex flex-1 items-center justify-center text-muted-foreground'
              : 'hidden'
          }
        >
          {task.status === 'draft' || task.status === 'setting_up'
            ? 'Setting up terminal...'
            : task.status === 'closed' || task.status === 'error'
              ? 'Terminal session ended'
              : 'No terminal available'}
        </div>
      )}

      {/* Editor view — fully unmounted when not active so the terminal
          mounts fresh each time with correct dimensions. Nvim redraws its
          own screen, so there's no lost scrollback to worry about. */}
      {userWindowIndex !== null && mode === 'editor' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden p-2">
            <TerminalView taskId={task.id} windowIndex={userWindowIndex} />
          </div>
        </div>
      )}

      <CreatePRDialog
        taskId={task.id}
        open={prDialogOpen}
        onOpenChange={setPrDialogOpen}
        onCreated={refresh}
      />
    </div>
  );
}
