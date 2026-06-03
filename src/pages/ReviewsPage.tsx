import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type ReviewInboxRow } from '../lib/api';
import { GlassPanel } from '@/components/ui/glass-panel';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { PageHeader } from '@/components/layout/page-header';
import { displayReviewTitle, parseActivityDate } from '@/lib/review-display';
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
    const ms = parseActivityDate(iso).getTime();
    if (Number.isNaN(ms)) return iso;
    return timeAgo(new Date(ms).toISOString());
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

function sortRows(rows: ReviewInboxRow[]): ReviewInboxRow[] {
  return [...rows].sort((a, b) => {
    const ta = parseActivityDate(a.last_activity_at).getTime();
    const tb = parseActivityDate(b.last_activity_at).getTime();
    return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
  });
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

  const byRepo = useMemo(() => {
    const map = new Map<string, ReviewInboxRow[]>();
    for (const r of sortRows(rows)) {
      const list = map.get(r.repo_path) ?? [];
      list.push(r);
      map.set(r.repo_path, list);
    }
    return map;
  }, [rows]);

  if (loading) {
    return (
      <div className="p-6">
        <PageHeader title="Reviews" />
        <div className="mt-4 space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-2xl border border-glass-edge bg-glass-l1"
            />
          ))}
        </div>
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

  return (
    <div className="flex h-full min-h-0 flex-col p-6">
      <PageHeader title="Reviews" />
      <div className="mt-4 space-y-8">
        {Array.from(byRepo.entries()).map(([repo, repoRows]) => (
          <section key={repo}>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {repo.split('/').pop() ?? repo}
              </h2>
              <span className="truncate text-[10px] text-muted-soft" title={repo}>
                {repo}
              </span>
            </div>
            <ul className="space-y-2">
              {repoRows.map((r) => {
                const pill = STATUS_PILL[r.status];
                const needsYou = r.status === 'drafts-ready' || r.status === 'head-advanced';
                return (
                  <li key={r.task_id}>
                    <GlassPanel
                      level={2}
                      specular
                      data-testid={`review-inbox-row-${r.task_id}`}
                      className={cn(
                        'group flex flex-col gap-2 rounded-2xl px-4 py-3 transition-colors sm:flex-row sm:items-center',
                        'hover:bg-glass-l3/80',
                        needsYou && 'border-l-2 border-l-primary',
                      )}
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => nav(`/reviews/${r.task_id}`)}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground group-hover:text-primary">
                            {displayReviewTitle(r.pr_title)}
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
                      </button>
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
