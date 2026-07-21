import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { InlineCommentDTO } from '@/lib/api/reviewApi';
import { prepareFindingQueue } from '@/lib/review-findings';
import {
  REVIEW_FINDING_KEYBINDS,
  useReviewFindingKeyboard,
} from '@/hooks/useReviewFindingKeyboard';
import { cn } from '@/lib/utils';
import { ReviewFilters, type CommentFilters } from './ReviewFilters';
import { InlineCommentCard } from './InlineCommentCard';

const DEFAULT_FILTERS: CommentFilters = {
  severity: [],
  bucket: [],
  kind: [],
  showResolved: false,
};

const SEVERITY_DOT: Record<string, string> = {
  critical: 'bg-red-500',
  issue: 'bg-orange-500',
  suggestion: 'bg-blue-500',
  nit: 'bg-muted-foreground',
};

interface FindingQueueProps {
  taskId: string;
  comments: InlineCommentDTO[];
  selectedId: string | null;
  onSelect: (comment: InlineCommentDTO) => void;
  onUpdated: () => void;
  onJumpToCode: (comment: InlineCommentDTO) => void;
}

function shortPath(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

export function FindingQueue({
  taskId,
  comments,
  selectedId,
  onSelect,
  onUpdated,
  onJumpToCode,
}: FindingQueueProps) {
  const [filters, setFilters] = useState<CommentFilters>(DEFAULT_FILTERS);
  const queue = useMemo(() => prepareFindingQueue(comments, filters), [comments, filters]);
  const selected = queue.find((c) => c.id === selectedId) ?? queue[0] ?? null;
  const cardActionsRef = useRef<{ accept: () => void; reject: () => void } | null>(null);

  useEffect(() => {
    if (!selected && queue.length > 0) {
      onSelect(queue[0]);
    }
  }, [queue, selected, onSelect]);

  const selectByOffset = useCallback(
    (delta: number) => {
      if (queue.length === 0) return;
      const idx = selected ? queue.findIndex((c) => c.id === selected.id) : -1;
      const nextIdx = idx === -1 ? 0 : (idx + delta + queue.length) % queue.length;
      onSelect(queue[nextIdx]);
    },
    [queue, selected, onSelect],
  );

  const handleError = useCallback((msg: string) => {
    toast.error(msg);
  }, []);

  useReviewFindingKeyboard({
    onNextFinding: () => selectByOffset(1),
    onPrevFinding: () => selectByOffset(-1),
    onAccept: () => cardActionsRef.current?.accept(),
    onReject: () => cardActionsRef.current?.reject(),
    onJumpToCode: () => {
      if (selected) onJumpToCode(selected);
    },
  });

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="finding-queue">
      <header className="shrink-0 space-y-2 border-b border-glass-edge px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Findings
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {queue.length} to triage
          </span>
        </div>
        <ReviewFilters filters={filters} onChange={setFilters} />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {queue.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground" data-testid="finding-queue-empty">
            No actionable findings. Accept drafts to enable publish, or re-run the review.
          </p>
        ) : (
          <ul className="divide-y divide-glass-edge/60">
            {queue.map((c, index) => {
              const isSelected = selected?.id === c.id;
              const dot = c.severity ? SEVERITY_DOT[c.severity] : 'bg-muted-foreground';
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    data-testid={`finding-queue-item-${c.id}`}
                    data-selected={isSelected ? 'true' : undefined}
                    onClick={() => onSelect(c)}
                    className={cn(
                      'flex w-full items-start gap-2 px-3 py-2 text-left text-xs hover:bg-glass-l2/40',
                      isSelected && 'bg-primary/10',
                    )}
                  >
                    <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', dot)} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {index + 1}/{queue.length}
                        </span>
                        {c.severity ? (
                          <span className="rounded border border-glass-edge px-1 py-0.5 text-[10px]">
                            {c.severity}
                          </span>
                        ) : null}
                        {c.bucket ? (
                          <span className="text-[10px] text-muted-foreground">{c.bucket}</span>
                        ) : null}
                        {c.status === 'accepted' ? (
                          <span className="text-[10px] text-primary">accepted</span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[10px] text-blue-300">
                        {shortPath(c.file_path)}:{c.line}
                      </span>
                      <span className="mt-0.5 line-clamp-2 text-foreground">{c.body}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {selected ? (
        <div
          data-testid="finding-queue-detail"
          className="shrink-0 border-t border-glass-edge bg-glass-l1/80 p-3"
        >
          <InlineCommentCard
            key={selected.id}
            comment={selected}
            taskId={taskId}
            onUpdated={onUpdated}
            onError={handleError}
            registerActions={(actions) => {
              cardActionsRef.current = actions;
            }}
          />
        </div>
      ) : null}

      <footer className="shrink-0 border-t border-glass-edge px-3 py-2">
        <p className="text-[10px] text-muted-foreground">
          {REVIEW_FINDING_KEYBINDS.map((b) => `${b.keys}: ${b.description}`).join(' · ')}
        </p>
      </footer>
    </div>
  );
}
