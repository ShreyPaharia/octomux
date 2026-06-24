import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { CYAN_ACTIVE_FG, FOCUS_RING } from './constants';

// ─── Connection status hook (ws shim — swap for T1 context on rebase) ──────

export type ConnectionStatus = 'connected' | 'reconnecting';

export function useConnectionStatus(): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(() =>
    typeof navigator !== 'undefined' && navigator.onLine === false ? 'reconnecting' : 'connected',
  );

  useEffect(() => {
    const onOnline = () => setStatus('connected');
    const onOffline = () => setStatus('reconnecting');
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return status;
}

// ─── Footer ────────────────────────────────────────────────────────────────

export function SidebarFooter({ collapsed }: { collapsed: boolean }) {
  const connection = useConnectionStatus();
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e: globalThis.MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const handle = 'octomux';
  const initials = 'OM';
  const dotColor = connection === 'connected' ? '#22C55E' : '#FFB800';
  const connectionLabel = connection === 'connected' ? 'connected' : 'reconnecting';

  return (
    <div
      ref={rootRef}
      data-testid="sidebar-footer"
      data-connection={connection}
      className={cn(
        'glass-chrome-footer glass-blur-l1 relative mt-auto shrink-0',
        collapsed ? 'px-0 py-2.5' : 'px-3 py-2.5',
      )}
    >
      {menuOpen && (
        <div
          role="menu"
          data-testid="sidebar-footer-menu"
          className="glass-chrome-menu glass-blur-l2 absolute bottom-full left-2 right-2 z-50 mb-2 rounded-xl py-1 text-xs outline-none"
        >
          <button
            role="menuitem"
            type="button"
            className="block w-full px-3 py-1.5 text-left text-[#d0d0d0] hover:bg-white/[0.04]"
          >
            Preferences
          </button>
          <div className="my-1 h-px" style={{ backgroundColor: 'rgba(255,255,255,0.08)' }} />
          <button
            role="menuitem"
            type="button"
            className="block w-full px-3 py-1.5 text-left text-[#d0d0d0] hover:bg-white/[0.04]"
          >
            Sign out
          </button>
        </div>
      )}
      {collapsed ? (
        <div className="flex flex-col items-center gap-2">
          <span
            aria-label={`User ${handle}`}
            className="flex items-center justify-center rounded-full font-semibold"
            style={{
              width: 28,
              height: 28,
              backgroundColor: 'rgba(59,130,246,0.2)',
              color: CYAN_ACTIVE_FG,
              border: '1px solid rgba(59,130,246,0.35)',
              fontSize: 10,
            }}
          >
            {initials}
          </span>
          <span
            aria-label={`Connection ${connectionLabel}`}
            data-testid="sidebar-connection-dot"
            className="rounded-full"
            style={{ width: 8, height: 8, backgroundColor: dotColor }}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="User menu"
          aria-expanded={menuOpen}
          data-testid="sidebar-footer-trigger"
          className={`flex w-full items-center gap-2.5 rounded-[8px] px-2 py-1.5 hover:bg-white/[0.04] ${FOCUS_RING}`}
        >
          <span
            className="flex shrink-0 items-center justify-center rounded-full font-semibold"
            style={{
              width: 26,
              height: 26,
              backgroundColor: 'rgba(59,130,246,0.2)',
              color: CYAN_ACTIVE_FG,
              border: '1px solid rgba(59,130,246,0.35)',
              fontSize: 10,
            }}
            aria-hidden="true"
          >
            {initials}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-left font-medium"
            style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)' }}
          >
            {handle}
          </span>
          <span
            aria-label={`Connection ${connectionLabel}`}
            data-testid="sidebar-connection-dot"
            className="shrink-0 rounded-full"
            style={{ width: 8, height: 8, backgroundColor: dotColor }}
          />
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
            className="shrink-0"
            style={{
              transform: menuOpen ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 120ms',
            }}
          >
            <path
              d="M3 7.5 6 4.5l3 3"
              stroke="rgba(255,255,255,0.6)"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
