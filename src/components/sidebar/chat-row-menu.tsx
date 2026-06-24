import { useEffect, useRef, useState } from 'react';
import { FOCUS_RING } from './constants';

export function ChatRowMenu({
  chatId,
  isClosed,
  onMoveToTask,
  onClose,
  onDelete,
}: {
  chatId: string;
  isClosed: boolean;
  onMoveToTask: () => void;
  onClose: () => void;
  onDelete: () => void;
}) {
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
          'flex h-5 w-5 items-center justify-center rounded-[4px] text-[#8a8a8a] hover:text-white ' +
          FOCUS_RING +
          ' ' +
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
          className="glass-blur-l1 absolute right-0 top-full z-50 mt-1 min-w-44 rounded-[8px] border py-1 text-xs outline-none"
          style={{
            backgroundColor: 'rgba(20,21,28,0.95)',
            borderColor: 'rgba(255,255,255,0.08)',
          }}
        >
          <button
            role="menuitem"
            className="block w-full px-3 py-1.5 text-left text-[#d0d0d0] hover:bg-white/[0.04]"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onMoveToTask();
            }}
          >
            Move to task…
          </button>
          {!isClosed && (
            <button
              role="menuitem"
              data-testid={`chat-row-close-${chatId}`}
              className="block w-full px-3 py-1.5 text-left text-[#d0d0d0] hover:bg-white/[0.04]"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onClose();
              }}
            >
              Close
            </button>
          )}
          <div className="my-1 h-px" style={{ backgroundColor: 'rgba(255,255,255,0.08)' }} />
          <button
            role="menuitem"
            data-testid={`chat-row-delete-${chatId}`}
            className="block w-full px-3 py-1.5 text-left text-[#EF4444] hover:bg-white/[0.04]"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
              onDelete();
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
