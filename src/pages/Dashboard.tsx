import { useCallback } from 'react';
import { useTasks } from '@/lib/hooks';
import { useTaskFilters } from '@/lib/use-task-filters';
import { TaskList } from '@/components/TaskList';
import { EmptyState } from '@/components/EmptyState';
import { TaskFilterBar } from '@/components/TaskFilterBar';
import { CreateTaskDialog } from '@/components/CreateTaskDialog';
import { OrchestratorCommandBar } from '@/components/OrchestratorCommandBar';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

export default function Dashboard() {
  const { tasks, loading, error, refresh } = useTasks();
  const { filters, setFilter, filtered, counts, repos } = useTaskFilters(tasks);

  const handleClose = useCallback(
    async (id: string) => {
      try {
        await api.updateTask(id, { status: 'closed' });
        refresh();
      } catch (err) {
        console.error('Failed to close task:', err);
      }
    },
    [refresh],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await api.deleteTask(id);
        refresh();
      } catch (err) {
        console.error('Failed to delete task:', err);
      }
    },
    [refresh],
  );

  const handleResume = useCallback(
    async (id: string) => {
      try {
        await api.updateTask(id, { status: 'running' });
        refresh();
      } catch (err) {
        console.error('Failed to resume task:', err);
      }
    },
    [refresh],
  );

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-6xl px-4 py-4">
        {error && (
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
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
              </svg>
            }
            heading="Unable to load tasks"
            subtext={`Check that the server is running on port 7777. ${error}`}
            action={
              <Button variant="outline" size="sm" onClick={refresh}>
                Retry
              </Button>
            }
          />
        )}

        {loading ? (
          <div className="flex flex-col gap-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse rounded-xl border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="h-5 w-48 rounded bg-muted" />
                  <div className="h-5 w-16 rounded bg-muted" />
                </div>
                <div className="mt-2 h-4 w-64 rounded bg-muted" />
                <div className="mt-3 flex items-center gap-2">
                  <div className="h-5 w-20 rounded bg-muted" />
                  <div className="h-4 w-32 rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <>
            <OrchestratorCommandBar />
            <TaskFilterBar
              activeStatus={filters.status}
              counts={counts}
              onStatusChange={(s) => setFilter('status', s)}
              repos={repos}
              activeRepo={filters.repo}
              onRepoChange={(r) => setFilter('repo', r)}
            />
            <TaskList
              tasks={filtered}
              totalCount={tasks.length}
              emptyAction={<CreateTaskDialog onCreated={refresh} />}
              onClose={handleClose}
              onDelete={handleDelete}
              onResume={handleResume}
            />
          </>
        )}
      </div>
    </div>
  );
}
