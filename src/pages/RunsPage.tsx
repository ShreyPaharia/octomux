import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { RunResult } from '@octomux/types';
import { isRunResult } from '@octomux/types';
import { workflowsApi, type WorkflowRunRow } from '@/lib/api/workflowsApi';
import { getWorkflowUI } from '@/workflows/registry';
import { useResource } from '@/lib/use-resource';
import { GlassPanel } from '@/components/ui/glass-panel';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/layout/page-header';
import { timeAgo } from '@/lib/time';
import { RunResultCard, OUTCOME_TONE } from '@/components/runs/RunResultCard';

const ALL_KIND = '__all__';

/** `result_json` is untrusted TEXT predating the envelope contract — parse defensively. */
function parseResult(resultJson: string | null | undefined): RunResult | null {
  if (!resultJson) return null;
  try {
    const parsed: unknown = JSON.parse(resultJson);
    return isRunResult(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function RunRow({ run }: { run: WorkflowRunRow }) {
  const nav = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const result = parseResult(run.result_json);
  const hasDetailView = !!getWorkflowUI(run.workflow_kind);
  const deepLink = run.task_id && hasDetailView ? `/w/${run.workflow_kind}/${run.task_id}` : null;

  return (
    <li>
      <GlassPanel
        level={2}
        specular
        data-testid={`run-row-${run.id}`}
        className="flex cursor-pointer flex-col gap-2 rounded-2xl px-4 py-3 text-sm hover:bg-glass-l3/80"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-foreground">{run.workflow_kind}</span>
          <Badge variant="outline">{run.trigger}</Badge>
          {result ? (
            <span
              data-testid={`run-outcome-${run.id}`}
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${OUTCOME_TONE[result.outcome]}`}
            >
              {result.outcome}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{run.effective_status}</span>
          )}
          {result && <span className="text-[10px] text-muted-soft">{run.effective_status}</span>}
          <span className="text-[10px] text-muted-soft">{timeAgo(run.started_at)}</span>
          {deepLink && (
            <button
              type="button"
              data-testid={`run-detail-link-${run.id}`}
              className="ml-auto text-xs text-muted-foreground hover:text-primary hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                nav(deepLink);
              }}
            >
              Open
            </button>
          )}
        </div>
        {expanded &&
          (result ? (
            <RunResultCard result={result} />
          ) : (
            <p className="text-xs text-muted-soft">No result recorded for this run.</p>
          ))}
      </GlassPanel>
    </li>
  );
}

export default function RunsPage() {
  const { data, loading } = useResource<WorkflowRunRow[]>('runs', () =>
    workflowsApi.listAllRuns().then((res) => res.runs),
  );
  // `?kind=` seeds the initial filter (e.g. the /extracts → /runs?kind=pr-extract redirect) —
  // it is not kept in sync afterwards; the chip row is plain component state from then on.
  const [searchParams] = useSearchParams();
  const [selectedKind, setSelectedKind] = useState<string>(
    () => searchParams.get('kind') ?? ALL_KIND,
  );
  const runs = useMemo(() => data ?? [], [data]);

  const kinds = useMemo(() => Array.from(new Set(runs.map((r) => r.workflow_kind))).sort(), [runs]);
  const visibleRuns = useMemo(
    () => (selectedKind === ALL_KIND ? runs : runs.filter((r) => r.workflow_kind === selectedKind)),
    [runs, selectedKind],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6">
      <PageHeader
        title="Runs"
        description="Every workflow invocation across every kind, newest first."
      />

      {kinds.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="run-kind-chip-all"
            onClick={() => setSelectedKind(ALL_KIND)}
            className={`rounded-full border border-glass-edge px-3 py-1 text-xs ${
              selectedKind === ALL_KIND
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            All
          </button>
          {kinds.map((kind) => (
            <button
              key={kind}
              type="button"
              data-testid={`run-kind-chip-${kind}`}
              onClick={() => setSelectedKind(kind)}
              className={`rounded-full border border-glass-edge px-3 py-1 text-xs ${
                selectedKind === kind
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {kind}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-2xl border border-glass-edge bg-glass-l1"
            />
          ))}
        </div>
      ) : visibleRuns.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {visibleRuns.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </ul>
      )}
    </div>
  );
}
