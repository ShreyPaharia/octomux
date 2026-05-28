import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { api, type ReviewDetail } from '../lib/api';
import { subscribe } from '../lib/event-source';
import { WalkthroughTree } from '../components/review/WalkthroughTree';
import { InlineCommentCard } from '../components/review/InlineCommentCard';
import { ReviewFilters, type CommentFilters } from '../components/review/ReviewFilters';
import { PublishBar } from '../components/review/PublishBar';
import { HeadAdvancedBanner } from '../components/review/HeadAdvancedBanner';

export default function ReviewDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<CommentFilters>({
    severity: [],
    bucket: [],
    kind: [],
    showResolved: false,
  });

  const refresh = useCallback(() => {
    if (!id) return;
    api
      .getReviewDetail(id)
      .then(setDetail)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Subscribe to review events
  useEffect(() => {
    if (!id) return;
    return subscribe((event) => {
      const e = event as { type: string; payload: { taskId?: string } };
      if (!('taskId' in e.payload) || e.payload.taskId !== id) return;
      if (e.type === 'review:drafts-ready' || e.type === 'review:published') {
        refresh();
      }
    });
  }, [id, refresh]);

  if (error) return <div className="p-6 text-red-500">{error}</div>;
  if (!detail) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  const walkthrough = detail.latest_run?.walkthrough
    ? JSON.parse(detail.latest_run.walkthrough)
    : null;

  const visibleComments = detail.comments.filter((c) => {
    if (!filters.showResolved && (c.auto_resolved_at || c.status === 'published')) return false;
    if (filters.severity.length > 0 && (!c.severity || !filters.severity.includes(c.severity)))
      return false;
    if (filters.bucket.length > 0 && (!c.bucket || !filters.bucket.includes(c.bucket)))
      return false;
    if (filters.kind.length > 0 && !filters.kind.includes(c.kind)) return false;
    return true;
  });

  const draftCount = detail.comments.filter((c) => c.status === 'draft').length;
  const acceptedCount = detail.comments.filter((c) => c.status === 'accepted').length;
  const staleCount = detail.comments.filter((c) => c.status === 'stale').length;

  const isRunning =
    detail.latest_run?.status === 'running' || detail.all_runs.some((r) => r.status === 'running');

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* Head-advanced banner */}
      <HeadAdvancedBanner taskId={id!} currentSha={detail.task.pr_head_sha} onRefresh={refresh} />

      {/* Publish bar */}
      <PublishBar
        taskId={id!}
        acceptedCount={acceptedCount}
        draftCount={draftCount}
        staleCount={staleCount}
        isRunning={isRunning}
        onPublished={refresh}
        onReRun={refresh}
      />

      <div className="flex-1 overflow-auto p-6 space-y-6">
        {/* Header */}
        <header className="flex items-baseline gap-2">
          <h1 className="text-lg font-semibold">{detail.task.title}</h1>
          <span className="text-xs text-muted-foreground">#{detail.task.pr_number}</span>
          {detail.task.pr_url && (
            <a
              href={detail.task.pr_url}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-blue-400 hover:underline ml-1"
            >
              View on GitHub
            </a>
          )}
        </header>

        {/* Walkthrough */}
        {walkthrough && (
          <WalkthroughTree
            walkthrough={walkthrough}
            onEditSection={(section) => {
              if (!detail.latest_run) return;
              const runId = detail.latest_run.id;
              const partial: Record<string, unknown> = {};
              if (section.kind === 'global') {
                partial['global'] = { [section.key]: section.value };
              } else if (section.kind === 'group') {
                // handled inside WalkthroughTree
              }
              api
                .patchWalkthrough(id!, runId, partial)
                .then(() => refresh())
                .catch(() => {});
            }}
            runId={detail.latest_run?.id ?? null}
            taskId={id!}
            onRefresh={refresh}
          />
        )}

        {/* Filters */}
        {detail.comments.length > 0 && <ReviewFilters filters={filters} onChange={setFilters} />}

        {/* Comment cards */}
        {visibleComments.length > 0 ? (
          <div className="space-y-3">
            {visibleComments.map((comment) => (
              <InlineCommentCard
                key={comment.id}
                comment={comment}
                taskId={id!}
                onUpdated={refresh}
              />
            ))}
          </div>
        ) : detail.comments.length > 0 ? (
          <p className="text-sm text-muted-foreground">No comments match your filters.</p>
        ) : null}
      </div>
    </div>
  );
}
