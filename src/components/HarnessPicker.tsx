import { useEffect, useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ChevronDownIcon } from '@/components/icons';
import { useHarnesses } from '@/lib/hooks';
import { configApi } from '@/lib/api/configApi';

interface HarnessPickerProps {
  value: string | null;
  /** Called with the harness id selected (never null — there's always a harness). */
  onChange: (harnessId: string) => void;
  /** Optional className passed to the trigger button. */
  triggerClassName?: string;
}

/**
 * Coding-agent (harness) picker. Lists registered harnesses from
 * `GET /api/harnesses` and defaults the selection to
 * `settings.defaultHarnessId` (falling back to `claude-code` when no setting
 * is set yet). The component owns the defaulting so callers can pass a null
 * `value` for "no explicit choice yet".
 */
export function HarnessPicker({ value, onChange, triggerClassName }: HarnessPickerProps) {
  const { harnesses, loading } = useHarnesses();
  const [open, setOpen] = useState(false);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [defaultLoaded, setDefaultLoaded] = useState(false);

  // Resolve default harness id once on mount. We don't track settings updates
  // — the picker is a transient creation-time control.
  useEffect(() => {
    let cancelled = false;
    configApi
      .getSettings()
      .then((s) => {
        if (!cancelled) setDefaultId(s.defaultHarnessId ?? 'claude-code');
      })
      .catch(() => {
        if (!cancelled) setDefaultId('claude-code');
      })
      .finally(() => {
        if (!cancelled) setDefaultLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-apply default when the parent passes null and we know the default.
  useEffect(() => {
    if (value !== null) return;
    if (!defaultLoaded || harnesses.length === 0) return;
    const fallback = harnesses.find((h) => h.id === defaultId)?.id ?? harnesses[0].id;
    onChange(fallback);
  }, [value, defaultLoaded, defaultId, harnesses, onChange]);

  const selected = harnesses.find((h) => h.id === value) ?? null;
  const label = selected?.displayName ?? (loading ? 'Loading…' : 'Coding agent');

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-testid="harness-picker-trigger"
            className={
              triggerClassName ??
              'flex h-9 w-full items-center justify-between gap-1.5 rounded-lg border border-glass-edge bg-glass-l1 px-3 py-1 text-sm transition-colors hover:bg-glass-l2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            }
          >
            <span className="font-mono text-xs truncate">{label}</span>
            <ChevronDownIcon className="text-muted-foreground" />
          </button>
        }
      />
      <PopoverContent
        align="start"
        side="top"
        sideOffset={4}
        className="w-[240px] gap-1 p-1.5"
        data-testid="harness-picker-popover"
      >
        <div className="max-h-[240px] overflow-y-auto py-1">
          {harnesses.length === 0 && (
            <div className="px-3 py-3 text-center text-xs text-muted-foreground">
              {loading ? 'Loading…' : 'No coding agents available.'}
            </div>
          )}
          {harnesses.map((h) => {
            const isSelected = value === h.id;
            return (
              <button
                key={h.id}
                type="button"
                data-testid={`harness-picker-option-${h.id}`}
                className={`flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
                  isSelected
                    ? 'border border-[#3B82F666] bg-[#3B82F61F] font-medium text-foreground'
                    : 'border border-transparent hover:bg-glass-l2'
                }`}
                onClick={() => {
                  onChange(h.id);
                  setOpen(false);
                }}
              >
                <span className="font-mono text-xs truncate">{h.displayName}</span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
