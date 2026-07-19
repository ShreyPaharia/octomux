import { lazy, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task } from '@octomux/types';
import { registerWorkflowUI } from '../registry';
import { taskApi } from '@/lib/api/taskApi';
import { TasksIcon } from '@/components/sidebar/glyphs';
import { timeAgo } from '@/lib/time';

// doc-drift runs are plain tasks (source='doc_drift') — there is no dedicated
// run table, so the list view just filters GET /api/tasks client-side.
function DocDriftListView() {
  const nav = useNavigate();
  const [tasks, setTasks] = useState<Task[] | null>(null);

  useEffect(() => {
    taskApi.listTasks().then((all) => setTasks(all.filter((t) => t.source === 'doc_drift')));
  }, []);

  if (tasks === null) {
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  }
  if (tasks.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">No doc-drift runs yet.</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col p-6">
      <h1 className="mb-4 font-display text-2xl font-semibold text-foreground">Doc Drift</h1>
      <ul className="flex flex-col gap-2">
        {tasks.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              data-testid={`doc-drift-row-${t.id}`}
              className="flex w-full items-center gap-2 rounded-2xl border border-glass-edge bg-glass-l2 px-4 py-3 text-left text-sm hover:bg-glass-l3/80"
              onClick={() => nav(`/w/doc-drift/${t.id}`)}
            >
              <span className="flex-1 truncate">{t.title}</span>
              <span className="text-xs text-muted-foreground">{t.runtime_state}</span>
              <span className="text-[10px] text-muted-soft">{timeAgo(t.created_at)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// TaskDetail reads `:id` from useParams itself, so it plugs directly into the
// workflow DetailView slot (which also renders under a route with an :id param).
const TaskDetail = lazy(() => import('@/pages/TaskDetail'));

registerWorkflowUI('doc-drift', {
  navLabel: 'Doc Drift',
  icon: TasksIcon,
  ListView: DocDriftListView,
  DetailView: TaskDetail,
});
