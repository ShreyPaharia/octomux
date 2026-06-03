import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type ReviewInboxRow } from '../lib/api';
import { GlassPanel } from '@/components/ui/glass-panel';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { PageHeader } from '@/components/layout/page-header';
import { repoName } from '@/lib/utils';
import { timeAgo } from '@/lib/time';
import { cn } from '@/lib/utils';

const STATUS_PILL: Record<
  ReviewInboxRow['status'],
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  reviewing: { label: 'reviewing', variant: 'secondary' },
  'drafts-ready': { label: 'drafts ready', variant: 'default' },
  'head-advanced': { label: 'head advanced', variant: 'secondary' },
  published: { label: 'published', variant: 'outline' },
  failed: { label: 'failed', variant: 'destructive' },
};

function formatActivityAt(iso: string): string {
  if (!iso) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  try {
    return timeAgo(iso);
  } catch {
    return iso;
  }
}

function metaLine(r: ReviewInboxRow): string {
  const parts = [
    `${r.draft_count} draft${r.draft_count === 1 ? '' : 's'}`,
    `${r.accepted_count} accepted`,
  ];
  if (r.rejected_count > 0) parts.push(`${r.rejected_count} rejected`);
  if (r.stale_count > 0) parts.push(`${r.stale_count} stale`);
  return parts.join(' · ');
}

export default function ReviewsPage() {
  const [rows, setRows] = useState<ReviewInboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();

  useEffect(() => {
    let cancelled = false;
    api
      .listReviewsInbox()
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    const tick = setInterval(() => {
      api
        .listReviewsInbox()
        .then((r) => {
          if (!cancelled) setRows(r);
        })
        .catch(() => {});
    }, 10_000);
    return () => {
      cancelled = true;
      clearInterval(tick);
    };
  }, []);

  if (loading) {
    return (
      <div className="p-6">
        <PageHeader title="Reviews" />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="p-6">
        <PageHeader title="Reviews" />
        <p className="text-sm text-muted-foreground">No open review requests right now.</p>
      </div>
    );
  }

  const byRepo = new Map<string, ReviewInboxRow[]>();
  for (const r of rows) {
    const list = byRepo.get(r.repo_path) ?? [];
    list.push(r);
    byRepo.set(r.repo_path, list);
  }

  return (
    <div className="flex h-full min-h-0 flex-col p-6">
      <PageHeader title="Reviews" />
      <div className="mt-4 space-y-8">
        {Array.from(byRepo.entries()).map(([repo, repoRows]) => (
          <section key={repo}>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {repoName(repo)}
              </h2>
              <span className="truncate text-[10px] text-muted-soft" title={repo}>
                {repo}
              </span>
            </div>
            <ul className="space-y-2" data-testid={`review-inbox-repo-${repoName(repo)}`}>
              {repoRows.map((r) => {
                const pill = STATUS_PILL[r.status];
                return (
                  <li key={r.task_id}>
                    <GlassPanel
                      level={2}
                      specular
                      data-testid={`review-inbox-row-${r.task_id}`}
                      className={cn(
                        'flex flex-col gap-2 rounded-2xl px-4 py-3 sm:flex-row sm:items-center',
                        'transition-colors hover:bg-glass-l3/80',
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {r.pr_title}
                          </span>
                          {r.pr_number != null && (
                            <span className="shrink-0 font-mono text-xs text-muted-foreground">
                              #{r.pr_number}
                            </span>
                          )}
                          <Badge variant={pill.variant}>{pill.label}</Badge>
                          {r.last_activity_at && (
                            <span className="text-[10px] text-muted-soft">
                              {formatActivityAt(r.last_activity_at)}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{metaLine(r)}</p>
                        {r.author_login && (
                          <p className="mt-0.5 text-[10px] text-muted-soft">@{r.author_login}</p>
                        )}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        onClick={() => nav(`/reviews/${r.task_id}`)}
                      >
                        Open review
                      </Button>
                    </GlassPanel>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
