import { useState, useMemo, useEffect, useCallback, useRef, type KeyboardEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { MoveAgentDialog } from '@/components/MoveAgentDialog';
import { useTasksContext } from '@/lib/tasks-context';
import {
  groupTasksForSidebar,
  OTHER_GROUP_KEY,
  type SidebarItem,
  type SidebarGroup,
} from '@/lib/sidebar-utils';
import { useOrchestratorContext } from '@/lib/orchestrator-context';
import { api } from '@/lib/api';
import type { RunMode, TaskStatus, Agent } from '../../server/types';

const STORAGE_KEY = 'octomux-sidebar-collapsed';
const GROUP_COLLAPSE_PREFIX = 'octomux:sidebar:collapsed:';

function getInitialCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function getInitialGroupCollapsed(groupKey: string): boolean {
  try {
    return localStorage.getItem(GROUP_COLLAPSE_PREFIX + groupKey) === 'true';
  } catch {
    return false;
  }
}

// ─── Status Icons (both color AND shape — colorblind safe) ─────────────────

function StatusIcon({ item }: { item: SidebarItem }) {
  const effectiveStatus = item.derivedStatus ?? item.status;

  switch (effectiveStatus) {
    case 'working':
    case 'running':
      return (
        <span
          className="inline-block h-2 w-2 shrink-0 animate-pulse bg-[#22C55E]"
          style={{ borderRadius: '50%' }}
          aria-hidden="true"
          data-status-glyph="running"
        />
      );
    case 'setting_up':
      return (
        <span
          className="inline-block h-2 w-2 shrink-0 animate-pulse"
          style={{ borderRadius: '50%', backgroundColor: '#FFB800' }}
          aria-hidden="true"
          data-status-glyph="setting_up"
        />
      );
    case 'needs_attention':
      return (
        <svg
          className="h-4 w-4 shrink-0"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          data-status-glyph="needs-you"
        >
          <path
            d="M8 1.5l6.5 12H1.5L8 1.5z"
            stroke="#FFB800"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <line
            x1="8"
            y1="6"
            x2="8"
            y2="9.5"
            stroke="#FFB800"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle cx="8" cy="11.5" r="0.75" fill="#FFB800" />
        </svg>
      );
    case 'error':
      return (
        <svg
          className="h-4 w-4 shrink-0"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
          data-status-glyph="error"
        >
          <line
            x1="4"
            y1="4"
            x2="12"
            y2="12"
            stroke="#EF4444"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
          <line
            x1="12"
            y1="4"
            x2="4"
            y2="12"
            stroke="#EF4444"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      );
    default:
      return (
        <span
          className="inline-block h-2 w-2 shrink-0"
          style={{
            borderRadius: '50%',
            border: '1px solid #6a6a6a',
            backgroundColor: 'transparent',
          }}
          aria-hidden="true"
          data-status-glyph="idle"
        />
      );
  }
}

// ─── Run mode badge ────────────────────────────────────────────────────────

const RUN_MODE_LETTER: Record<RunMode, string> = {
  new: 'N',
  existing: 'E',
  none: 'Ø',
  scratch: 'S',
};

const RUN_MODE_TOOLTIP: Record<RunMode, string> = {
  new: 'New worktree',
  existing: 'Existing worktree',
  none: 'No worktree (working tree)',
  scratch: 'Scratch (no repo)',
};

function RunModeBadge({ mode }: { mode: RunMode }) {
  return (
    <span
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm"
      style={{
        fontSize: 9,
        fontWeight: 700,
        fontFamily: 'ui-monospace, SFMono-Regular, monospace',
        color: '#8a8a8a',
        backgroundColor: '#1a1a1a',
        border: '1px solid #2f2f2f',
      }}
      title={RUN_MODE_TOOLTIP[mode]}
      aria-label={RUN_MODE_TOOLTIP[mode]}
      data-run-mode={mode}
    >
      {RUN_MODE_LETTER[mode]}
    </span>
  );
}

// ─── Nav icons (inline SVGs, 16px) ──────────────────────────────────────────

function HomeIcon({ color }: { color: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      aria-hidden="true"
    >
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
  );
}

function TasksIcon({ color }: { color: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      aria-hidden="true"
    >
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

function TerminalIcon({ color }: { color: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      aria-hidden="true"
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function WorkspacesIcon({ color }: { color: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </svg>
  );
}

function SettingsIcon({ color }: { color: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

// ─── Static config ──────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { key: 'home', label: 'HOME', to: '/', Icon: HomeIcon },
  { key: 'tasks', label: 'TASKS', to: '/tasks', Icon: TasksIcon },
  { key: 'orchestrator', label: 'ORCHESTRATOR', to: '/chats/orchestrator', Icon: TerminalIcon },
  { key: 'settings', label: 'SETTINGS', to: '/settings', Icon: SettingsIcon },
] as const;

const MORE_ITEMS = [
  { key: 'workspaces', label: 'WORKSPACES', to: '/workspaces', Icon: WorkspacesIcon },
] as const;

// ─── Fork refusal helper ────────────────────────────────────────────────────

export function forkDisabledReason(item: SidebarItem): string | null {
  if (item.runMode === 'scratch') return 'Cannot fork a scratch task (no repo).';
  if (item.runMode === 'none')
    return 'Cannot fork a task that runs on the working tree (no branch).';
  if (item.status === 'draft') return 'Cannot fork a draft task (no branch yet).';
  return null;
}

// ─── URL builders ───────────────────────────────────────────────────────────

function buildGroupAddUrl(repoPath: string): string {
  const params = new URLSearchParams({ repo: repoPath, mode: 'new' });
  return `/?${params.toString()}`;
}

function buildForkUrl(item: SidebarItem): string {
  const params = new URLSearchParams({
    repo: item.repoPath ?? '',
    base_branch: `agents/${item.id}`,
    mode: 'new',
    fork_of: item.id,
  });
  return `/?${params.toString()}`;
}

function buildAddAgentUrl(taskId: string): string {
  return `/?add_agent=${encodeURIComponent(taskId)}`;
}

// ─── Row menu ───────────────────────────────────────────────────────────────

interface RowMenuProps {
  item: SidebarItem;
  onOpen: () => void;
  onFork: () => void;
  onAddAgent: () => void;
  onRename: () => void;
  onClose: () => void;
  onDelete: () => void;
}

function RowMenu({ item, onOpen, onFork, onAddAgent, onRename, onClose, onDelete }: RowMenuProps) {
  const forkDisabled = forkDisabledReason(item);
  const closeDisabled = (['closed', 'draft'] as TaskStatus[]).includes(item.status);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside click or Escape
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: globalThis.MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function choose(action?: () => void) {
    if (!action) return;
    setOpen(false);
    action();
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-label="Task actions"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Task actions"
        data-testid={`task-row-menu-trigger-${item.id}`}
        className={
          'flex h-5 w-5 items-center justify-center text-[#8a8a8a] hover:text-white ' +
          (open ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100')
        }
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="12" cy="19" r="1.5" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          data-testid={`task-row-menu-${item.id}`}
          className="absolute right-0 top-full z-50 mt-1 min-w-44 bg-[#141414] border border-border py-1 text-sm outline-hidden"
        >
          <MenuItemRow onClick={() => choose(onOpen)} label="Open" />
          <MenuItemRow
            onClick={() => choose(onFork)}
            disabled={!!forkDisabled}
            title={forkDisabled ?? undefined}
            label="Fork into new task"
          />
          <MenuItemRow onClick={() => choose(onAddAgent)} label="Add agent…" />
          <div className="my-1 h-px bg-[#2f2f2f]" />
          <MenuItemRow onClick={() => choose(onRename)} label="Rename" />
          <MenuItemRow onClick={() => choose(onClose)} disabled={closeDisabled} label="Close" />
          <MenuItemRow onClick={() => choose(onDelete)} label="Delete" destructive />
        </div>
      )}
    </div>
  );
}

function MenuItemRow({
  onClick,
  label,
  disabled = false,
  destructive = false,
  title,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={
        'block w-full px-3 py-1.5 text-left text-xs ' +
        (disabled
          ? 'cursor-not-allowed text-[#555]'
          : destructive
            ? 'text-[#EF4444] hover:bg-[#1a1a1a]'
            : 'text-[#d0d0d0] hover:bg-[#1a1a1a]')
      }
    >
      {label}
    </button>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export function UniversalSidebar() {
  const [collapsed, setCollapsed] = useState(getInitialCollapsed);
  const { tasks, refresh } = useTasksContext();
  const location = useLocation();
  const navigate = useNavigate();
  const { running: orchestratorRunning } = useOrchestratorContext();

  // Track renaming state per task id
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // Track per-group collapse state
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  // Extract task ID from URL — useParams doesn't work here since we're outside <Routes>
  const activeTaskId = useMemo(() => {
    const match = location.pathname.match(/^\/tasks\/([^/]+)/);
    return match?.[1] ?? null;
  }, [location.pathname]);

  const groups = useMemo(() => groupTasksForSidebar(tasks), [tasks]);

  // Hydrate collapsed state for new groups that appear
  useEffect(() => {
    setCollapsedGroups((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const group of groups) {
        if (!(group.key in next)) {
          next[group.key] = getInitialGroupCollapsed(group.key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [groups]);

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

  const toggleGroupCollapsed = useCallback((groupKey: string) => {
    setCollapsedGroups((prev) => {
      const next = !prev[groupKey];
      try {
        localStorage.setItem(GROUP_COLLAPSE_PREFIX + groupKey, String(next));
      } catch {
        // ignore
      }
      return { ...prev, [groupKey]: next };
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
    window.addEventListener('keydown', handleKeyDown as unknown as EventListener);
    return () => window.removeEventListener('keydown', handleKeyDown as unknown as EventListener);
  }, [toggleCollapsed]);

  // Active nav detection
  const activeNav = useMemo(() => {
    if (location.pathname === '/orchestrator' || location.pathname === '/chats/orchestrator')
      return 'orchestrator';
    if (location.pathname === '/settings') return 'settings';
    if (location.pathname === '/tasks' || location.pathname.startsWith('/tasks/')) return 'tasks';
    if (activeTaskId) return null;
    if (location.pathname === '/') return 'home';
    return null;
  }, [location.pathname, activeTaskId]);

  // ─── Row actions ──────────────────────────────────────────────────────────

  const handleClose = useCallback(
    async (id: string) => {
      try {
        await api.updateTask(id, { status: 'closed' });
        refresh();
      } catch (err) {
        console.error('Failed to close task:', err);
      }
    },
    [refresh],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await api.deleteTask(id);
        refresh();
      } catch (err) {
        console.error('Failed to delete task:', err);
      }
    },
    [refresh],
  );

  const handleRenameSubmit = useCallback(
    async (id: string, title: string) => {
      const trimmed = title.trim();
      setRenamingId(null);
      if (!trimmed) return;
      try {
        await api.updateTask(id, { title: trimmed });
        refresh();
      } catch (err) {
        console.error('Failed to rename task:', err);
      }
    },
    [refresh],
  );

  return (
    <nav
      aria-label="Sidebar"
      className="hidden md:flex flex-col overflow-y-auto overflow-x-hidden transition-[width] duration-150 ease-out"
      style={{
        width: collapsed ? 48 : 240,
        backgroundColor: '#080808',
        borderRight: '1px solid #2f2f2f',
      }}
    >
      {/* Logo row */}
      {collapsed ? (
        <button
          onClick={toggleCollapsed}
          className="flex shrink-0 items-center justify-center py-4 hover:opacity-80"
          style={{ height: 48 }}
          aria-label="Expand sidebar"
        >
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center bg-[#3B82F6]"
            style={{ borderRadius: '50%' }}
          >
            <img src="/logo.png" alt="octomux" className="h-4 w-4 brightness-0 invert" />
          </span>
        </button>
      ) : (
        <div
          className="flex shrink-0 items-center justify-between"
          style={{ padding: '24px 20px' }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <img
              src="/logo.png"
              alt="octomux"
              className="h-5 w-5"
              style={{
                filter:
                  'brightness(0) saturate(100%) invert(45%) sepia(98%) saturate(2000%) hue-rotate(210deg) brightness(100%) contrast(96%)',
              }}
            />
            <span
              className="font-sans font-semibold text-white"
              style={{ fontSize: 16, letterSpacing: 1 }}
            >
              OCTOMUX
            </span>
            <span style={{ fontSize: 11, color: '#6a6a6a' }}>v2.0</span>
          </div>
          <button
            onClick={toggleCollapsed}
            className="p-1 hover:opacity-80"
            aria-label="Collapse sidebar"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#6a6a6a"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        </div>
      )}

      {/* Navigation section */}
      <div style={{ paddingBottom: 24 }}>
        {!collapsed && (
          <div
            className="font-bold uppercase tracking-wider"
            style={{
              fontSize: 10,
              color: '#6a6a6a',
              padding: '0 20px 8px',
            }}
          >
            {'// NAVIGATION'}
          </div>
        )}
        {NAV_ITEMS.map(({ key, label, to, Icon }) => {
          const isActive = activeNav === key;
          const color = isActive ? '#3B82F6' : '#8a8a8a';
          return (
            <Link
              key={key}
              to={to}
              className="flex items-center"
              style={{
                padding: collapsed ? '12px 0' : '12px 20px',
                gap: 12,
                backgroundColor: isActive ? '#3B82F620' : 'transparent',
                color,
                fontWeight: isActive ? 700 : 500,
                fontSize: 13,
                justifyContent: collapsed
                  ? 'center'
                  : key === 'orchestrator'
                    ? 'space-between'
                    : undefined,
              }}
            >
              {collapsed ? (
                <Icon color={color} />
              ) : (
                <>
                  <span className="flex items-center" style={{ gap: 12 }}>
                    <Icon color={color} />
                    {label}
                  </span>
                  {key === 'orchestrator' && orchestratorRunning && (
                    <span
                      className="shrink-0 rounded-full"
                      style={{ width: 6, height: 6, backgroundColor: '#22C55E' }}
                      aria-label="Orchestrator running"
                    />
                  )}
                </>
              )}
            </Link>
          );
        })}
      </div>

      {/* More (secondary nav: workspaces, etc.) */}
      <MoreSection collapsed={collapsed} activePath={location.pathname} />

      {/* Chats section (non-orchestrator standalone agents) */}
      <ChatsSection collapsed={collapsed} activePath={location.pathname} />

      {/* Task groups */}
      <div className="flex-1">
        {groups.map((group) => (
          <SidebarGroupView
            key={group.key}
            group={group}
            collapsed={collapsed}
            groupCollapsed={collapsedGroups[group.key] ?? false}
            activeTaskId={activeTaskId}
            renamingId={renamingId}
            onToggleGroup={() => toggleGroupCollapsed(group.key)}
            onAddTask={() => {
              if (group.key === OTHER_GROUP_KEY) return;
              navigate(buildGroupAddUrl(group.key));
            }}
            onOpenRow={(id) => navigate(`/tasks/${id}`)}
            onFork={(item) => navigate(buildForkUrl(item))}
            onAddAgent={(id) => navigate(buildAddAgentUrl(id))}
            onStartRename={(id) => setRenamingId(id)}
            onCancelRename={() => setRenamingId(null)}
            onSubmitRename={handleRenameSubmit}
            onClose={handleClose}
            onDelete={handleDelete}
          />
        ))}
      </div>
    </nav>
  );
}

// ─── Group View ─────────────────────────────────────────────────────────────

interface SidebarGroupViewProps {
  group: SidebarGroup;
  collapsed: boolean;
  groupCollapsed: boolean;
  activeTaskId: string | null;
  renamingId: string | null;
  onToggleGroup: () => void;
  onAddTask: () => void;
  onOpenRow: (id: string) => void;
  onFork: (item: SidebarItem) => void;
  onAddAgent: (id: string) => void;
  onStartRename: (id: string) => void;
  onCancelRename: () => void;
  onSubmitRename: (id: string, title: string) => void;
  onClose: (id: string) => void;
  onDelete: (id: string) => void;
}

function SidebarGroupView({
  group,
  collapsed,
  groupCollapsed,
  activeTaskId,
  renamingId,
  onToggleGroup,
  onAddTask,
  onOpenRow,
  onFork,
  onAddAgent,
  onStartRename,
  onCancelRename,
  onSubmitRename,
  onClose,
  onDelete,
}: SidebarGroupViewProps) {
  const isOther = group.key === OTHER_GROUP_KEY;

  return (
    <div style={{ paddingBottom: 16 }}>
      {!collapsed && (
        <div
          className="group/header flex items-center justify-between"
          style={{ padding: '0 20px 8px' }}
        >
          <button
            type="button"
            onClick={onToggleGroup}
            className="flex items-center gap-1.5 font-bold uppercase tracking-wider hover:text-white"
            style={{ fontSize: 10, color: '#6a6a6a' }}
            aria-expanded={!groupCollapsed}
            aria-controls={`sidebar-group-${group.key}`}
          >
            <svg
              width="8"
              height="8"
              viewBox="0 0 8 8"
              fill="none"
              aria-hidden="true"
              style={{
                transform: groupCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                transition: 'transform 120ms',
              }}
            >
              <path
                d="M1.5 2.5 4 5l2.5-2.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>{group.repo.toUpperCase()}</span>
          </button>
          {!isOther && (
            <button
              type="button"
              onClick={onAddTask}
              aria-label={`New task in ${group.repo}`}
              title={`New task in ${group.repo}`}
              data-testid={`sidebar-group-add-${group.key}`}
              className="flex h-4 w-4 items-center justify-center text-[#6a6a6a] opacity-0 hover:text-white group-hover/header:opacity-100"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                <line
                  x1="5"
                  y1="1"
                  x2="5"
                  y2="9"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
                <line
                  x1="1"
                  y1="5"
                  x2="9"
                  y2="5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
        </div>
      )}
      {!groupCollapsed && (
        <div id={`sidebar-group-${group.key}`}>
          {group.items.map((item) => (
            <SessionRow
              key={item.id}
              item={item}
              collapsed={collapsed}
              isActive={item.id === activeTaskId}
              isRenaming={renamingId === item.id}
              onOpen={() => onOpenRow(item.id)}
              onFork={() => onFork(item)}
              onAddAgent={() => onAddAgent(item.id)}
              onStartRename={() => onStartRename(item.id)}
              onCancelRename={onCancelRename}
              onSubmitRename={(title) => onSubmitRename(item.id, title)}
              onClose={() => onClose(item.id)}
              onDelete={() => onDelete(item.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Session Row ───────────────────────────────────────────────────────────

interface SessionRowProps {
  item: SidebarItem;
  collapsed: boolean;
  isActive: boolean;
  isRenaming: boolean;
  onOpen: () => void;
  onFork: () => void;
  onAddAgent: () => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onSubmitRename: (title: string) => void;
  onClose: () => void;
  onDelete: () => void;
}

function SessionRow({
  item,
  collapsed,
  isActive,
  isRenaming,
  onOpen,
  onFork,
  onAddAgent,
  onStartRename,
  onCancelRename,
  onSubmitRename,
  onClose,
  onDelete,
}: SessionRowProps) {
  if (collapsed) {
    return (
      <Link
        to={`/tasks/${item.id}`}
        aria-current={isActive ? 'page' : undefined}
        title={item.title}
        className="flex items-center"
        style={{
          padding: '10px 0',
          gap: 10,
          backgroundColor: isActive ? '#3B82F620' : 'transparent',
          justifyContent: 'center',
        }}
      >
        <StatusIcon item={item} />
      </Link>
    );
  }

  return (
    <div
      className="group/row flex items-center"
      data-testid={`sidebar-row-${item.id}`}
      data-run-mode={item.runMode}
      style={{
        padding: '6px 20px',
        gap: 8,
        backgroundColor: isActive ? '#3B82F620' : 'transparent',
      }}
    >
      <StatusIcon item={item} />
      <RunModeBadge mode={item.runMode} />
      {isRenaming ? (
        <RenameInput initial={item.title} onSubmit={onSubmitRename} onCancel={onCancelRename} />
      ) : (
        <Link
          to={`/tasks/${item.id}`}
          aria-current={isActive ? 'page' : undefined}
          className="min-w-0 flex-1 truncate font-medium"
          style={{
            fontSize: 11,
            color: isActive ? '#3B82F6' : '#8a8a8a',
          }}
        >
          {item.title}
        </Link>
      )}
      {!isRenaming && (
        <RowMenu
          item={item}
          onOpen={onOpen}
          onFork={onFork}
          onAddAgent={onAddAgent}
          onRename={onStartRename}
          onClose={onClose}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}

function RenameInput({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);

  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onSubmit(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onSubmit(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      className="min-w-0 flex-1 bg-[#141414] px-1.5 py-0.5 font-medium text-white outline-none"
      style={{ fontSize: 11, border: '1px solid #3B82F6' }}
      aria-label="Rename task"
      data-testid="sidebar-rename-input"
    />
  );
}

// ─── More (collapsible secondary nav) ──────────────────────────────────────

const MORE_STORAGE_KEY = 'octomux:sidebar:more-open';

function MoreSection({ collapsed, activePath }: { collapsed: boolean; activePath: string }) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(MORE_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(MORE_STORAGE_KEY, String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  if (collapsed) {
    return (
      <div style={{ paddingBottom: 16 }}>
        {MORE_ITEMS.map(({ key, to, Icon, label }) => {
          const isActive = activePath === to || activePath.startsWith(to + '/');
          const color = isActive ? '#3B82F6' : '#8a8a8a';
          return (
            <Link
              key={key}
              to={to}
              title={label}
              className="flex items-center"
              style={{
                padding: '12px 0',
                justifyContent: 'center',
                backgroundColor: isActive ? '#3B82F620' : 'transparent',
              }}
            >
              <Icon color={color} />
            </Link>
          );
        })}
      </div>
    );
  }

  return (
    <div style={{ paddingBottom: 16 }}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        data-testid="sidebar-more-toggle"
        className="flex w-full items-center justify-between font-bold uppercase tracking-wider hover:text-white"
        style={{ fontSize: 10, color: '#6a6a6a', padding: '0 20px 8px' }}
      >
        <span>{'// MORE'}</span>
        <span
          style={{
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
            transition: 'transform 120ms',
            display: 'inline-block',
          }}
        >
          ⌄
        </span>
      </button>
      {open &&
        MORE_ITEMS.map(({ key, to, Icon, label }) => {
          const isActive = activePath === to || activePath.startsWith(to + '/');
          const color = isActive ? '#3B82F6' : '#8a8a8a';
          return (
            <Link
              key={key}
              to={to}
              className="flex items-center"
              style={{
                padding: '10px 20px',
                gap: 12,
                backgroundColor: isActive ? '#3B82F620' : 'transparent',
                color,
                fontWeight: isActive ? 700 : 500,
                fontSize: 12,
              }}
            >
              <Icon color={color} />
              {label}
            </Link>
          );
        })}
    </div>
  );
}

// ─── Chats section ─────────────────────────────────────────────────────────

/**
 * Lists standalone runtime agents ("chats"). The orchestrator is already shown
 * in the NAVIGATION section, so it's excluded here. Row click → /chats/:id.
 */
function ChatsSection({ collapsed, activePath }: { collapsed: boolean; activePath: string }) {
  const [chats, setChats] = useState<Agent[]>([]);
  const [movingAgentId, setMovingAgentId] = useState<string | null>(null);

  const loadChats = useCallback(async () => {
    try {
      const res = await fetch('/api/chats');
      if (!res.ok) return;
      const rows = (await res.json()) as Agent[];
      setChats(rows.filter((c) => c.id !== 'orchestrator'));
    } catch {
      // silent — sidebar is non-critical
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await loadChats();
    };
    void tick();
    const interval = setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [loadChats]);

  if (chats.length === 0 && !movingAgentId) return null;

  return (
    <div style={{ paddingBottom: 16 }}>
      {!collapsed && chats.length > 0 && (
        <div
          className="font-bold uppercase tracking-wider"
          style={{ fontSize: 10, color: '#6a6a6a', padding: '0 20px 8px' }}
        >
          {'// CHATS'}
        </div>
      )}
      {chats.map((chat) => {
        const to = `/chats/${chat.id}`;
        const isActive = activePath === to;
        const color = isActive ? '#3B82F6' : '#8a8a8a';
        if (collapsed) {
          return (
            <Link
              key={chat.id}
              to={to}
              className="flex items-center"
              style={{
                padding: '8px 0',
                gap: 12,
                backgroundColor: isActive ? '#3B82F620' : 'transparent',
                color,
                justifyContent: 'center',
              }}
            >
              💬
            </Link>
          );
        }
        return (
          <div
            key={chat.id}
            className="group/chatrow flex items-center"
            style={{
              padding: '8px 20px',
              gap: 8,
              backgroundColor: isActive ? '#3B82F620' : 'transparent',
            }}
          >
            <Link
              to={to}
              className="min-w-0 flex-1 truncate"
              style={{
                color,
                fontWeight: isActive ? 700 : 500,
                fontSize: 12,
              }}
            >
              {chat.label}
            </Link>
            <ChatRowMenu chatId={chat.id} onMoveToTask={() => setMovingAgentId(chat.id)} />
          </div>
        );
      })}
      {movingAgentId && (
        <MoveAgentDialog
          open={!!movingAgentId}
          onOpenChange={(open) => !open && setMovingAgentId(null)}
          agentId={movingAgentId}
          currentTaskId={null}
          agentLabel={chats.find((c) => c.id === movingAgentId)?.label ?? 'chat'}
          onMoved={() => {
            setMovingAgentId(null);
            void loadChats();
          }}
        />
      )}
    </div>
  );
}

function ChatRowMenu({ chatId, onMoveToTask }: { chatId: string; onMoveToTask: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: globalThis.MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Chat actions"
        data-testid={`chat-row-menu-${chatId}`}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen((v) => !v);
        }}
        className={
          'flex h-5 w-5 items-center justify-center text-[#8a8a8a] hover:text-white ' +
          (open ? 'opacity-100' : 'opacity-0 group-hover/chatrow:opacity-100')
        }
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="12" cy="19" r="1.5" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          data-testid={`chat-row-menu-items-${chatId}`}
          className="absolute right-0 top-full z-50 mt-1 min-w-44 bg-[#141414] border border-border py-1 text-xs outline-none"
        >
          <button
            role="menuitem"
            className="block w-full px-3 py-1.5 text-left text-[#d0d0d0] hover:bg-[#1a1a1a]"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onMoveToTask();
            }}
          >
            Move to task…
          </button>
        </div>
      )}
    </div>
  );
}
