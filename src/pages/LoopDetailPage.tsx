import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { runApi, type RunDetail } from '../lib/api/runApi';
import { taskApi } from '../lib/api/taskApi';
import { useResource } from '../lib/use-resource';
import { IterationLedger } from '../components/loop/IterationLedger';
import { RunArtifacts } from '../components/RunArtifacts';
import { TerminalView } from '../components/TerminalView';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { PageHeader } from '@/components/layout/page-header';

type Tab = 'ledger' | 'agent';

export default function LoopDetailPage() {
  const { id } = useParams<{ id: string }>();
  const {
    data: run,
    loading,
    refresh,
  } = useResource<RunDetail>(id ? `loop:${id}` : null, () => runApi.getRun(id!), {
    events: (event) =>
      (event.type === 'loop:emit' && event.payload.runId === id) || event.type === 'task:updated',
  });
  const [tab, setTab] = useState<Tab>('ledger');
  const [stopping, setStopping] = useState(false);

  const loop = run?.loop ?? null;

  const { data: task } = useResource(loop ? `task:${loop.task_id}` : null, () =>
    taskApi.getTask(loop!.task_id),
  );

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (!run || !loop) return <div className="p-6 text-sm text-destructive">Loop run not found.</div>;

  const spec = (() => {
    try {
      return JSON.parse(loop.spec_json) as { budget?: { tokens?: number } };
    } catch {
      return {};
    }
  })();
  const tokensUsed = loop.iterations.reduce((sum, it) => sum + (it.tokens ?? 0), 0);

  const handleStop = async () => {
    setStopping(true);
    try {
      await runApi.stopRun(run.id);
      await refresh();
    } finally {
      setStopping(false);
    }
  };

  const activeAgent = task?.workers?.find((a) => a.status !== 'stopped') ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col p-6">
      <PageHeader title={`Loop ${run.id}`} />

      <div
        data-testid="loop-control-strip"
        className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-glass-edge bg-glass-l1 px-4 py-3"
      >
        <Badge data-testid="loop-status-badge">{loop.status}</Badge>
        <span className="font-mono text-sm">
          Iteration {loop.iteration} / {loop.max_iterations ?? '∞'}
        </span>
        {spec.budget?.tokens != null && (
          <span className="text-xs text-muted-foreground">
            {tokensUsed} / {spec.budget.tokens} tokens
          </span>
        )}
        {loop.termination_reason && (
          <span data-testid="termination-reason" className="text-xs text-muted-foreground">
            {loop.termination_reason}
          </span>
        )}
        {loop.status === 'running' && (
          <Button
            size="sm"
            variant="destructive"
            className="ml-auto"
            data-testid="loop-stop-button"
            onClick={handleStop}
            disabled={stopping}
          >
            {stopping ? 'Stopping…' : 'Stop'}
          </Button>
        )}
      </div>

      <div className="mt-4 flex gap-2">
        <Button
          variant={tab === 'ledger' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setTab('ledger')}
        >
          Iterations
        </Button>
        <Button
          variant={tab === 'agent' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setTab('agent')}
        >
          Live agent
        </Button>
      </div>

      <div className="mt-4 min-h-0 flex-1">
        {tab === 'ledger' ? (
          <IterationLedger taskId={loop.task_id} iterations={loop.iterations} />
        ) : activeAgent ? (
          <TerminalView taskId={loop.task_id} windowIndex={activeAgent.window_index} />
        ) : (
          <p className="text-sm text-muted-foreground">No active agent session.</p>
        )}
      </div>

      <div className="mt-4">
        <RunArtifacts artifacts={run.artifacts ?? []} />
      </div>
    </div>
  );
}
