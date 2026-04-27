import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ChevronDownIcon } from '@/components/icons';
import { useAgents } from '@/lib/hooks';

interface AgentPickerFieldProps {
  value: string | null;
  onChange: (value: string | null) => void;
  triggerClassName?: string;
  triggerLabel?: string;
}

export function AgentPickerField({
  value,
  onChange,
  triggerClassName,
  triggerLabel,
}: AgentPickerFieldProps) {
  const { agents, loading } = useAgents();
  const [open, setOpen] = useState(false);

  const label = triggerLabel ?? value ?? 'Select agent…';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-testid="agent-picker-trigger"
            className={
              triggerClassName ??
              'flex h-9 w-full items-center justify-between rounded-lg border border-glass-edge bg-glass-l1 px-3 py-1 text-sm transition-colors hover:bg-glass-l2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            }
          >
            <span className={value ? 'font-mono text-xs' : 'text-muted-foreground'}>{label}</span>
            <ChevronDownIcon className="text-muted-foreground" />
          </button>
        }
      />
      <PopoverContent
        align="start"
        side="top"
        sideOffset={4}
        className="w-[280px] gap-1 p-1.5"
        data-testid="agent-picker-popover"
      >
        <div className="max-h-[260px] overflow-y-auto py-1">
          <button
            type="button"
            data-testid="agent-picker-none"
            className={`flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
              value === null
                ? 'border border-[#3B82F666] bg-[#3B82F61F] font-medium text-foreground'
                : 'border border-transparent hover:bg-glass-l2'
            }`}
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            <span className="font-mono text-xs truncate">(none — plain claude)</span>
          </button>
          {loading && agents.length === 0 && (
            <div className="px-3 py-3 text-center text-xs text-muted-foreground">Loading…</div>
          )}
          {agents.map((a) => {
            const selected = value === a.name;
            return (
              <button
                key={a.name}
                type="button"
                data-testid={`agent-picker-option-${a.name}`}
                className={`flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
                  selected
                    ? 'border border-[#3B82F666] bg-[#3B82F61F] font-medium text-foreground'
                    : 'border border-transparent hover:bg-glass-l2'
                }`}
                onClick={() => {
                  onChange(a.name);
                  setOpen(false);
                }}
                title={a.description}
              >
                <span className="font-mono text-xs truncate">{a.name}</span>
                {a.description && (
                  <span className="text-[10px] text-muted-foreground truncate w-full">
                    {a.description}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
