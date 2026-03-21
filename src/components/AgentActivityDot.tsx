import { memo } from 'react';
import type { HookActivity } from '../../server/types';

const ACTIVITY_STYLES: Record<HookActivity, { dot: string; label: string }> = {
  active: { dot: 'bg-[#22C55E]', label: 'Active' },
  idle: { dot: 'bg-[#6a6a6a]', label: 'Idle' },
  waiting: { dot: 'bg-[#FFB800]', label: 'Waiting' },
};

export const AgentActivityDot = memo(function AgentActivityDot({
  activity,
}: {
  activity: HookActivity;
}) {
  const style = ACTIVITY_STYLES[activity] || ACTIVITY_STYLES.active;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-[#8a8a8a]">
      <span
        className={`inline-block h-2 w-2 ${style.dot} ${activity === 'active' ? 'animate-pulse' : ''}`}
      />
      {style.label}
    </span>
  );
});
