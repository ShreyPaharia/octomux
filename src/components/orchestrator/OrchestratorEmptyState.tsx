import { cn } from '@/lib/utils';
import { ORCHESTRATOR_FOCUS_RING } from './types';

export function OrchestratorEmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[rgba(59,130,246,0.12)]">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#3B82F6"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </div>
      <div>
        <p className="text-sm font-medium text-foreground">No conversation selected</p>
        <p className="mt-1 text-xs text-[rgba(255,255,255,0.45)]">
          Select a conversation from the list or start a new one.
        </p>
      </div>
      <button
        type="button"
        onClick={onNew}
        className={cn(
          'rounded-lg bg-[#3B82F6] px-4 py-2 text-sm font-medium text-white hover:opacity-90',
          ORCHESTRATOR_FOCUS_RING,
        )}
      >
        New conversation
      </button>
    </div>
  );
}
