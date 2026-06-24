import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTasks } from '@/lib/hooks';
import { clearDiffTreeExpandedState } from '@/lib/diff-tree-storage';
import { groupTasksForSidebar, OTHER_GROUP_KEY } from '@/lib/sidebar-utils';
import { taskApi } from '@/lib/api/taskApi';
import { SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_EXPANDED_WIDTH, FOCUS_RING } from './constants';
import { StatusIcon } from './glyphs';
import {
  NAV_ITEMS,
  activeTaskIdFromPath,
  buildAddAgentUrl,
  buildForkUrl,
  buildGroupAddUrl,
  deriveActiveNav,
  type NavKey,
} from './nav-items';
import { NavProvider, useNav } from './nav-context';
import { CollapsedNavTile, ExpandedNavRow, MoreSection } from './nav-rows';
import { SidebarGroupView } from './task-group';
import { ChatsSection } from './chats-section';
import { SidebarFooter } from './footer';

/**
 * Thin composition shell. Persisted nav state lives in `NavProvider`;
 * `activeNav`/`activeTaskId` stay derived from `useLocation()` here.
 */
export function UniversalSidebar() {
  return (
    <NavProvider>
      <SidebarShell />
    </NavProvider>
  );
}

function SidebarShell() {
  const { collapsed, toggleCollapsed, collapsedGroups, toggleGroupCollapsed, syncGroupKeys } =
    useNav();
  const { tasks, refresh } = useTasks();
  const location = useLocation();
  const navigate = useNavigate();

  const [renamingId, setRenamingId] = useState<string | null>(null);

  const activeTaskId = useMemo(() => activeTaskIdFromPath(location.pathname), [location.pathname]);

  const groups = useMemo(() => groupTasksForSidebar(tasks), [tasks]);

  useEffect(() => {
    syncGroupKeys(groups.map((g) => g.key));
  }, [groups, syncGroupKeys]);

  const activeNav = useMemo<NavKey | null>(
    () => deriveActiveNav(location.pathname, activeTaskId),
    [location.pathname, activeTaskId],
  );

  // ─── Row actions ──────────────────────────────────────────────────────────

  const handleClose = useCallback(
    async (id: string) => {
      try {
        await taskApi.moveTask(id, { workflow_status: 'done' });
        refresh();
      } catch (err) {
        console.error('Failed to mark task done:', err);
      }
    },
    [refresh],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await taskApi.deleteTask(id);
        clearDiffTreeExpandedState(id);
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
        await taskApi.updateTask(id, { title: trimmed });
        refresh();
      } catch (err) {
        console.error('Failed to rename task:', err);
      }
    },
    [refresh],
  );

  // Flat list of status glyphs for the collapsed-rail preview.
  const collapsedStatusPreview = useMemo(
    () =>
      groups
        .flatMap((g) => g.items)
        .filter((item) => {
          const s = item.derivedStatus ?? item.status;
          return s !== 'idle';
        })
        .slice(0, 6),
    [groups],
  );

  return (
    <nav
      aria-label="Sidebar"
      data-testid="universal-sidebar"
      className="glass-chrome glass-blur-l1 motion-sidebar hidden md:flex flex-col overflow-y-auto overflow-x-hidden border-r border-glass-edge"
      style={{
        width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH,
      }}
    >
      {/* Logo row */}
      {collapsed ? (
        <button
          onClick={toggleCollapsed}
          className={`flex shrink-0 items-center justify-center py-4 hover:opacity-80 ${FOCUS_RING}`}
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
          style={{ padding: '20px 20px 16px' }}
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
            <span className="font-display text-base font-semibold tracking-tight text-foreground">
              Octomux
            </span>
            <span className="text-[11px] text-muted-soft">v2.0</span>
          </div>
          <button
            onClick={toggleCollapsed}
            className={`p-1 rounded-[4px] hover:opacity-80 ${FOCUS_RING}`}
            aria-label="Collapse sidebar"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="rgba(255,255,255,0.45)"
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
      <div style={{ paddingBottom: 16 }}>
        {!collapsed && (
          <div
            className="text-[10px] font-medium tracking-wide text-muted-soft"
            style={{ padding: '0 20px 8px' }}
          >
            Navigation
          </div>
        )}
        {NAV_ITEMS.map(({ key, label, to, Icon }) => {
          const isActive = activeNav === key;
          const pretty = label.charAt(0) + label.slice(1).toLowerCase();
          return collapsed ? (
            <CollapsedNavTile
              key={key}
              to={to}
              Icon={Icon}
              isActive={isActive}
              tooltip={pretty}
              ariaLabel={pretty}
            />
          ) : (
            <ExpandedNavRow key={key} to={to} Icon={Icon} label={label} isActive={isActive} />
          );
        })}
      </div>

      {/* More (secondary nav: workspaces, etc.) */}
      <MoreSection collapsed={collapsed} activePath={location.pathname} />

      {/* Chats section (standalone runtime agents) */}
      <ChatsSection collapsed={collapsed} activePath={location.pathname} />

      {/* Collapsed-rail status preview */}
      {collapsed && collapsedStatusPreview.length > 0 && (
        <div
          className="mx-auto my-2 flex flex-col items-center gap-2 pt-3"
          style={{ borderTop: '1px solid rgba(255,255,255,0.08)', width: 24 }}
          data-testid="sidebar-status-preview"
        >
          {collapsedStatusPreview.map((item) => (
            <StatusIcon key={item.id} item={item} />
          ))}
        </div>
      )}

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

      {/* Footer strip */}
      <SidebarFooter collapsed={collapsed} />
    </nav>
  );
}
