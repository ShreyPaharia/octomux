import { useCallback } from 'react';
import { useTasks } from '@/lib/hooks';
import { useTaskFilters } from '@/lib/use-task-filters';
import { TaskList } from '@/components/TaskList';
import { TaskFilterBar } from '@/components/TaskFilterBar';
import { CreateTaskDialog } from '@/components/CreateTaskDialog';
import { NotificationToggle } from '@/components/NotificationToggle';
import { OrchestratorPanel } from '@/components/OrchestratorPanel';
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
    <div className="flex h-screen">
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl px-4 py-8">
          <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">octomux-agents</h1>
              <p className="text-sm text-muted-foreground">Autonomous agent fleet</p>
            </div>
            <div className="flex items-center gap-2">
              <NotificationToggle />
              <CreateTaskDialog onCreated={refresh} />
            </div>
          </div>

          {error && (
            <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">
                    Unable to load tasks. Check that the server is running on port 7777.
                  </p>
                  <p className="mt-1 text-xs text-destructive/70">{error}</p>
                </div>
                <Button variant="outline" size="sm" onClick={refresh}>
                  Retry
                </Button>
              </div>
            </div>
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
                onClose={handleClose}
                onDelete={handleDelete}
                onResume={handleResume}
              />
            </>
          )}
        </div>
      </div>
      <OrchestratorPanel />
    </div>
  );
}
