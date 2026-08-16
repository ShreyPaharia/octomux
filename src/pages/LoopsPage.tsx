import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { runApi, type RunRow } from '../lib/api/runApi';
import { useResource } from '../lib/use-resource';
import { GlassPanel } from '@/components/ui/glass-panel';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { PageHeader } from '@/components/layout/page-header';
import { NewLoopDialog } from '../components/loop/NewLoopDialog';
import { NewLoopGroupDialog } from '../components/loop/NewLoopGroupDialog';
import { timeAgo } from '@/lib/time';

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  running: 'secondary',
  done: 'outline',
  blocked: 'destructive',
  needs_human: 'default',
};

export default function LoopsPage() {
  // `GET /api/runs?kind=loop` returns thin `runs` rows (no iteration/max_iterations/
  // termination_reason — those are loop_runs-specific fields, only available on the
  // detail endpoint's nested `loop` object) — see server/routes/runs.ts's module doc.
  const { data, loading, refresh } = useResource<RunRow[]>(
    'loops',
    () => runApi.listRuns('loop').then((res) => res.runs),
    { events: (event) => event.type === 'loop:emit' || event.type === 'task:updated' },
  );
  const [newLoopOpen, setNewLoopOpen] = useState(false);
  const [newLoopGroupOpen, setNewLoopGroupOpen] = useState(false);
  const runs = data ?? [];
  const nav = useNavigate();

  return (
    <div className="flex h-full min-h-0 flex-col p-6">
      <PageHeader title="Loops" />
      <div className="mt-4 flex items-center justify-end gap-2">
        <Button size="sm" variant="outline" onClick={() => setNewLoopGroupOpen(true)}>
          Best of N
        </Button>
        <Button size="sm" onClick={() => setNewLoopOpen(true)}>
          New loop
        </Button>
      </div>

      {loading ? (
        <div className="mt-4 space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-2xl border border-glass-edge bg-glass-l1"
            />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No loop runs yet.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {runs.map((r) => (
            <li key={r.id}>
              <GlassPanel
                level={2}
                specular
                data-testid={`loop-row-${r.id}`}
                className="group flex cursor-pointer flex-col gap-2 rounded-2xl px-4 py-3 transition-colors hover:bg-glass-l3/80 sm:flex-row sm:items-center"
                onClick={() => nav(`/loops/${r.id}`)}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground group-hover:text-primary">
                      {r.task_id}
                    </span>
                    <Badge variant={STATUS_VARIANT[r.effective_status]}>{r.effective_status}</Badge>
                    <span className="text-[10px] text-muted-soft">{timeAgo(r.started_at)}</span>
                  </div>
                  {r.error && <p className="mt-1 text-xs text-muted-foreground">{r.error}</p>}
                </div>
              </GlassPanel>
            </li>
          ))}
        </ul>
      )}

      <NewLoopDialog
        open={newLoopOpen}
        onOpenChange={setNewLoopOpen}
        onCreated={(run) => {
          refresh();
          nav(`/loops/${run.id}`);
        }}
      />
      <NewLoopGroupDialog
        open={newLoopGroupOpen}
        onOpenChange={setNewLoopGroupOpen}
        onCreated={(group) => nav(`/loop-groups/${group.id}`)}
      />
    </div>
  );
}
