import { DIFF_KEYBINDS } from '@/hooks/useDiffKeyboardNav';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/** Floating "?" chip that surfaces the diff keybind cheat sheet in a popover. */
export function DiffKeybindCheatSheet() {
  return (
    <div className="pointer-events-none absolute bottom-3 right-3">
      <Popover>
        <PopoverTrigger
          aria-label="Show diff keyboard shortcuts"
          data-testid="diff-keybind-help"
          className="pointer-events-auto inline-flex h-7 w-7 items-center justify-center rounded-full border border-glass-edge bg-glass-l1 text-xs text-muted-foreground hover:text-foreground"
        >
          ?
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Diff shortcuts
          </div>
          <ul className="mt-2 space-y-1">
            {DIFF_KEYBINDS.map((b) => (
              <li key={b.keys} className="flex items-center justify-between gap-3 text-xs">
                <kbd className="rounded border border-glass-edge bg-glass-l1 px-1.5 py-0.5 font-mono text-[10px]">
                  {b.keys}
                </kbd>
                <span className="text-muted-foreground">{b.description}</span>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}
