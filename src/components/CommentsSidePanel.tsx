import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { DIFF_FILTER_ACTIVE } from '@/lib/design-tokens';
import { GlassPanel } from '@/components/ui/glass-panel';
import { timeAgo } from '@/lib/time';
import { useTaskCommentsContext } from '@/hooks/useTaskComments';
import type { InlineCommentWithOutdated } from '@/lib/api';
import type { Agent } from '../../server/types';

const ROW_CAP = 500;

type FilterMode = 'all' | 'unresolved' | 'outdated';

export interface CommentsSidePanelProps {
  agents: Agent[];
  /** Files currently in the diff — used to mark "no longer in diff" comments. */
  filesInDiff: Set<string>;
  rangeIsBase: boolean;
  /** Called when a comment is clicked. The host should reveal it in the diff
   *  and arrange to flash the matching thread. */
  onJumpTo: (filePath: string, line: number, side: 'old' | 'new', commentId: string) => void;
  onClose?: () => void;
  className?: string;
}

function authorLabel(c: InlineCommentWithOutdated, agents: Agent[]): string {
  if (c.agent_id == null) return 'You';
  return agents.find((a) => a.id === c.agent_id)?.label ?? 'agent';
}

export function CommentsSidePanel({
  agents,
  filesInDiff,
  rangeIsBase,
  onJumpTo,
  onClose,
  className,
}: CommentsSidePanelProps) {
  const ctx = useTaskCommentsContext();
  const [filter, setFilter] = useState<FilterMode>('all');

  const all = useMemo(() => Array.from(ctx.byId.values()), [ctx.byId]);

  const filtered = useMemo(() => {
    let out = all;
    if (filter === 'unresolved') out = out.filter((c) => !c.resolved_at);
    if (filter === 'outdated') out = out.filter((c) => c.outdated && rangeIsBase);
    return out.sort(
      (a, b) =>
        a.file_path.localeCompare(b.file_path) ||
        a.line - b.line ||
        a.created_at.localeCompare(b.created_at),
    );
  }, [all, filter, rangeIsBase]);

  const truncated = filtered.length > ROW_CAP;
  const rows = truncated ? filtered.slice(0, ROW_CAP) : filtered;

  // Group preserving sort order
  const grouped = useMemo(() => {
    const byPath = new Map<string, InlineCommentWithOutdated[]>();
    for (const c of rows) {
      const arr = byPath.get(c.file_path);
      if (arr) arr.push(c);
      else byPath.set(c.file_path, [c]);
    }
    return Array.from(byPath.entries());
  }, [rows]);

  const FilterPill = ({ id, label }: { id: FilterMode; label: string }) => (
    <button
      type="button"
      onClick={() => setFilter(id)}
      data-active={filter === id ? 'true' : undefined}
      className={cn(
        'rounded-md border px-2 py-0.5 text-[11px] font-medium',
        filter === id
          ? DIFF_FILTER_ACTIVE
          : 'border-glass-edge text-muted-foreground hover:bg-glass-l2/50 hover:text-foreground',
      )}
    >
      {label}
    </button>
  );

  return (
    <GlassPanel
      data-testid="comments-side-panel"
      chrome
      className={cn('flex w-80 flex-col border-l border-glass-edge', className)}
    >
      <header className="flex items-center justify-between gap-2 border-b border-glass-edge px-3 py-2">
        <span className="text-sm font-medium">Comments ({all.length})</span>
        {onClose ? (
          <Button variant="ghost" size="xs" aria-label="Close comments panel" onClick={onClose}>
            ×
          </Button>
        ) : null}
      </header>
      <div className="flex items-center gap-1 border-b border-glass-edge px-3 py-2">
        <FilterPill id="all" label="All" />
        <FilterPill id="unresolved" label="Unresolved" />
        <FilterPill id="outdated" label="Outdated" />
      </div>
      <ul className="flex-1 overflow-auto">
        {grouped.length === 0 ? (
          <li className="p-4 text-xs text-muted-foreground">No comments</li>
        ) : (
          grouped.map(([filePath, comments]) => {
            const inDiff = filesInDiff.has(filePath);
            return (
              <li key={filePath}>
                <header className="diff-pane-header sticky top-0 z-10 flex items-center justify-between gap-2 px-3 py-1.5">
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {filePath}
                  </span>
                  {!inDiff ? (
                    <span
                      title="File no longer in diff"
                      className="text-[10px] font-medium text-muted-soft"
                    >
                      Not in diff
                    </span>
                  ) : null}
                </header>
                <ul>
                  {comments.map((c) => {
                    const handleClick = () => {
                      if (!inDiff) return;
                      onJumpTo(c.file_path, c.line, c.side, c.id);
                    };
                    return (
                      <li
                        key={c.id}
                        data-testid={`side-panel-comment-${c.id}`}
                        className="border-b border-glass-edge/50"
                      >
                        <button
                          type="button"
                          disabled={!inDiff}
                          onClick={handleClick}
                          className={cn(
                            'flex w-full flex-col items-start gap-1 px-3 py-2 text-left text-xs',
                            inDiff ? 'hover:bg-glass-l2/40' : 'cursor-not-allowed opacity-60',
                          )}
                        >
                          <span className="flex items-center gap-2 text-[11px]">
                            <span
                              className={cn(
                                'inline-flex h-4 w-4 items-center justify-center rounded-full font-mono text-[9px] font-bold',
                                c.agent_id
                                  ? 'bg-success/15 text-success'
                                  : 'bg-primary/15 text-primary',
                              )}
                              aria-hidden
                            >
                              {authorLabel(c, agents).slice(0, 1).toUpperCase()}
                            </span>
                            <span className="font-medium">{authorLabel(c, agents)}</span>
                            <span className="text-muted-foreground">
                              {filePath}:{c.line}
                            </span>
                            <span className="ml-auto text-muted-foreground">
                              {timeAgo(c.created_at)}
                            </span>
                          </span>
                          <span
                            className="line-clamp-2 text-foreground"
                            style={{ wordBreak: 'break-word' }}
                          >
                            {c.body}
                          </span>
                          <span className="flex items-center gap-1">
                            {c.resolved_at ? (
                              <span className="rounded border border-success/40 bg-success/10 px-1.5 py-0.5 text-[9px] font-medium text-success">
                                Resolved
                              </span>
                            ) : null}
                            {rangeIsBase && c.outdated ? (
                              <span className="rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[9px] font-medium text-warning">
                                Outdated
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })
        )}
      </ul>
      {truncated ? (
        <footer className="border-t border-glass-edge px-3 py-2 text-[10px] text-muted-foreground">
          Showing first {ROW_CAP} — refine filters to see more
        </footer>
      ) : null}
    </GlassPanel>
  );
}

export default CommentsSidePanel;
