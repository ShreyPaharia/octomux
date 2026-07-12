import type { ReactNode } from 'react';
import type { SidebarItem } from '@/lib/sidebar-utils';
import type { RunMode } from '@octomux/types';

// ─── Status Icons (both color AND shape — colorblind safe) ─────────────────

export function StatusIcon({ item }: { item: SidebarItem }) {
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

export function RunModeBadge({ mode }: { mode: RunMode }) {
  return (
    <span
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm"
      style={{
        fontSize: 9,
        fontWeight: 700,
        fontFamily: 'ui-monospace, SFMono-Regular, monospace',
        color: '#8a8a8a',
        backgroundColor: 'rgba(255,255,255,0.05)',
        border: '1px solid rgba(255,255,255,0.08)',
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

export type NavIcon = (p: { color: string }) => ReactNode;

export function HomeIcon({ color }: { color: string }) {
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

export function TasksIcon({ color }: { color: string }) {
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

export function ReviewsIcon({ color }: { color: string }) {
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
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <line x1="6" y1="9" x2="6" y2="21" />
    </svg>
  );
}

export function MonitorIcon({ color }: { color: string }) {
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
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

export function WorkspacesIcon({ color }: { color: string }) {
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

export function OrchestratorIcon({ color }: { color: string }) {
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
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function LoopsIcon({ color }: { color: string }) {
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
      <path d="M17 2.1 21 6l-4 3.9M3 12v-2a4 4 0 0 1 4-4h14M7 21.9 3 18l4-3.9M21 12v2a4 4 0 0 1-4 4H3" />
    </svg>
  );
}

export function SettingsIcon({ color }: { color: string }) {
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
