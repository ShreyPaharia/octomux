import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { ChevronDownIcon } from '../icons';
import { Badge } from '../ui/badge';
import { lookupWalkthroughFile, type RenderGroup } from '@/lib/review-file-groups';

interface WalkthroughSpineProps {
  groups: RenderGroup[];
  selectedPath: string | null;
  onExpand: () => void;
  onSelectGroup: (group: RenderGroup) => void;
}

function shortPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * REVIEW-state dock: the walkthrough collapsed to a slim, always-visible spine.
 * Group nav + a synced "you are here" indicator, one click back to the full
 * orient view. The per-file note here is the ONE canonical place that prose
 * renders — the file tree and diff header only show jump chips.
 */
export function WalkthroughSpine({
  groups,
  selectedPath,
  onExpand,
  onSelectGroup,
}: WalkthroughSpineProps) {
  const ctx = useMemo(
    () => (selectedPath ? lookupWalkthroughFile(groups, selectedPath) : null),
    [groups, selectedPath],
  );
  const activeGroupName = ctx?.group.name ?? null;

  return (
    <section
      data-testid="walkthrough-spine"
      className="shrink-0 border-b border-glass-edge bg-glass-l1"
      aria-label="Walkthrough navigation"
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          onClick={onExpand}
          data-testid="walkthrough-expand-btn"
          className="focus-ring flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-semibold text-muted-foreground hover:bg-glass-l2/40 hover:text-foreground"
          aria-label="Expand walkthrough"
          title="Expand walkthrough"
        >
          <ChevronDownIcon aria-hidden className="size-3.5 rotate-180" />
          Walkthrough
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {groups.map((group) => {
            const active = group.name === activeGroupName;
            return (
              <button
                key={group.name}
                type="button"
                data-testid={`spine-group-${group.name}`}
                data-active={active ? 'true' : undefined}
                onClick={() => onSelectGroup(group)}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] transition-colors',
                  active
                    ? 'border-primary/50 bg-primary/15 text-foreground'
                    : 'border-glass-edge text-muted-foreground hover:bg-glass-l2/40 hover:text-foreground',
                )}
                title={group.name}
              >
                {group.name}
              </button>
            );
          })}
        </div>
      </div>

      {(ctx?.file.summary || ctx?.group.summary) && (
        <div
          data-testid="review-context-file"
          className="border-t border-glass-edge/60 px-3 py-1.5"
        >
          <div className="mb-0.5 flex flex-wrap items-center gap-2">
            <span
              className="font-mono text-[11px] font-medium text-foreground"
              title={selectedPath ?? undefined}
            >
              {selectedPath ? shortPath(selectedPath) : ''}
            </span>
            {ctx?.file.label && (
              <Badge variant="outline" className="px-1 text-[10px]">
                {ctx.file.label}
              </Badge>
            )}
          </div>
          <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {ctx?.file.summary || ctx?.group.summary}
          </p>
        </div>
      )}
    </section>
  );
}
