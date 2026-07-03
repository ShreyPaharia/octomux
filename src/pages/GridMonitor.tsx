import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { taskApi } from '@/lib/api/taskApi';
import { regularTasksOnly } from '@/lib/task-filters';
import { EmptyState } from '@/components/EmptyState';
import { AgentGridCell } from '@/components/AgentGridCell';
import { TerminalRectIcon } from '@/components/icons';
import type { Task } from '@octomux/types';

const REFRESH_MS = 5000;

export function gridColumns(count: number): number {
  if (count <= 1) return 1;
  if (count <= 2) return 2;
  if (count <= 4) return 2;
  if (count <= 6) return 3;
  if (count <= 9) return 3;
  return 4;
}

interface FlatAgent {
  key: string;
  taskId: string;
  windowIndex: number;
  taskTitle: string;
  agentName: string;
  activity: 'active' | 'idle' | 'waiting';
}

export function flattenRunningAgents(tasks: Task[]): FlatAgent[] {
  const out: FlatAgent[] = [];
  for (const task of tasks) {
    if (task.runtime_state !== 'running' && task.runtime_state !== 'setting_up') continue;
    for (const agent of task.agents ?? []) {
      if (agent.status === 'stopped') continue;
      out.push({
        key: `${task.id}:${agent.window_index}`,
        taskId: task.id,
        windowIndex: agent.window_index,
        taskTitle: task.title || '(untitled task)',
        agentName: agent.label,
        activity: agent.hook_activity,
      });
    }
  }
  return out;
}

export default function GridMonitor() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchTasks = async () => {
      try {
        const data = regularTasksOnly(await taskApi.listTasks());
        if (!cancelled) {
          setTasks(data);
          setLoaded(true);
        }
      } catch (err) {
        console.warn('GridMonitor: failed to list tasks', err);
        if (!cancelled) setLoaded(true);
      }
    };
    fetchTasks();
    const id = setInterval(fetchTasks, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const agents = useMemo(() => flattenRunningAgents(tasks), [tasks]);
  const cols = gridColumns(agents.length);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-glass-edge px-4 py-2">
        <div>
          <h1 className="text-sm font-semibold uppercase tracking-wider">Grid Monitor</h1>
          <p className="text-[11px] text-muted-foreground">
            {agents.length} running agent{agents.length === 1 ? '' : 's'} · refreshes every 5s
          </p>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {loaded && agents.length === 0 ? (
          <EmptyState
            icon={<TerminalRectIcon size={32} />}
            heading="No running agents"
            subtext="Create a task to see live activity here."
            action={
              <Link
                to="/"
                className="rounded-md border border-glass-edge bg-glass-l1 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-glass-l2"
              >
                Create a task
              </Link>
            }
          />
        ) : (
          <div
            data-testid="agent-grid"
            className="grid gap-3"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {agents.map((a) => (
              <AgentGridCell
                key={a.key}
                taskId={a.taskId}
                windowIndex={a.windowIndex}
                taskTitle={a.taskTitle}
                agentName={a.agentName}
                activity={a.activity}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
