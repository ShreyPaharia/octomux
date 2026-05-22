import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import { subscribe } from '@/lib/event-source';
import { timeAgo } from '@/lib/time';
import type { HookExecution } from '@/lib/api';

interface TaskHooksPanelProps {
  taskId: string;
}

export function TaskHooksPanel({ taskId }: TaskHooksPanelProps) {
  const [executions, setExecutions] = useState<HookExecution[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const data = await api.getTaskHookExecutions(taskId);
      setExecutions(data);
    } catch {
      // swallow
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    load();
    return subscribe((event) => {
      const affectedId = (event.payload as { taskId?: string }).taskId;
      if (affectedId === taskId) {
        load();
      }
    });
  }, [load, taskId]);

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
          Hook Runs
        </h2>
        <button
          type="button"
          onClick={load}
          className="ml-auto text-[10px] text-muted-soft hover:text-muted-foreground"
          aria-label="Refresh hook executions"
          data-testid="hooks-refresh-button"
        >
          ↺
        </button>
      </div>
      {loading ? (
        <div className="text-[11px] text-muted-soft">Loading…</div>
      ) : executions.length === 0 ? (
        <div className="text-[11px] text-muted-soft">No hook runs recorded.</div>
      ) : (
        <div className="flex flex-col gap-1">
          {executions.map((ex, i) => {
            const key = `${ex.event}-${ex.script}-${ex.started_at}-${i}`;
            const isExpanded = expanded.has(key);
            return (
              <HookExecutionRow
                key={key}
                execution={ex}
                expanded={isExpanded}
                onToggle={() => toggleExpanded(key)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function ExitBadge({ exitCode }: { exitCode: number | null }) {
  if (exitCode === null) {
    return (
      <span
        data-testid="hook-exit-badge-unknown"
        className="rounded px-1 py-0.5 text-[9px] font-bold bg-[rgba(255,255,255,0.05)] text-[#6a6a6a]"
      >
        ?
      </span>
    );
  }
  if (exitCode === 0) {
    return (
      <span
        data-testid="hook-exit-badge-ok"
        className="rounded px-1 py-0.5 text-[9px] font-bold bg-[rgba(34,197,94,0.15)] text-[#22C55E]"
      >
        ✓ {exitCode}
      </span>
    );
  }
  return (
    <span
      data-testid="hook-exit-badge-fail"
      className="rounded px-1 py-0.5 text-[9px] font-bold bg-[rgba(239,68,68,0.15)] text-[#EF4444]"
    >
      ✗ {exitCode}
    </span>
  );
}

function HookExecutionRow({
  execution,
  expanded,
  onToggle,
}: {
  execution: HookExecution;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="rounded-lg border border-glass-edge bg-glass-l1 px-3 py-2"
      data-testid="hook-execution-row"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="shrink-0 text-[10px] text-muted-soft">{expanded ? '▾' : '▸'}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
          {execution.event}
        </span>
        <span className="shrink-0 text-[10px] text-muted-soft">{execution.script}</span>
        {execution.duration_ms !== null && (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-soft">
            {execution.duration_ms}ms
          </span>
        )}
        <ExitBadge exitCode={execution.exit_code} />
        <span className="shrink-0 text-[10px] tabular-nums text-muted-soft">
          {timeAgo(execution.started_at)}
        </span>
      </button>
      {expanded && execution.stdout_excerpt && (
        <pre className="mt-2 overflow-x-auto rounded-lg border border-glass-edge bg-glass-l1 p-2 text-[10px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {execution.stdout_excerpt}
        </pre>
      )}
    </div>
  );
}
