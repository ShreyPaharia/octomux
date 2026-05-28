import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type ReviewInboxRow } from '../lib/api';
import { Card } from '../components/ui/card';
import { Badge } from '../components/ui/badge';

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
      // TODO(badge): update sidebar unread badge count here
    }, 10_000);
    return () => {
      cancelled = true;
      clearInterval(tick);
    };
  }, []);

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (rows.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground">No open review requests right now.</div>
    );
  }

  // Group by repo_path
  const byRepo = new Map<string, ReviewInboxRow[]>();
  for (const r of rows) {
    const list = byRepo.get(r.repo_path) ?? [];
    list.push(r);
    byRepo.set(r.repo_path, list);
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-lg font-semibold">Reviews</h1>
      {Array.from(byRepo.entries()).map(([repo, repoRows]) => (
        <section key={repo}>
          <h2 className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">
            {repo}
          </h2>
          <div className="space-y-2">
            {repoRows.map((r) => (
              <Card
                key={r.task_id}
                className="px-4 py-3 cursor-pointer hover:bg-muted transition-colors"
                onClick={() => nav(`/reviews/${r.task_id}`)}
              >
                <div className="flex items-center gap-3">
                  <span className="text-sm font-medium">{r.pr_title}</span>
                  <span className="text-xs text-muted-foreground">#{r.pr_number}</span>
                  <Badge variant={STATUS_PILL[r.status].variant}>
                    {STATUS_PILL[r.status].label}
                  </Badge>
                  {r.author_login && (
                    <span className="text-xs text-muted-foreground ml-auto">@{r.author_login}</span>
                  )}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {r.accepted_count} accepted · {r.draft_count} drafts · {r.rejected_count} rejected
                  {r.stale_count > 0 && ` · ${r.stale_count} stale`}
                </div>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
