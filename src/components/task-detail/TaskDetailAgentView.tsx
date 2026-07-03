import { TerminalView } from '@/components/TerminalView';
import { AgentTabs } from '@/components/AgentTabs';
import { AgentGridCell } from '@/components/AgentGridCell';
import { gridColumns } from '@/pages/GridMonitor';
import { MoveAgentDialog } from '@/components/MoveAgentDialog';
import { Button } from '@/components/ui/button';
import { taskApi } from '@/lib/api/taskApi';
import type { Task } from '@octomux/types';

export interface TaskDetailAgentViewProps {
  task: Task;
  mode: 'agents' | 'editor' | 'diff' | 'info';
  activeWindow: number | null;
  terminalLRU: number[];
  gridView: boolean;
  isRunning: boolean;
  movingAgentId: string | null;
  onSelectWindow: (index: number) => void;
  onGridViewToggle: () => void;
  onAddAgent: (prompt?: string) => Promise<void>;
  onStopAgent: (agentId: string) => Promise<void>;
  onAddTerminal: () => Promise<void>;
  onCloseTerminal: (terminalId: string) => Promise<void>;
  onMoveAgent: (agentId: string) => void;
  onDetachAgent: (agentId: string) => Promise<void>;
  onMoveDialogClose: () => void;
  onMoved: () => void;
}

export function TaskDetailAgentView({
  task,
  mode,
  activeWindow,
  terminalLRU,
  gridView,
  isRunning,
  movingAgentId,
  onSelectWindow,
  onGridViewToggle,
  onAddAgent,
  onStopAgent,
  onAddTerminal,
  onCloseTerminal,
  onMoveAgent,
  onDetachAgent,
  onMoveDialogClose,
  onMoved,
}: TaskDetailAgentViewProps) {
  const agents = task.agents || [];

  return (
    <div className={mode === 'agents' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <div className="flex shrink-0 items-center gap-1">
        <div className="min-w-0 flex-1">
          <AgentTabs
            agents={agents}
            activeIndex={activeWindow ?? 0}
            onSelect={onSelectWindow}
            onAddAgent={onAddAgent}
            onStopAgent={onStopAgent}
            canAddAgent={isRunning}
            userTerminals={isRunning ? task.user_terminals || [] : []}
            onAddTerminal={isRunning ? onAddTerminal : undefined}
            onCloseTerminal={isRunning ? onCloseTerminal : undefined}
            onMoveAgent={isRunning ? onMoveAgent : undefined}
            onDetachAgent={isRunning ? onDetachAgent : undefined}
          />
        </div>
        {agents.filter((a) => a.status !== 'stopped').length > 1 && (
          <Button
            type="button"
            size="xs"
            variant={gridView ? 'default' : 'outline'}
            data-testid="task-grid-toggle"
            aria-pressed={gridView}
            onClick={onGridViewToggle}
            className="mr-2"
          >
            {gridView ? 'Single' : 'Grid view'}
          </Button>
        )}
      </div>
      {movingAgentId && (
        <MoveAgentDialog
          open={!!movingAgentId}
          onOpenChange={(open) => !open && onMoveDialogClose()}
          agentId={movingAgentId}
          currentTaskId={task.id}
          agentLabel={task.agents?.find((a) => a.id === movingAgentId)?.label}
          onMoved={onMoved}
        />
      )}
      {gridView ? (
        <div data-testid="task-agent-grid" className="min-h-0 flex-1 overflow-auto p-2">
          {(() => {
            const running = agents.filter((a) => a.status !== 'stopped');
            const cols = gridColumns(running.length);
            return (
              <div
                className="grid gap-3"
                style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
              >
                {running.map((a) => (
                  <AgentGridCell
                    key={a.id}
                    taskId={task.id}
                    windowIndex={a.window_index}
                    taskTitle={task.title || '(untitled task)'}
                    agentName={a.label}
                    activity={a.hook_activity}
                  />
                ))}
              </div>
            );
          })()}
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden p-1">
          {terminalLRU.map((wi) => {
            const isActive = wi === activeWindow;
            return (
              <div
                key={wi}
                data-window-index={wi}
                data-terminal-active={isActive ? 'true' : 'false'}
                aria-hidden={!isActive}
                inert={!isActive}
                className={
                  isActive
                    ? 'absolute inset-0'
                    : 'pointer-events-none absolute inset-0 opacity-0'
                }
              >
                <TerminalView
                  taskId={task.id}
                  windowIndex={wi}
                  visible={isActive && mode === 'agents'}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export async function detachAgent(agentId: string, navigate: (path: string) => void): Promise<void> {
  try {
    await taskApi.moveAgentToTask(agentId, null);
    navigate(`/chats/${agentId}`);
  } catch (err) {
    console.error('Failed to detach agent:', err);
  }
}
