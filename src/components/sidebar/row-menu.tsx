import { useEffect, useRef, useState } from 'react';
import type { SidebarItem } from '@/lib/sidebar-utils';
import { FOCUS_RING } from './constants';
import { forkDisabledReason } from './nav-items';

interface RowMenuProps {
  item: SidebarItem;
  onOpen: () => void;
  onFork: () => void;
  onAddAgent: () => void;
  onRename: () => void;
  onClose: () => void;
  onDelete: () => void;
}

export function RowMenu({
  item,
  onOpen,
  onFork,
  onAddAgent,
  onRename,
  onClose,
  onDelete,
}: RowMenuProps) {
  const forkDisabled = forkDisabledReason(item);
  const closeDisabled = item.status === 'idle';
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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
          'flex h-5 w-5 items-center justify-center rounded-[4px] text-[#8a8a8a] hover:text-white ' +
          FOCUS_RING +
          ' ' +
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
          className="glass-blur-l1 absolute right-0 top-full z-50 mt-1 min-w-44 rounded-[8px] border py-1 text-sm outline-hidden"
          style={{
            backgroundColor: 'rgba(20,21,28,0.95)',
            borderColor: 'rgba(255,255,255,0.08)',
          }}
        >
          <MenuItemRow onClick={() => choose(onOpen)} label="Open" />
          <MenuItemRow
            onClick={() => choose(onFork)}
            disabled={!!forkDisabled}
            title={forkDisabled ?? undefined}
            label="Fork into new task"
          />
          <MenuItemRow onClick={() => choose(onAddAgent)} label="Add agent…" />
          <div className="my-1 h-px" style={{ backgroundColor: 'rgba(255,255,255,0.08)' }} />
          <MenuItemRow onClick={() => choose(onRename)} label="Rename" />
          <MenuItemRow onClick={() => choose(onClose)} disabled={closeDisabled} label="Done" />
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
            ? 'text-[#EF4444] hover:bg-white/[0.04]'
            : 'text-[#d0d0d0] hover:bg-white/[0.04]')
      }
    >
      {label}
    </button>
  );
}
