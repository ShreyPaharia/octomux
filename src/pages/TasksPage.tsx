import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTasksContext } from '@/lib/tasks-context';
import { useTaskFilters } from '@/lib/use-task-filters';
import { TaskList } from '@/components/TaskList';
import { EmptyState } from '@/components/EmptyState';
import { TaskFilterBar } from '@/components/TaskFilterBar';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { PlusIcon } from '@/components/icons';

function NewTaskButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      onClick={onClick}
      className="bg-[#3B82F6] text-white hover:bg-[#3B82F6]/90"
      style={{
        boxShadow:
          'inset 0 1px 0 0 rgba(255, 255, 255, 0.35), 0 0 24px 0 rgba(59, 130, 246, 0.35)',
      }}
    >
      <PlusIcon data-icon="inline-start" />
      NEW TASK
    </Button>
  );
}

export default function TasksPage() {
  const { tasks, loading, error, refresh } = useTasksContext();
  const { filters, setFilter, filtered, counts, repos } = useTaskFilters(tasks);
  const navigate = useNavigate();
  const openCreate = useCallback(() => navigate('/'), [navigate]);

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
            {/* Header */}
            <div className="flex items-end justify-between">
              <div className="flex flex-col gap-2">
                <span
                  data-testid="page-eyebrow"
                  className="font-mono text-[11px] font-bold text-[#B5B5BD]"
                  style={{ letterSpacing: '1.5px' }}
                >
                  // TASKS
                </span>
                <h1
                  className="font-display text-[32px] font-bold leading-[1.1] tracking-tight"
                  style={{ letterSpacing: '-0.5px' }}
                >
                  Command center
                </h1>
              </div>
              <NewTaskButton onClick={openCreate} />
            </div>
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
              emptyAction={<NewTaskButton onClick={openCreate} />}
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
