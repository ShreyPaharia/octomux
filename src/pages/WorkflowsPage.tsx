import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  workflowsApi,
  type WorkflowRow,
  type WorkflowRunRow,
  type WorkflowTrigger,
} from '@/lib/api/workflowsApi';
import { getWorkflowUI } from '@/workflows/registry';
import { useResource } from '@/lib/use-resource';
import { GlassPanel } from '@/components/ui/glass-panel';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/layout/page-header';
import { timeAgo } from '@/lib/time';

function triggerLabel(trigger: WorkflowTrigger | null): string {
  if (!trigger) return 'unknown';
  if (trigger.kind === 'github') return `GitHub: ${trigger.event ?? ''}`;
  return trigger.kind;
}

/** Workflow's own view if it has one, else `/reviews` for the reviewer special
 * case, else no deep link (workflow is registry-only). */
function deepLinkFor(kind: string): string | null {
  if (getWorkflowUI(kind)) return `/w/${kind}`;
  if (kind === 'reviewer') return '/reviews';
  return null;
}

function WorkflowRuns({ kind }: { kind: string }) {
  const nav = useNavigate();
  const { data: runs, loading } = useResource<WorkflowRunRow[]>(kind, () =>
    workflowsApi.getWorkflowRuns(kind).then((res) => res.runs),
  );

  if (loading) {
    return <p className="px-4 py-2 text-xs text-muted-foreground">Loading runs…</p>;
  }
  if (!runs || runs.length === 0) {
    return <p className="px-4 py-2 text-xs text-muted-foreground">No runs yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-1 px-4 py-2">
      {runs.map((run) => (
        <li
          key={run.id}
          data-testid={`workflow-run-${run.id}`}
          className="flex items-center gap-2 text-xs"
        >
          <span className="text-foreground">{run.effective_status}</span>
          <span className="text-muted-soft">{timeAgo(run.started_at)}</span>
          {run.task_id && (
            <button
              type="button"
              data-testid={`workflow-run-task-link-${run.id}`}
              className="text-muted-foreground hover:text-primary hover:underline"
              onClick={() => nav(`/tasks/${run.task_id}`)}
            >
              task
            </button>
          )}
          {run.loop_run_id && (
            <button
              type="button"
              data-testid={`workflow-run-loop-link-${run.id}`}
              className="text-muted-foreground hover:text-primary hover:underline"
              onClick={() => nav(`/w/loops/${run.loop_run_id}`)}
            >
              loop
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function WorkflowsPage() {
  const nav = useNavigate();
  const { data, loading } = useResource<WorkflowRow[]>('workflows', () =>
    workflowsApi.listWorkflows().then((res) => res.workflows),
  );
  const [expandedKind, setExpandedKind] = useState<string | null>(null);
  const workflows = data ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6">
      <PageHeader
        title="Workflows"
        description="Every cron- and event-triggered workflow, with its trigger and its runs."
      />

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-2xl border border-glass-edge bg-glass-l1"
            />
          ))}
        </div>
      ) : workflows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No workflows registered.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {workflows.map((wf) => {
            const deepLink = deepLinkFor(wf.kind);
            return (
              <li key={wf.kind}>
                <GlassPanel
                  level={2}
                  specular
                  data-testid={`workflow-row-${wf.kind}`}
                  className="flex flex-col gap-2 rounded-2xl px-4 py-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      data-testid={`workflow-expand-${wf.kind}`}
                      className="truncate text-sm font-medium text-foreground hover:text-primary"
                      onClick={() => setExpandedKind(expandedKind === wf.kind ? null : wf.kind)}
                    >
                      {wf.displayName}
                    </button>
                    <Badge variant="outline">{triggerLabel(wf.trigger)}</Badge>
                    <span className="text-xs text-muted-foreground">{wf.surfaces.join(', ')}</span>
                    <span
                      data-testid={`workflow-run-count-${wf.kind}`}
                      className="text-[10px] text-muted-soft"
                    >
                      {wf.runCount} runs
                    </span>
                    {deepLink && (
                      <button
                        type="button"
                        data-testid={`workflow-open-${wf.kind}`}
                        className="ml-auto text-xs text-muted-foreground hover:text-primary hover:underline"
                        onClick={() => nav(deepLink)}
                      >
                        Open
                      </button>
                    )}
                  </div>
                  {expandedKind === wf.kind && <WorkflowRuns kind={wf.kind} />}
                </GlassPanel>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
