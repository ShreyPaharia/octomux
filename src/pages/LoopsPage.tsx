import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { loopApi, type LoopRun } from '../lib/api/loopApi';
import { useResource } from '../lib/use-resource';
import { GlassPanel } from '@/components/ui/glass-panel';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { PageHeader } from '@/components/layout/page-header';
import { NewLoopDialog } from '../components/loop/NewLoopDialog';
import { timeAgo } from '@/lib/time';

const STATUS_VARIANT: Record<
  LoopRun['status'],
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  running: 'secondary',
  done: 'outline',
  blocked: 'destructive',
  needs_human: 'default',
};

export default function LoopsPage() {
  const { data, loading, refresh } = useResource<LoopRun[]>('loops', () => loopApi.listLoops(), {
    events: (event) => event.type === 'loop:emit' || event.type === 'task:updated',
  });
  const [newLoopOpen, setNewLoopOpen] = useState(false);
  const runs = data ?? [];
  const nav = useNavigate();

  return (
    <div className="flex h-full min-h-0 flex-col p-6">
      <PageHeader title="Loops" />
      <div className="mt-4 flex items-center justify-end">
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
                    <Badge variant={STATUS_VARIANT[r.status]}>{r.status}</Badge>
                    <span className="font-mono text-xs text-muted-foreground">
                      {r.iteration} / {r.max_iterations ?? '∞'}
                    </span>
                    <span className="text-[10px] text-muted-soft">{timeAgo(r.updated_at)}</span>
                  </div>
                  {r.termination_reason && (
                    <p className="mt-1 text-xs text-muted-foreground">{r.termination_reason}</p>
                  )}
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
    </div>
  );
}
