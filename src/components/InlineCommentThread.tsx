import { useEffect, useState } from 'react';
import type { InlineCommentWithOutdated } from '@/lib/api';
import type { Agent } from '../../server/types';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/time';
import { linkify } from '@/lib/comment-format';

export interface InlineCommentThreadProps {
  comments: InlineCommentWithOutdated[];
  agents: Agent[];
  /** Whether the parent surface is showing a non-base diff range. When true, we hide
   *  the outdated chip in favor of a "Posted on commit X" pill. */
  rangeIsBase: boolean;
  /** True when the server reported `outdated_unavailable` (e.g. no worktree on disk). */
  outdatedUnavailable: boolean;
  onReply: (body: string) => void;
  onResolve: (commentId: string, resolved: boolean) => void;
  onDelete: (commentId: string) => void;
  onEdit: (commentId: string, body: string) => void;
  /** Optional cancel-composer hook so the inline thread can clean up its open state. */
  onCancelReply?: () => void;
  /** ID used by side-panel "click-to-flash" to highlight the matching thread. */
  focusedId?: string | null;
  className?: string;
  showReply?: boolean;
}

function authorLabel(c: InlineCommentWithOutdated, agents: Agent[]): string {
  if (c.agent_id == null) return 'You';
  return agents.find((a) => a.id === c.agent_id)?.label ?? 'agent';
}

function authorIsAgent(c: InlineCommentWithOutdated): boolean {
  return c.agent_id != null;
}

function isOwn(c: InlineCommentWithOutdated): boolean {
  return c.agent_id == null;
}

function Chip({
  children,
  tone,
  title,
}: {
  children: React.ReactNode;
  tone: 'amber' | 'green' | 'neutral' | 'blue';
  title?: string;
}) {
  const styles: Record<'amber' | 'green' | 'neutral' | 'blue', string> = {
    amber: 'border-[#F59E0B66] bg-[#F59E0B1F] text-[#FCD34D]',
    green: 'border-[#22C55E66] bg-[#22C55E1F] text-[#86EFAC]',
    neutral: 'border-[#2f2f2f] bg-[#1a1a1a] text-[#8a8a8a]',
    blue: 'border-[#3B82F666] bg-[#3B82F61F] text-[#93C5FD]',
  };
  return (
    <span
      title={title}
      className={cn(
        'inline-flex shrink-0 items-center border px-1.5 py-0.5 font-mono text-[10px] tracking-wider uppercase',
        styles[tone],
      )}
    >
      {children}
    </span>
  );
}

export function InlineCommentThread({
  comments,
  agents,
  rangeIsBase,
  outdatedUnavailable,
  onReply,
  onResolve,
  onDelete,
  onEdit,
  onCancelReply,
  focusedId,
  className,
  showReply = true,
}: InlineCommentThreadProps) {
  const [replyDraft, setReplyDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);

  useEffect(() => {
    setEditing(null);
  }, [comments.length]);

  const focusedHere = !!focusedId && comments.some((c) => c.id === focusedId);

  return (
    <div
      data-testid="inline-comment-thread"
      data-focused={focusedHere ? 'true' : undefined}
      className={cn(
        'border border-glass-edge bg-card p-3 shadow-[0_8px_20px_-12px_rgba(0,0,0,0.6)]',
        focusedHere && 'octomux-comment-flash',
        className,
      )}
    >
      <ul className="flex flex-col gap-3">
        {comments.map((c) => {
          const own = isOwn(c);
          const isEditing = editing?.id === c.id;
          return (
            <li
              key={c.id}
              data-testid={`inline-comment-${c.id}`}
              data-comment-id={c.id}
              className="flex flex-col gap-1"
            >
              <div className="flex items-center gap-2 text-[11px]">
                <span
                  className={cn(
                    'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-bold',
                    authorIsAgent(c)
                      ? 'bg-[#22C55E1F] text-[#86EFAC]'
                      : 'bg-[#3B82F61F] text-[#93C5FD]',
                  )}
                  aria-hidden
                >
                  {authorLabel(c, agents).slice(0, 1).toUpperCase()}
                </span>
                <span className="font-medium text-foreground">{authorLabel(c, agents)}</span>
                <span className="text-muted-foreground">{timeAgo(c.created_at)}</span>
                {c.resolved_at ? <Chip tone="green">Resolved</Chip> : null}
                {!rangeIsBase ? (
                  <Chip tone="blue" title={`Anchored at ${c.original_commit_sha}`}>
                    Posted on {c.original_commit_sha.slice(0, 7)}
                  </Chip>
                ) : outdatedUnavailable ? (
                  <Chip
                    tone="neutral"
                    title="Worktree unavailable; cannot determine outdated state"
                  >
                    Unknown
                  </Chip>
                ) : c.outdated ? (
                  <Chip tone="amber" title="Anchor line was modified after this comment was posted">
                    Outdated
                  </Chip>
                ) : null}
              </div>
              {isEditing ? (
                <div className="flex flex-col gap-1">
                  <textarea
                    autoFocus
                    aria-label="Edit comment"
                    className="w-full border border-glass-edge bg-glass-l1 px-2 py-1 text-sm"
                    rows={3}
                    value={editing.body}
                    onChange={(e) => setEditing({ id: c.id, body: e.target.value })}
                  />
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="xs" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="xs"
                      disabled={!editing.body.trim() || editing.body === c.body}
                      onClick={() => {
                        onEdit(c.id, editing.body);
                        setEditing(null);
                      }}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              ) : (
                <p
                  className="text-sm text-foreground"
                  style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                >
                  {linkify(c.body)}
                </p>
              )}
              {!isEditing ? (
                <div className="flex items-center gap-1 text-[11px]">
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => onResolve(c.id, !c.resolved_at)}
                    aria-label={c.resolved_at ? 'Unresolve comment' : 'Resolve comment'}
                  >
                    {c.resolved_at ? 'Unresolve' : 'Resolve'}
                  </Button>
                  {own ? (
                    <>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setEditing({ id: c.id, body: c.body })}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => onDelete(c.id)}
                        aria-label="Delete comment"
                      >
                        Delete
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {showReply ? (
        <div className="mt-3 flex flex-col gap-1 border-t border-glass-edge pt-3">
          <textarea
            aria-label="Reply"
            placeholder="Reply…"
            className="w-full border border-glass-edge bg-glass-l1 px-2 py-1 text-sm"
            rows={2}
            value={replyDraft}
            onChange={(e) => setReplyDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setReplyDraft('');
                onCancelReply?.();
              }
            }}
          />
          <div className="flex items-center justify-end gap-1">
            <Button
              size="xs"
              disabled={!replyDraft.trim()}
              onClick={() => {
                onReply(replyDraft);
                setReplyDraft('');
              }}
            >
              Reply
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default InlineCommentThread;
