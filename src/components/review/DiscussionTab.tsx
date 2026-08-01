import { useMemo } from 'react';
import type { InlineCommentDTO, ReviewDetail } from '@/lib/api/reviewApi';
import { historyFindings } from '@/lib/review-findings';
import { InlineCommentCard } from './InlineCommentCard';
import { PublishedHistoryPanel } from './PublishedHistoryPanel';

interface DiscussionTabProps {
  taskId: string;
  comments: InlineCommentDTO[];
  publishedHistory: ReviewDetail['published_history'];
  onUpdated: () => void;
}

/**
 * DISCUSSION: the conversational / historical layer — published, rejected,
 * resolved, and stale comments plus the published-review timeline. A tab is the
 * legitimate home for this (parallel, non-comparative, own scroll); active AI
 * triage stays welded to the diff in the Changes surface.
 */
export function DiscussionTab({
  taskId,
  comments,
  publishedHistory,
  onUpdated,
}: DiscussionTabProps) {
  const history = useMemo(() => historyFindings(comments), [comments]);

  const isEmpty = history.length === 0 && publishedHistory.length === 0;

  return (
    <div
      data-testid="discussion-tab"
      className="min-h-0 flex-1 overflow-y-auto"
      aria-label="Discussion and history"
    >
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-4 sm:px-6">
        <PublishedHistoryPanel history={publishedHistory} />

        {history.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Resolved & past comments
            </h2>
            <ul className="space-y-3">
              {history.map((c) => (
                <li key={c.id}>
                  <InlineCommentCard comment={c} taskId={taskId} onUpdated={onUpdated} />
                </li>
              ))}
            </ul>
          </section>
        )}

        {isEmpty && (
          <p
            data-testid="discussion-empty"
            className="px-1 py-8 text-center text-xs text-muted-foreground"
          >
            No discussion yet. Published, resolved, and rejected comments will collect here.
          </p>
        )}
      </div>
    </div>
  );
}
