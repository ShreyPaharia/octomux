import { cn } from '@/lib/utils';
import type { WsConnectionState } from '@/lib/orchestrator-api';

/**
 * WebSocket connection-status pill (SHR-162). Surfaces connecting / live /
 * reconnecting so a dropped socket is visible instead of silently dead.
 */
export function ConnectionPill({ state }: { state: WsConnectionState }) {
  const config: Record<
    WsConnectionState,
    { label: string; dot: string; pulse: boolean; aria: string }
  > = {
    connecting: { label: 'connecting', dot: 'bg-[#FB923C]', pulse: true, aria: 'Connecting' },
    open: { label: 'live', dot: 'bg-[#22C55E]', pulse: false, aria: 'Connected' },
    reconnecting: { label: 'reconnecting', dot: 'bg-[#FB923C]', pulse: true, aria: 'Reconnecting' },
    closed: { label: 'offline', dot: 'bg-[rgba(255,255,255,0.3)]', pulse: false, aria: 'Offline' },
  };
  const { label, dot, pulse, aria } = config[state];

  return (
    <span
      role="status"
      aria-label={aria}
      title={`WebSocket ${label}`}
      className="ml-2 flex shrink-0 items-center gap-1.5 text-[11px] text-[rgba(255,255,255,0.45)]"
    >
      <span className={cn('h-2 w-2 rounded-full', dot, pulse && 'animate-pulse')} />
      {label}
    </span>
  );
}
