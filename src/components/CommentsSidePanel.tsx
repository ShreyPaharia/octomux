import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
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
        'border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider',
        filter === id
          ? 'border-[#22D3EE] bg-[#22D3EE1F] text-[#22D3EE]'
          : 'border-glass-edge text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </button>
  );

  return (
    <aside
      data-testid="comments-side-panel"
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
                <header
                  className={cn(
                    'sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-glass-edge bg-[#101217] px-3 py-1.5',
                  )}
                >
                  <span className="truncate font-mono text-[11px] text-[#B5B5BD]">
                    {filePath}
                  </span>
                  {!inDiff ? (
                    <span
                      title="File no longer in diff"
                      className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
                    >
                      not in diff
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
                            inDiff ? 'hover:bg-[#141414]' : 'cursor-not-allowed opacity-60',
                          )}
                        >
                          <span className="flex items-center gap-2 text-[11px]">
                            <span
                              className={cn(
                                'inline-flex h-4 w-4 items-center justify-center rounded-full font-mono text-[9px] font-bold',
                                c.agent_id
                                  ? 'bg-[#22C55E1F] text-[#86EFAC]'
                                  : 'bg-[#3B82F61F] text-[#93C5FD]',
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
                              <span className="border border-[#22C55E66] bg-[#22C55E1F] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[#86EFAC]">
                                Resolved
                              </span>
                            ) : null}
                            {rangeIsBase && c.outdated ? (
                              <span className="border border-[#F59E0B66] bg-[#F59E0B1F] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[#FCD34D]">
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
    </aside>
  );
}

export default CommentsSidePanel;
