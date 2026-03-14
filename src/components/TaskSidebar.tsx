import { useState, useMemo, useEffect, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTasks } from '@/lib/hooks';
import { groupTasksForSidebar, type SidebarItem } from '@/lib/sidebar-utils';

const STORAGE_KEY = 'octomux-sidebar-collapsed';

function getInitialCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

// ─── Status Icons (16x16 inline SVGs) ──────────────────────────────────────

function StatusIcon({ item }: { item: SidebarItem }) {
  const effectiveStatus = item.derivedStatus ?? item.status;

  switch (effectiveStatus) {
    case 'working':
    case 'running':
      return (
        <svg
          className="h-4 w-4 shrink-0 text-green-400 animate-spin"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
          <path
            d="M14 8a6 6 0 0 0-6-6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      );
    case 'setting_up':
      return (
        <svg
          className="h-4 w-4 shrink-0 text-yellow-400"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="4 2" />
        </svg>
      );
    case 'needs_attention':
      return (
        <svg
          className="h-4 w-4 shrink-0 text-amber-400"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M8 1.5l6.5 12H1.5L8 1.5z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <line x1="8" y1="6" x2="8" y2="9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="11.5" r="0.75" fill="currentColor" />
        </svg>
      );
    case 'error':
      return (
        <svg
          className="h-4 w-4 shrink-0 text-red-400"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg
          className="h-4 w-4 shrink-0 text-muted-foreground"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
  }
}

function statusLabel(item: SidebarItem): string {
  const effective = item.derivedStatus ?? item.status;
  switch (effective) {
    case 'working':
    case 'running':
      return 'Running';
    case 'setting_up':
      return 'Setting up';
    case 'needs_attention':
      return 'Needs attention';
    case 'error':
      return 'Error';
    default:
      return item.status;
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

export function TaskSidebar() {
  const [collapsed, setCollapsed] = useState(getInitialCollapsed);
  const { tasks } = useTasks();
  const { id: activeId } = useParams<{ id: string }>();

  const groups = useMemo(() => groupTasksForSidebar(tasks), [tasks]);

  const allItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const attentionCount = useMemo(
    () =>
      allItems.filter((i) => i.status === 'error' || i.derivedStatus === 'needs_attention').length,
    [allItems],
  );

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }, []);

  // Cmd/Ctrl+B keyboard shortcut
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        toggleCollapsed();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleCollapsed]);

  return (
    <nav
      aria-label="Task list"
      className="hidden md:flex flex-col border-r border-border bg-muted/30 overflow-y-auto overflow-x-hidden transition-[width] duration-150 ease-out"
      style={{ width: collapsed ? 48 : 240 }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 p-2 border-b border-border shrink-0">
        <button
          onClick={toggleCollapsed}
          className="p-1 rounded hover:bg-muted"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            {collapsed ? (
              <path
                d="M6 3l5 5-5 5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : (
              <path
                d="M10 3l-5 5 5 5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </svg>
        </button>
        {!collapsed && attentionCount > 0 && (
          <span
            data-testid="attention-count"
            className="ml-auto inline-flex items-center justify-center rounded-full bg-red-500/20 text-red-400 text-xs font-medium min-w-5 h-5 px-1.5"
          >
            {attentionCount}
          </span>
        )}
        {collapsed && attentionCount > 0 && (
          <span
            data-testid="attention-count"
            className="sr-only"
          >
            {attentionCount}
          </span>
        )}
      </div>

      {/* Task list */}
      <div className="flex-1 py-1">
        {groups.map((group) => (
          <div key={group.repo}>
            {!collapsed && (
              <div className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wider truncate">
                {group.repo}
              </div>
            )}
            {group.items.map((item) => {
              const isActive = item.id === activeId;
              return (
                <Link
                  key={item.id}
                  to={`/tasks/${item.id}`}
                  aria-current={isActive ? 'page' : undefined}
                  title={collapsed ? `${item.title} — ${statusLabel(item)}` : undefined}
                  className={`flex items-center gap-2 px-2 py-1.5 text-sm transition-colors hover:bg-muted/60 ${
                    isActive
                      ? 'bg-muted border-l-2 border-l-primary'
                      : 'border-l-2 border-l-transparent'
                  }`}
                >
                  <StatusIcon item={item} />
                  <span
                    className="truncate"
                    style={{
                      maxWidth: 180,
                      display: collapsed ? 'none' : undefined,
                    }}
                  >
                    {item.title}
                  </span>
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}
