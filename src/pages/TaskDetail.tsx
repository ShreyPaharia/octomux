import { useState, useCallback, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { TerminalView } from '@/components/TerminalView';
import { DraftEditForm } from '@/components/DraftEditForm';
import { EmptyState } from '@/components/EmptyState';
import { TaskSettingUpView } from '@/components/TaskSettingUpView';
import { TaskErrorView } from '@/components/TaskErrorView';
import { clearDiffTreeExpandedState } from '@/lib/diff-tree-storage';
import { useTask } from '@/lib/hooks';
import { taskApi } from '@/lib/api/taskApi';
import { reviewApi } from '@/lib/api/reviewApi';
import { TaskDetailHeader } from '@/components/layout/task-detail-header';
import { TaskDetailMeta } from '@/components/layout/task-detail-meta';
import { TaskInfoPanel } from '@/components/layout/task-info-panel';
import { TerminalRectIcon } from '@/components/icons';
import { TaskActivityPanel } from '@/components/TaskActivityPanel';
import { TaskRefsPanel } from '@/components/TaskRefsPanel';
import { TaskHooksPanel } from '@/components/TaskHooksPanel';
import { JiraLinkHelper } from '@/components/integrations/JiraLinkHelper';
import { TaskDetailAgentView, detachAgent } from '@/components/task-detail/TaskDetailAgentView';
import { TaskDetailDiffView } from '@/components/task-detail/TaskDetailDiffView';
import { useTaskViewMode } from '@/hooks/useTaskViewMode';
import { useTerminalCache } from '@/hooks/useTerminalCache';
import { useDiffState } from '@/hooks/useDiffState';
import { useTaskDetailComments } from '@/hooks/useTaskDetailComments';
import { _resetPerTaskUiState } from '@/hooks/perTaskUiState';
import type { RunMode } from '@octomux/types';

export const SHIP_EVENT = 'octomux:open-pr-sheet';

/** Re-export for tests that import from TaskDetail. */
export { _resetPerTaskUiState };

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const taskId = id ?? '';
  const { task, loading, error, refresh } = useTask(taskId);

  const {
    mode,
    setMode,
    activeWindow,
    setActiveWindow,
    gridView,
    setGridView,
    userWindowIndex,
    handleToggleEditor,
  } = useTaskViewMode({ taskId, task, refresh });

  const validWindowIndexes = useMemo(() => {
    const s = new Set<number>();
    for (const a of task?.agents || []) s.add(a.window_index);
    for (const t of task?.user_terminals || []) s.add(t.window_index);
    return s;
  }, [task?.agents, task?.user_terminals]);

  const { terminalLRU } = useTerminalCache({ taskId, activeWindow, validWindowIndexes });

  const [resuming, setResuming] = useState(false);
  const [movingAgentId, setMovingAgentId] = useState<string | null>(null);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [showCommentsPanel, setShowCommentsPanel] = useState(false);

  const { reviewQueue, taskComments } = useTaskDetailComments({ taskId });

  const activeAgentId = useMemo(() => {
    const ags = task?.agents ?? [];
    if (activeWindow !== null) {
      const a = ags.find((x) => x.window_index === activeWindow && x.status !== 'stopped');
      if (a) return a.id;
    }
    return ags.find((x) => x.status !== 'stopped')?.id ?? null;
  }, [task?.agents, activeWindow]);

  const isDiffMode = mode === 'diff';
  const diffState = useDiffState({
    taskId,
    isDiffMode,
    activeAgentId,
    reviewQueue,
    taskComments,
    refresh,
  });

  useEffect(() => {
    if (!taskId) return;
    taskApi.markTaskViewed(taskId).catch((err) => {
      console.warn('Failed to mark task viewed:', err);
    });
  }, [taskId]);

  useEffect(() => {
    if (task?.source === 'auto_review') {
      navigate(`/reviews/${task.id}`, { replace: true });
    }
  }, [task, navigate]);

  const [reviewBusy, setReviewBusy] = useState(false);
  const existingReviewId = task?.existing_review_id ?? null;

  const handleShip = useCallback(() => {
    if (!taskId) return;
    window.dispatchEvent(new CustomEvent(SHIP_EVENT, { detail: { taskId } }));
  }, [taskId]);

  const handleReview = useCallback(async () => {
    if (!taskId) return;
    if (existingReviewId) {
      navigate(`/reviews/${existingReviewId}`);
      return;
    }
    setReviewBusy(true);
    try {
      const result = await reviewApi.triggerManualReview(taskId);
      navigate(`/reviews/${result.id}`);
    } catch (err) {
      console.error('Failed to trigger review:', err);
      toast.error((err as Error).message);
    } finally {
      setReviewBusy(false);
    }
  }, [taskId, existingReviewId, navigate]);

  const handleAddAgent = useCallback(
    async (prompt?: string) => {
      if (!taskId) return;
      try {
        const agent = await taskApi.addAgent(taskId, prompt ? { prompt } : undefined);
        setActiveWindow(agent.window_index);
        refresh();
      } catch (err) {
        console.error('Failed to add agent:', err);
      }
    },
    [taskId, refresh, setActiveWindow],
  );

  const handleStopAgent = useCallback(
    async (agentId: string) => {
      if (!taskId) return;
      try {
        const taskAgents = task?.agents || [];
        const stoppedAgent = taskAgents.find((a) => a.id === agentId);
        await taskApi.stopAgent(taskId, agentId);
        if (stoppedAgent && stoppedAgent.window_index === activeWindow) {
          const nextAgent = taskAgents.find((a) => a.id !== agentId && a.status !== 'stopped');
          if (nextAgent) setActiveWindow(nextAgent.window_index);
        }
        refresh();
      } catch (err) {
        console.error('Failed to stop agent:', err);
      }
    },
    [taskId, refresh, task, activeWindow, setActiveWindow],
  );

  const handleClose = useCallback(async () => {
    if (!taskId) return;
    try {
      await taskApi.moveTask(taskId, { workflow_status: 'done' });
      setCloseConfirm(false);
      refresh();
    } catch (err) {
      console.error('Failed to mark task done:', err);
    }
  }, [taskId, refresh]);

  const handleStart = useCallback(async () => {
    if (!taskId) return;
    try {
      await taskApi.startTask(taskId);
      refresh();
    } catch (err) {
      console.error('Failed to start task:', err);
    }
  }, [taskId, refresh]);

  const handleDelete = useCallback(async () => {
    if (!taskId) return;
    try {
      await taskApi.deleteTask(taskId);
      clearDiffTreeExpandedState(taskId);
      navigate('/tasks');
    } catch (err) {
      console.error('Failed to delete task:', err);
    }
  }, [taskId, navigate]);

  const handleResume = useCallback(async () => {
    if (!taskId) return;
    setResuming(true);
    try {
      await taskApi.updateTask(taskId, { runtime_state: 'running' });
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
      const terminal = await taskApi.createTerminal(taskId);
      setActiveWindow(terminal.window_index);
      refresh();
    } catch (err) {
      console.error('Failed to create terminal:', err);
    }
  }, [taskId, refresh, setActiveWindow]);

  const handleCloseTerminal = useCallback(
    async (terminalId: string) => {
      if (!taskId) return;
      try {
        const terminals = task?.user_terminals || [];
        const closedTerminal = terminals.find((t) => t.id === terminalId);
        await taskApi.closeTerminal(taskId, terminalId);
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
    [taskId, refresh, task, activeWindow, setActiveWindow],
  );

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

  const agentSession = hasTerminal && mode === 'agents';

  return (
    <div
      className={
        agentSession
          ? 'octomux-agent-session flex h-full min-h-0 flex-col overflow-hidden'
          : 'flex h-full flex-col'
      }
    >
      <TaskDetailHeader
        task={task}
        mode={mode}
        canResume={canResume}
        resuming={resuming}
        canShowDiff={canShowDiff}
        isRunning={isRunning}
        isDraft={isDraft}
        closeConfirm={closeConfirm}
        reviewDisabled={!task.branch || !task.worktree}
        existingReviewId={existingReviewId}
        reviewBusy={reviewBusy}
        onResume={handleResume}
        onShip={handleShip}
        onToggleEditor={handleToggleEditor}
        onModeChange={setMode}
        onStart={handleStart}
        onCloseConfirm={() => setCloseConfirm(true)}
        onCloseAccept={handleClose}
        onCloseDismiss={() => setCloseConfirm(false)}
        onReview={handleReview}
      />

      {task.error && task.runtime_state !== 'error' && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {task.error}
        </div>
      )}

      {!isScratch && (
        <TaskDetailMeta
          task={task}
          className={hasTerminal && mode === 'agents' ? 'hidden md:flex' : undefined}
        />
      )}

      {task.runtime_state === 'setting_up' && !hasTerminal && mode === 'agents' && (
        <TaskSettingUpView task={task} />
      )}

      {task.runtime_state === 'error' && mode === 'agents' && (
        <TaskErrorView task={task} onRetry={handleResume} onDelete={handleDelete} />
      )}

      {task.runtime_state === 'error' ||
      (task.runtime_state === 'setting_up' && !hasTerminal) ? null : hasTerminal ? (
        <TaskDetailAgentView
          task={task}
          mode={mode}
          activeWindow={activeWindow}
          terminalLRU={terminalLRU}
          gridView={gridView}
          isRunning={isRunning}
          movingAgentId={movingAgentId}
          onSelectWindow={setActiveWindow}
          onGridViewToggle={() => setGridView((v) => !v)}
          onAddAgent={handleAddAgent}
          onStopAgent={handleStopAgent}
          onAddTerminal={handleAddTerminal}
          onCloseTerminal={handleCloseTerminal}
          onMoveAgent={setMovingAgentId}
          onDetachAgent={(agentId) => detachAgent(agentId, navigate)}
          onMoveDialogClose={() => setMovingAgentId(null)}
          onMoved={() => {
            setMovingAgentId(null);
            refresh();
          }}
        />
      ) : isDraft ? (
        <div className={mode === 'agents' ? 'min-h-0 flex-1 overflow-y-auto' : 'hidden'}>
          <DraftEditForm task={task} onSaved={refresh} onStart={handleStart} />
          <div data-testid="task-detail-panels" className="border-t border-glass-edge px-6 py-4">
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              <TaskInfoPanel>
                <TaskActivityPanel taskId={task.id} />
              </TaskInfoPanel>
              <TaskInfoPanel>
                <TaskRefsPanel taskId={task.id} initialRefs={task.external_refs} />
                <JiraLinkHelper taskId={task.id} />
              </TaskInfoPanel>
              <TaskInfoPanel>
                <TaskHooksPanel taskId={task.id} />
              </TaskInfoPanel>
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

      {mode === 'diff' && canShowDiff && (
        <TaskDetailDiffView
          task={task}
          range={diffState.range}
          diffSummary={diffState.diffSummary}
          currentRangeLabel={diffState.currentRangeLabel}
          showCommentsPanel={showCommentsPanel}
          filesInDiffSet={diffState.filesInDiffSet}
          diffListRef={diffState.diffListRef}
          reviewQueueComments={reviewQueue.comments}
          commentCount={taskComments.byId.size}
          taskComments={taskComments}
          onRangeChange={diffState.setRange}
          onBaseChange={diffState.handleBaseChange}
          onRefetchDiff={diffState.refetchDiff}
          onJumpToNextUnreviewed={diffState.jumpToNextUnreviewed}
          onToggleCommentsPanel={() => setShowCommentsPanel((v) => !v)}
          onCloseCommentsPanel={() => setShowCommentsPanel(false)}
          onSelectionChange={diffState.setActiveFilePath}
          onSummaryLoaded={diffState.setDiffSummary}
          onToggleReviewed={diffState.handleToggleReviewed}
          onFilesChange={diffState.setFilesInDiff}
          onJumpToComment={diffState.handleJumpToComment}
          onQueueRemove={reviewQueue.remove}
          onQueueJumpTo={diffState.setActiveFilePath}
          onSendBatch={diffState.handleSendBatch}
        />
      )}

      {userWindowIndex !== null && mode === 'editor' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-hidden p-1">
            <TerminalView taskId={task.id} windowIndex={userWindowIndex} />
          </div>
        </div>
      )}

      {mode === 'info' && !isDraft && (
        <div data-testid="task-detail-panels" className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <TaskInfoPanel>
              <TaskActivityPanel taskId={task.id} />
            </TaskInfoPanel>
            <TaskInfoPanel>
              <TaskRefsPanel taskId={task.id} initialRefs={task.external_refs} />
              <JiraLinkHelper taskId={task.id} />
            </TaskInfoPanel>
            <TaskInfoPanel>
              <TaskHooksPanel taskId={task.id} />
            </TaskInfoPanel>
          </div>
        </div>
      )}
    </div>
  );
}
