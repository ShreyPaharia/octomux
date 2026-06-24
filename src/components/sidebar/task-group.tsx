import { useState } from 'react';
import { Link } from 'react-router-dom';
import { OTHER_GROUP_KEY, type SidebarItem, type SidebarGroup } from '@/lib/sidebar-utils';
import { ACTIVE_FILL, FOCUS_RING, NAV_INACTIVE_FG, RAIL_TILE_SIZE } from './constants';
import { RunModeBadge, StatusIcon } from './glyphs';
import { RowMenu } from './row-menu';

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

export function SidebarGroupView({
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
    <div style={{ paddingBottom: 12 }}>
      {!collapsed && (
        <div
          className="group/header flex items-center justify-between"
          style={{ padding: '0 20px 6px' }}
        >
          <button
            type="button"
            onClick={onToggleGroup}
            className={`flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-muted-soft hover:text-white rounded-[4px] ${FOCUS_RING}`}
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
            <span>{group.repo}</span>
            <span
              aria-hidden="true"
              data-testid={`sidebar-group-count-${group.key}`}
              className="inline-flex items-center justify-center font-mono"
              style={{
                minWidth: 16,
                height: 14,
                padding: '0 4px',
                borderRadius: 3,
                fontSize: 9,
                fontWeight: 600,
                backgroundColor: 'rgba(255,255,255,0.06)',
                color: 'rgba(255,255,255,0.55)',
              }}
            >
              {group.items.length}
            </span>
          </button>
          {!isOther && (
            <button
              type="button"
              onClick={onAddTask}
              aria-label={`New task in ${group.repo}`}
              title={`New task in ${group.repo}`}
              data-testid={`sidebar-group-add-${group.key}`}
              className={`flex h-4 w-4 items-center justify-center rounded-[4px] text-[rgba(255,255,255,0.4)] opacity-0 hover:text-white group-hover/header:opacity-100 ${FOCUS_RING}`}
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
      <div className="flex justify-center py-1">
        <Link
          to={`/tasks/${item.id}`}
          aria-current={isActive ? 'page' : undefined}
          title={item.title}
          data-testid={`sidebar-row-${item.id}-collapsed`}
          className={`flex items-center justify-center ${FOCUS_RING}`}
          style={{
            width: RAIL_TILE_SIZE,
            height: 28,
            borderRadius: 8,
            backgroundColor: isActive ? ACTIVE_FILL : 'transparent',
          }}
        >
          <StatusIcon item={item} />
        </Link>
      </div>
    );
  }

  return (
    <div style={{ padding: '2px 12px' }}>
      <div
        className="group/row flex items-center hover:bg-white/[0.04]"
        data-testid={`sidebar-row-${item.id}`}
        data-run-mode={item.runMode}
        data-active={isActive || undefined}
        style={{
          padding: '6px 10px',
          gap: 8,
          borderRadius: 8,
          backgroundColor: isActive ? ACTIVE_FILL : 'transparent',
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
            title={item.title}
            aria-label={item.title}
            className={`min-w-0 flex-1 truncate font-medium rounded-[4px] ${FOCUS_RING}`}
            style={{
              fontSize: 11,
              color: isActive ? '#3B82F6' : NAV_INACTIVE_FG,
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
      className="min-w-0 flex-1 px-1.5 py-0.5 font-medium text-white outline-none rounded-[4px]"
      style={{
        fontSize: 11,
        backgroundColor: 'rgba(255,255,255,0.06)',
        border: '1px solid #3B82F6',
      }}
      aria-label="Rename task"
      data-testid="sidebar-rename-input"
    />
  );
}
