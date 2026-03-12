import { memo } from 'react';
import type { HookActivity } from '../../server/types';

const ACTIVITY_STYLES: Record<HookActivity, { dot: string; label: string }> = {
  active: { dot: 'bg-green-500', label: 'active' },
  idle: { dot: 'bg-zinc-400', label: 'idle' },
  waiting: { dot: 'bg-amber-500', label: 'waiting' },
};

export const AgentActivityDot = memo(function AgentActivityDot({
  activity,
}: {
  activity: HookActivity;
}) {
  const style = ACTIVITY_STYLES[activity] || ACTIVITY_STYLES.active;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-zinc-400">
      <span
        className={`inline-block h-2 w-2 rounded-full ${style.dot} ${activity === 'active' ? 'animate-pulse' : ''}`}
      />
      {style.label}
    </span>
  );
});
