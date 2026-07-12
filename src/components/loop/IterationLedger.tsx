import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { DiffViewer } from '@/components/DiffViewer';
import type { LoopIteration } from '@/lib/api/loopApi';

interface IterationLedgerProps {
  taskId: string;
  iterations: LoopIteration[];
}

function verifyBadge(iteration: LoopIteration) {
  if (iteration.verify_passed === null) {
    return <Badge variant="secondary">pending</Badge>;
  }
  return iteration.verify_passed ? (
    <Badge variant="outline">verify pass</Badge>
  ) : (
    <Badge variant="destructive">verify fail</Badge>
  );
}

export function IterationLedger({ taskId, iterations }: IterationLedgerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = iterations.find((it) => it.id === selectedId) ?? null;

  if (iterations.length === 0) {
    return <p className="text-sm text-muted-foreground">No iterations yet.</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <ul className="flex shrink-0 flex-col gap-1.5" data-testid="iteration-ledger">
        {iterations.map((it) => {
          const rowSelected = it.id === selectedId;
          return (
            <li key={it.id}>
              <button
                type="button"
                data-testid={`iteration-row-${it.n}`}
                onClick={() => setSelectedId(it.id)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg border border-glass-edge bg-glass-l1 px-3 py-2 text-left transition-colors hover:bg-glass-l2/60',
                  rowSelected && 'border-primary bg-glass-l2/80',
                )}
              >
                <span className="w-8 shrink-0 font-mono text-xs text-muted-foreground">
                  #{it.n}
                </span>
                {verifyBadge(it)}
                <span className="text-xs text-muted-foreground">
                  {it.tokens != null ? `${it.tokens} tokens` : '—'}
                </span>
                {it.emit_status && (
                  <span className="ml-auto shrink-0 text-[11px] text-muted-soft">
                    {it.emit_status}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>

      {selected && (
        <div
          className="min-h-0 flex-1 overflow-hidden rounded-lg border border-glass-edge"
          data-testid="iteration-diff-pane"
        >
          <DiffViewer
            taskId={taskId}
            range={{ kind: 'range', from: selected.sha_from ?? '', to: selected.sha_to ?? '' }}
            hideFileTree
          />
        </div>
      )}
    </div>
  );
}
