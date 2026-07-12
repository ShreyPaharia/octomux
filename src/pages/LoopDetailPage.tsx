import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { loopApi, type LoopRunDetail } from '../lib/api/loopApi';
import { taskApi } from '../lib/api/taskApi';
import { useResource } from '../lib/use-resource';
import { IterationLedger } from '../components/loop/IterationLedger';
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
  } = useResource<LoopRunDetail>(id ? `loop:${id}` : null, () => loopApi.getLoop(id!), {
    events: (event) =>
      (event.type === 'loop:emit' && event.payload.loopRunId === id) ||
      event.type === 'task:updated',
  });
  const [tab, setTab] = useState<Tab>('ledger');
  const [stopping, setStopping] = useState(false);

  const { data: task } = useResource(run ? `task:${run.task_id}` : null, () =>
    taskApi.getTask(run!.task_id),
  );

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (!run) return <div className="p-6 text-sm text-destructive">Loop run not found.</div>;

  const spec = (() => {
    try {
      return JSON.parse(run.spec_json) as { budget?: { tokens?: number } };
    } catch {
      return {};
    }
  })();
  const tokensUsed = run.iterations.reduce((sum, it) => sum + (it.tokens ?? 0), 0);

  const handleStop = async () => {
    setStopping(true);
    try {
      await loopApi.stopLoop(run.id);
      await refresh();
    } finally {
      setStopping(false);
    }
  };

  const activeAgent = task?.agents?.find((a) => a.status !== 'stopped') ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col p-6">
      <PageHeader title={`Loop ${run.id}`} />

      <div
        data-testid="loop-control-strip"
        className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-glass-edge bg-glass-l1 px-4 py-3"
      >
        <Badge data-testid="loop-status-badge">{run.status}</Badge>
        <span className="font-mono text-sm">
          Iteration {run.iteration} / {run.max_iterations ?? '∞'}
        </span>
        {spec.budget?.tokens != null && (
          <span className="text-xs text-muted-foreground">
            {tokensUsed} / {spec.budget.tokens} tokens
          </span>
        )}
        {run.termination_reason && (
          <span data-testid="termination-reason" className="text-xs text-muted-foreground">
            {run.termination_reason}
          </span>
        )}
        {run.status === 'running' && (
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
          <IterationLedger taskId={run.task_id} iterations={run.iterations} />
        ) : activeAgent ? (
          <TerminalView taskId={run.task_id} windowIndex={activeAgent.window_index} />
        ) : (
          <p className="text-sm text-muted-foreground">No active agent session.</p>
        )}
      </div>
    </div>
  );
}
