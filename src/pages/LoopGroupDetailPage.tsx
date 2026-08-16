import { useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { runApi, type RunDetail } from '@/lib/api/runApi';
import { useResource } from '@/lib/use-resource';
import { GlassPanel } from '@/components/ui/glass-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/layout/page-header';
import { timeAgo } from '@/lib/time';

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  running: 'secondary',
  done: 'outline',
  blocked: 'destructive',
  needs_human: 'default',
};

export default function LoopGroupDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, refresh } = useResource<RunDetail>(id ?? null, () => runApi.getRun(id!), {
    events: (event) =>
      (event.type === 'loop_group:judged' && event.payload.runId === id) ||
      event.type === 'task:updated',
  });
  const group = data?.loopGroup ?? null;

  const allTerminal =
    (group?.candidates ?? []).length > 0 &&
    (group?.candidates ?? []).every((r) => r.status !== 'running');
  const judging = group?.judge_status === 'running';

  const handleJudge = useCallback(async () => {
    if (!id) return;
    await runApi.judgeLoopGroup(id);
    refresh();
  }, [id, refresh]);

  if (loading || !data || !group) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col p-6">
      <PageHeader title={`Best of N — ${group.n} candidates`} description={group.repo_path} />

      <div className="mt-4 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Base branch: {group.base_branch}</p>
        <Button
          size="sm"
          data-testid="judge-now-button"
          disabled={!allTerminal || judging}
          onClick={handleJudge}
        >
          {judging ? 'Judging…' : 'Judge now'}
        </Button>
      </div>

      {group.judge_status === 'done' && (
        <GlassPanel level={2} className="mt-4 rounded-2xl p-4" data-testid="judge-verdict">
          <p className="text-sm font-medium text-foreground">Winner: {group.winner_loop_run_id}</p>
          <p className="mt-1 text-xs text-muted-foreground">{group.judge_rationale}</p>
          <p className="mt-1 text-[10px] text-muted-soft">
            Advisory — review the candidate yourself before merging.
          </p>
        </GlassPanel>
      )}

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {group.candidates.map((run) => (
          <GlassPanel
            key={run.id}
            level={2}
            specular
            data-testid={`loop-group-candidate-${run.id}`}
            className="flex flex-col gap-2 rounded-2xl p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-foreground">{run.task_id}</span>
              {group.winner_loop_run_id === run.id && <Badge variant="default">Winner</Badge>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={STATUS_VARIANT[run.status]}>{run.status}</Badge>
              <span className="font-mono text-xs text-muted-foreground">
                {run.iteration} / {run.max_iterations ?? '∞'}
              </span>
              <span className="text-[10px] text-muted-soft">{timeAgo(run.updated_at)}</span>
            </div>
            {run.termination_reason && (
              <p className="text-xs text-muted-foreground">{run.termination_reason}</p>
            )}
          </GlassPanel>
        ))}
      </div>
    </div>
  );
}
