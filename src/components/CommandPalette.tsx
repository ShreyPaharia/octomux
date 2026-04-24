import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTasksContext } from '@/lib/tasks-context';
import { repoName } from '@/lib/utils';
import { GlassPanel } from '@/components/ui/glass-panel';
import { StatusGlyph } from '@/components/ui/status-glyph';
import { api } from '@/lib/api';
import { showToast } from '@/components/CustomToast';
import type { Task } from '../../server/types';

interface Props {
  open: boolean;
  onClose: () => void;
}

type SessionRow = { kind: 'session'; task: Task };
type ActionRow = {
  kind: 'action';
  id: string;
  label: string;
  keycap: string;
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

const BACKDROP_STYLE: React.CSSProperties = {
  backgroundColor: 'rgba(0, 0, 0, 0.4)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
};

function Keycap({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="ml-auto inline-flex h-5 items-center gap-0.5 border border-glass-edge bg-glass-l1 px-1.5 font-mono text-[10px] text-[#b5b5bd]"
      style={{ boxShadow: 'inset 0 1px 0 0 rgba(255,255,255,0.12)' }}
    >
      {children}
    </span>
  );
}

function GroupHeader({ label }: { label: string }) {
  return (
    <div className="px-4 pt-3 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-[#6a6a6a]">
      {label}
    </div>
  );
}

export function CommandPalette({ open, onClose }: Props) {
  const navigate = useNavigate();
  const { tasks } = useTasksContext();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const selectTask = (task: Task) => {
    onClose();
    navigate(`/tasks/${task.id}`);
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('focus-terminal'));
    });
  };

  const createFromQuery = async (title: string) => {
    if (!title.trim() || creating) return;
    setCreating(true);
    try {
      const task = await api.createTask({
        title: title.trim(),
        description: title.trim(),
        initial_prompt: title.trim(),
        run_mode: 'scratch',
      });
      onClose();
      navigate(`/tasks/${task.id}`);
    } catch (err) {
      showToast('error', 'ERROR', err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setCreating(false);
    }
  };

  const actionNewTask = () => {
    onClose();
    navigate('/', { replace: true });
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('focus-composer'));
    });
  };

  const actionAttachTerminal = () => {
    onClose();
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('focus-terminal'));
    });
  };

  const actionToggleSidebar = () => {
    onClose();
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('toggle-sidebar'));
    });
  };

  const sessionRows = useMemo<SessionRow[]>(() => {
    const openTasks = tasks.filter((t) => OPEN_STATUSES.has(t.status));
    if (!query) {
      return openTasks.slice(0, 50).map((t) => ({ kind: 'session' as const, task: t }));
    }
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
      { kind: 'action', id: 'new-task', label: 'New task', keycap: '⌘N', run: actionNewTask },
      {
        kind: 'action',
        id: 'attach-terminal',
        label: 'Attach terminal',
        keycap: '⌘T',
        run: actionAttachTerminal,
      },
      {
        kind: 'action',
        id: 'toggle-sidebar',
        label: 'Toggle sidebar',
        keycap: '⌘B',
        run: actionToggleSidebar,
      },
    ];
    if (!query) return base;
    const scored: { row: ActionRow; score: number }[] = [];
    for (const row of base) {
      const s = scoreMatch(row.label, query);
      if (s >= 0) scored.push({ row, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.row);
    // action handlers are module-level closures; omit deps to keep list stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const rows = useMemo<Row[]>(() => {
    if (sessionRows.length === 0 && actionRows.length === 0 && query.trim()) {
      return [{ kind: 'escape', query: query.trim() }];
    }
    return [...sessionRows, ...actionRows];
  }, [sessionRows, actionRows, query]);

  useEffect(() => {
    if (active >= rows.length) setActive(Math.max(0, rows.length - 1));
  }, [rows.length, active]);

  if (!open) return null;

  const runRow = (row: Row) => {
    if (row.kind === 'session') selectTask(row.task);
    else if (row.kind === 'action') row.run();
    else if (row.kind === 'escape') createFromQuery(row.query);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(Math.max(rows.length - 1, 0), a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[active];
      if (r) runRow(r);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  let cursor = 0;
  const sessionsFrom = cursor;
  cursor += sessionRows.length;
  const actionsFrom = cursor;
  cursor += actionRows.length;

  return (
    <div
      role="presentation"
      data-testid="command-palette-backdrop"
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[10vh]"
      style={BACKDROP_STYLE}
      onClick={onClose}
    >
      <GlassPanel
        level={3}
        specular
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
        className="w-full max-w-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center gap-2 border-b border-glass-edge px-3"
          style={{ backgroundColor: '#0B0C0F' }}
        >
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="search tasks…"
            aria-label="Search tasks"
            data-testid="command-palette-input"
            className="focus-ring w-full bg-transparent px-1 py-3 text-sm text-white caret-[#60a5fa] placeholder:text-[#6a6a6a] outline-none"
            style={{ caretColor: '#60a5fa' }}
          />
          <Keycap>⌘K</Keycap>
        </div>

        <ul
          role="listbox"
          aria-label="Results"
          data-testid="command-palette-results"
          className="max-h-[60vh] overflow-y-auto"
        >
          {rows.length === 0 && (
            <li className="px-4 py-3 text-xs text-muted-foreground" aria-live="polite">
              No matches
            </li>
          )}

          {sessionRows.length > 0 && <GroupHeader label="OPEN SESSIONS" />}
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
            <EscapeRowView
              query={(rows[0] as EscapeRow).query}
              active={active === 0}
              disabled={creating}
              onMouseEnter={() => setActive(0)}
              onSelect={() => createFromQuery((rows[0] as EscapeRow).query)}
            />
          )}
        </ul>
      </GlassPanel>
    </div>
  );
}

const SELECTED_ROW_STYLE: React.CSSProperties = {
  backgroundColor: 'rgba(59, 130, 246, 0.12)',
  boxShadow: 'inset 0 0 0 1px rgba(59, 130, 246, 0.4)',
};

function rowClass(active: boolean, extra?: string) {
  return [
    'command-palette-row',
    active
      ? 'cursor-pointer px-4 py-2 text-sm text-foreground'
      : 'cursor-pointer px-4 py-2 text-sm text-muted-foreground',
    active ? 'command-palette-row--selected' : '',
    extra,
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
        <span className="min-w-0 flex-1 truncate font-medium">{task.title}</span>
        {task.repo_path && (
          <span className="truncate text-xs text-muted-foreground">{repoName(task.repo_path)}</span>
        )}
        <Keycap>↵</Keycap>
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
        <Keycap>{row.keycap}</Keycap>
      </div>
    </li>
  );
}

function EscapeRowView({
  query,
  active,
  disabled,
  onMouseEnter,
  onSelect,
}: {
  query: string;
  active: boolean;
  disabled: boolean;
  onMouseEnter: () => void;
  onSelect: () => void;
}) {
  return (
    <li
      role="option"
      aria-selected={active}
      onMouseDown={(e) => {
        e.preventDefault();
        if (!disabled) onSelect();
      }}
      onMouseEnter={onMouseEnter}
      data-testid="command-palette-escape"
      data-row-kind="escape"
      data-active={active ? 'true' : undefined}
      className={rowClass(active)}
      style={active ? SELECTED_ROW_STYLE : undefined}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">
          <span className="text-[#60a5fa]">⌘N</span> New task with{' '}
          <span className="text-white">'{query}'</span>
        </span>
        <Keycap>↵</Keycap>
      </div>
    </li>
  );
}
