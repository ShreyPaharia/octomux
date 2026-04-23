import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTasksContext } from '@/lib/tasks-context';
import { repoName } from '@/lib/utils';
import type { Task } from '../../server/types';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Scored {
  task: Task;
  score: number;
}

function scoreMatch(haystack: string, needle: string): number {
  if (!needle) return 1;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  const idx = h.indexOf(n);
  if (idx !== -1) return 1 - idx / (haystack.length + 1);
  // Subsequence fallback (characters appear in order, not adjacent).
  let i = 0;
  for (const ch of h) {
    if (ch === n[i]) i++;
    if (i === n.length) return 0.1;
  }
  return -1;
}

const OPEN_STATUSES = new Set(['running', 'setting_up', 'error']);

export function CommandPalette({ open, onClose }: Props) {
  const navigate = useNavigate();
  const { tasks } = useTasksContext();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    // Focus after render so input exists in the DOM.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const results = useMemo<Scored[]>(() => {
    const openTasks = tasks.filter((t) => OPEN_STATUSES.has(t.status));
    if (!query) return openTasks.slice(0, 50).map((t) => ({ task: t, score: 1 }));
    const scored: Scored[] = [];
    for (const t of openTasks) {
      const hay = `${t.title} ${t.repo_path ? repoName(t.repo_path) : ''}`;
      const s = scoreMatch(hay, query);
      if (s >= 0) scored.push({ task: t, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 50);
  }, [tasks, query]);

  useEffect(() => {
    if (active >= results.length) setActive(Math.max(0, results.length - 1));
  }, [results.length, active]);

  if (!open) return null;

  const select = (task: Task) => {
    onClose();
    navigate(`/tasks/${task.id}`);
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('focus-terminal'));
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(Math.max(results.length - 1, 0), a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[active];
      if (r) select(r.task);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      role="presentation"
      data-testid="command-palette-backdrop"
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 pt-[10vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid="command-palette"
        className="w-full max-w-xl border border-border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
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
          placeholder="Jump to session…"
          aria-label="Search sessions"
          data-testid="command-palette-input"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none"
        />
        <ul
          role="listbox"
          aria-label="Sessions"
          data-testid="command-palette-results"
          className="max-h-[60vh] overflow-y-auto"
        >
          {results.length === 0 && (
            <li className="px-4 py-3 text-xs text-muted-foreground" aria-live="polite">
              No sessions match
            </li>
          )}
          {results.map(({ task }, i) => (
            <li
              key={task.id}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                select(task);
              }}
              onMouseEnter={() => setActive(i)}
              data-testid={`command-palette-result-${task.id}`}
              className={`cursor-pointer px-4 py-2 text-sm ${
                i === active ? 'bg-muted text-foreground' : 'text-muted-foreground'
              }`}
            >
              <div className="flex items-center gap-2">
                <StatusGlyph status={task.status} />
                <span className="min-w-0 flex-1 truncate font-medium">{task.title}</span>
                {task.repo_path && (
                  <span className="truncate text-xs text-muted-foreground">
                    {repoName(task.repo_path)}
                  </span>
                )}
                <span className="rounded-sm border border-border px-1 text-[10px] font-mono uppercase">
                  {task.run_mode}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function StatusGlyph({ status }: { status: string }) {
  const color = status === 'running' ? '#22C55E' : status === 'error' ? '#EF4444' : '#FFB800';
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}
