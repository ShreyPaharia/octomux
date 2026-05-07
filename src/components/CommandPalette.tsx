import { useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTasksContext } from '@/lib/tasks-context';
import { repoName } from '@/lib/utils';
import { StatusGlyph } from '@/components/ui/status-glyph';
import { api } from '@/lib/api';
import type { Task } from '../../server/types';
import type { WorkflowStatus } from '../../server/types';

const WORKFLOW_STATUS_LABELS: Record<WorkflowStatus, string> = {
  backlog: 'Backlog',
  planned: 'Planned',
  in_progress: 'In Progress',
  human_review: 'Human Review',
  pr: 'PR',
  done: 'Done',
};

const ALL_WORKFLOW_STATUSES: WorkflowStatus[] = [
  'backlog',
  'planned',
  'in_progress',
  'human_review',
  'pr',
  'done',
];

type SessionRow = { kind: 'session'; task: Task };
type ActionRow = {
  kind: 'action';
  id: string;
  label: string;
  run: () => void;
};
type EscapeRow = { kind: 'escape'; query: string };
type Row = SessionRow | ActionRow | EscapeRow;

function scoreMatch(haystack: string, needle: string): number {
  if (!needle) return 1;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  const idx = h.indexOf(n);
  if (idx !== -1) return 1 - idx / (haystack.length + 1);
  let i = 0;
  for (const ch of h) {
    if (ch === n[i]) i++;
    if (i === n.length) return 0.1;
  }
  return -1;
}

const OPEN_STATUSES = new Set(['running', 'setting_up', 'error']);

function GroupHeader({ label, count }: { label: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 px-4 pt-3 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-[#6a6a6a]">
      <span>{label}</span>
      {count !== undefined && count > 0 && (
        <span className="font-mono text-[10px] font-bold text-[#6a6a6a]">{count}</span>
      )}
    </div>
  );
}

export function CommandPalette() {
  const navigate = useNavigate();
  const { tasks, refresh: refreshTasks } = useTasksContext();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectTask = (task: Task) => {
    setQuery('');
    setActive(0);
    navigate(`/tasks/${task.id}`);
  };

  const createFromQuery = (title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setQuery('');
    setActive(0);
    navigate('/', { replace: true });
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('focus-composer', { detail: { prefill: trimmed } }));
    });
  };

  const actionNewTask = () => {
    setQuery('');
    setActive(0);
    navigate('/', { replace: true });
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('focus-composer'));
    });
  };

  const moveTask = useCallback(
    async (task: Task, targetStatus: WorkflowStatus) => {
      setQuery('');
      setActive(0);
      try {
        await api.moveTask(task.id, { workflow_status: targetStatus });
        refreshTasks?.();
      } catch {
        // swallow — UI will show current state
      }
    },
    [refreshTasks],
  );

  const sessionRows = useMemo<SessionRow[]>(() => {
    const openTasks = tasks.filter((t) => OPEN_STATUSES.has(t.status));
    if (!query) return [];
    const scored: { task: Task; score: number }[] = [];
    for (const t of openTasks) {
      const hay = `${t.title} ${t.repo_path ? repoName(t.repo_path) : ''}`;
      const s = scoreMatch(hay, query);
      if (s >= 0) scored.push({ task: t, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 50).map(({ task }) => ({ kind: 'session' as const, task }));
  }, [tasks, query]);

  const actionRows = useMemo<ActionRow[]>(() => {
    const base: ActionRow[] = [
      { kind: 'action', id: 'new-task', label: 'New task', run: actionNewTask },
    ];

    // Add "Move task: <task> → <column>" entries for all tasks
    for (const task of tasks) {
      for (const status of ALL_WORKFLOW_STATUSES) {
        if (task.workflow_status === status) continue;
        const label = `Move task: ${task.title} → ${WORKFLOW_STATUS_LABELS[status]}`;
        base.push({
          kind: 'action',
          id: `move-task-${task.id}-${status}`,
          label,
          run: () => moveTask(task, status),
        });
      }
    }

    if (!query) return [];
    const scored: { row: ActionRow; score: number }[] = [];
    for (const row of base) {
      const s = scoreMatch(row.label, query);
      if (s >= 0) scored.push({ row, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.row);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tasks, moveTask]);

  const rows = useMemo<Row[]>(() => {
    if (!query.trim()) return [];
    if (sessionRows.length === 0 && actionRows.length === 0) {
      return [{ kind: 'escape', query: query.trim() }];
    }
    return [...sessionRows, ...actionRows];
  }, [sessionRows, actionRows, query]);

  const runRow = (row: Row) => {
    if (row.kind === 'session') selectTask(row.task);
    else if (row.kind === 'action') row.run();
    else if (row.kind === 'escape') createFromQuery(row.query);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (rows.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(rows.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[active];
      if (r) runRow(r);
    }
  };

  let cursor = 0;
  const sessionsFrom = cursor;
  cursor += sessionRows.length;
  const actionsFrom = cursor;

  const showResults = query.trim().length > 0;

  return (
    <div data-testid="command-palette" className="flex w-full flex-col">
      <div className="flex items-center gap-3 rounded-lg border border-glass-edge bg-glass-l1 px-3 py-2">
        <span aria-hidden className="text-[13px] text-[#6a6a6a]">
          ⌕
        </span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search tasks…"
          aria-label="Search tasks"
          data-testid="command-palette-input"
          className="focus-ring w-full bg-transparent text-sm text-white caret-[#60a5fa] placeholder:text-[#6a6a6a] outline-none"
          style={{ caretColor: '#60a5fa' }}
        />
      </div>

      {showResults && (
        <ul
          role="listbox"
          aria-label="Results"
          data-testid="command-palette-results"
          className="mt-2 max-h-[60vh] overflow-y-auto rounded-lg border border-glass-edge bg-glass-l1"
        >
          {sessionRows.length > 0 && (
            <GroupHeader label="OPEN SESSIONS" count={sessionRows.length} />
          )}
          {sessionRows.map((row, i) => {
            const idx = sessionsFrom + i;
            const isActive = idx === active;
            return (
              <SessionRowView
                key={row.task.id}
                task={row.task}
                active={isActive}
                onMouseEnter={() => setActive(idx)}
                onSelect={() => selectTask(row.task)}
              />
            );
          })}

          {actionRows.length > 0 && <GroupHeader label="ACTIONS" />}
          {actionRows.map((row, i) => {
            const idx = actionsFrom + i;
            const isActive = idx === active;
            return (
              <ActionRowView
                key={row.id}
                row={row}
                active={isActive}
                onMouseEnter={() => setActive(idx)}
              />
            );
          })}

          {rows.length === 1 && rows[0].kind === 'escape' && (
            <li
              data-testid="command-palette-no-results"
              className="flex flex-col items-center gap-3 px-4 py-6 text-center"
              aria-live="polite"
            >
              <h2 className="text-[15px] font-semibold text-[#D0D0D0]">No matches</h2>
              <EscapeChip
                query={(rows[0] as EscapeRow).query}
                active={active === 0}
                onMouseEnter={() => setActive(0)}
                onSelect={() => createFromQuery((rows[0] as EscapeRow).query)}
              />
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

const SELECTED_ROW_STYLE: React.CSSProperties = {
  backgroundColor: 'rgba(59, 130, 246, 0.12)',
  boxShadow: 'inset 0 0 0 1px rgba(59, 130, 246, 0.4)',
};

function rowClass(active: boolean) {
  return [
    'command-palette-row',
    active
      ? 'cursor-pointer rounded-lg px-4 py-2 text-sm text-foreground'
      : 'cursor-pointer rounded-lg px-4 py-2 text-sm text-muted-foreground',
    active ? 'command-palette-row--selected' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function SessionRowView({
  task,
  active,
  onMouseEnter,
  onSelect,
}: {
  task: Task;
  active: boolean;
  onMouseEnter: () => void;
  onSelect: () => void;
}) {
  return (
    <li
      role="option"
      aria-selected={active}
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect();
      }}
      onMouseEnter={onMouseEnter}
      data-testid={`command-palette-result-${task.id}`}
      data-row-kind="session"
      data-active={active ? 'true' : undefined}
      className={rowClass(active)}
      style={active ? SELECTED_ROW_STYLE : undefined}
    >
      <div className="flex items-center gap-2">
        <StatusGlyph status={task.status} size={10} />
        <span
          className="min-w-0 flex-1 truncate font-medium"
          title={task.title}
          aria-label={task.title}
        >
          {task.title}
        </span>
        {task.repo_path && (
          <span className="truncate text-xs text-muted-foreground">{repoName(task.repo_path)}</span>
        )}
      </div>
    </li>
  );
}

function ActionRowView({
  row,
  active,
  onMouseEnter,
}: {
  row: ActionRow;
  active: boolean;
  onMouseEnter: () => void;
}) {
  return (
    <li
      role="option"
      aria-selected={active}
      onMouseDown={(e) => {
        e.preventDefault();
        row.run();
      }}
      onMouseEnter={onMouseEnter}
      data-testid={`command-palette-action-${row.id}`}
      data-row-kind="action"
      data-active={active ? 'true' : undefined}
      className={rowClass(active)}
      style={active ? SELECTED_ROW_STYLE : undefined}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{row.label}</span>
      </div>
    </li>
  );
}

function EscapeChip({
  query,
  active,
  onMouseEnter,
  onSelect,
}: {
  query: string;
  active: boolean;
  onMouseEnter: () => void;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-selected={active}
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect();
      }}
      onMouseEnter={onMouseEnter}
      data-testid="command-palette-escape"
      data-row-kind="escape"
      data-active={active ? 'true' : undefined}
      className="inline-flex items-center gap-2 rounded-lg border border-[#3B82F666] bg-[#3B82F61F] px-3 py-1.5 text-[12px] font-medium text-[#3B82F6] hover:bg-[#3B82F633]"
    >
      <span>
        New task with <span className="text-white">'{query}'</span>
      </span>
    </button>
  );
}
