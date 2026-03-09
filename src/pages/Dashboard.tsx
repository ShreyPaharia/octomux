import { useTasks } from '@/lib/hooks';
import { TaskList } from '@/components/TaskList';
import { CreateTaskDialog } from '@/components/CreateTaskDialog';
import { OrchestratorPanel } from '@/components/OrchestratorPanel';
import { api } from '@/lib/api';

export default function Dashboard() {
  const { tasks, loading, error, refresh } = useTasks();

  async function handleDelete(id: string) {
    try {
      await api.deleteTask(id);
      refresh();
    } catch (err) {
      console.error('Failed to delete task:', err);
    }
  }

  return (
    <div className="flex h-screen">
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl px-4 py-8">
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">octomux-agents</h1>
              <p className="text-sm text-muted-foreground">Autonomous agent fleet</p>
            </div>
            <CreateTaskDialog onCreated={refresh} />
          </div>

          {error && (
            <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              Loading...
            </div>
          ) : (
            <TaskList tasks={tasks} onDelete={handleDelete} />
          )}
        </div>
      </div>
      <OrchestratorPanel />
    </div>
  );
}
