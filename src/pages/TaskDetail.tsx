import { useState, useCallback, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
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
  const { task, loading, error, refresh } = useTask(id!);
  const [activeWindow, setActiveWindow] = useState<number | null>(null);
  const [prDialogOpen, setPrDialogOpen] = useState(false);
  const [resuming, setResuming] = useState(false);

  // Initialize activeWindow from first agent's window_index
  useEffect(() => {
    if (activeWindow === null && task?.agents?.length) {
      setActiveWindow(task.agents[0].window_index);
    }
  }, [task, activeWindow]);

  const handleAddAgent = useCallback(
    async (prompt?: string) => {
      if (!id) return;
      try {
        const agent = await api.addAgent(id, prompt ? { prompt } : undefined);
        setActiveWindow(agent.window_index);
        refresh();
      } catch (err) {
        console.error('Failed to add agent:', err);
      }
    },
    [id, refresh],
  );

  const handleStopAgent = useCallback(
    async (agentId: string) => {
      if (!id) return;
      try {
        const taskAgents = task?.agents || [];
        const stoppedAgent = taskAgents.find((a) => a.id === agentId);
        await api.stopAgent(id, agentId);
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
    [id, refresh, task, activeWindow],
  );

  const handleClose = useCallback(async () => {
    if (!id) return;
    try {
      await api.updateTask(id, { status: 'closed' });
      refresh();
    } catch (err) {
      console.error('Failed to close task:', err);
    }
  }, [id, refresh]);

  const handleStart = useCallback(async () => {
    if (!id) return;
    try {
      await api.startTask(id);
      refresh();
    } catch (err) {
      console.error('Failed to start task:', err);
    }
  }, [id, refresh]);

  const handleResume = useCallback(async () => {
    if (!id) return;
    setResuming(true);
    try {
      await api.updateTask(id, { status: 'running' });
      refresh();
    } catch (err) {
      console.error('Failed to resume task:', err);
    } finally {
      setResuming(false);
    }
  }, [id, refresh]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        Loading...
      </div>
    );
  }

  if (error || !task) {
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
  const hasTerminal = !!task.tmux_session && agents.length > 0 && activeWindow !== null;

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
              <StatusBadge status={task.status} />
            </div>
            <p className="text-xs text-muted-foreground">{task.description}</p>
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

      {/* Agent tabs + Terminal */}
      {hasTerminal ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <AgentTabs
            agents={agents}
            activeIndex={activeWindow}
            onSelect={setActiveWindow}
            onAddAgent={handleAddAgent}
            onStopAgent={handleStopAgent}
            canAddAgent={isRunning}
          />
          <div className="min-h-0 flex-1 p-2">
            <TerminalView taskId={task.id} windowIndex={activeWindow!} />
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          {task.status === 'draft' || task.status === 'setting_up'
            ? 'Setting up terminal...'
            : 'No terminal available'}
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
