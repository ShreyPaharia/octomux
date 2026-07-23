import type { ReviewDetail } from '@/lib/api/reviewApi';
import { Badge } from '../ui/badge';

interface PublishedHistoryPanelProps {
  history: ReviewDetail['published_history'];
}

export function PublishedHistoryPanel({ history }: PublishedHistoryPanelProps) {
  if (history.length === 0) return null;

  return (
    <section
      data-testid="published-history-panel"
      className="border-b border-glass-edge bg-glass-l1/60 px-4 py-3 sm:px-6"
    >
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Published reviews
      </h2>
      <ul className="space-y-2">
        {history.map((entry) => (
          <li
            key={entry.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-glass-edge bg-glass-l2/40 px-3 py-2 text-xs"
          >
            <Badge variant="outline">{entry.verdict}</Badge>
            <span className="text-muted-foreground">
              {entry.comment_count} comment{entry.comment_count === 1 ? '' : 's'}
            </span>
            <span className="text-muted-foreground">· {entry.published_at}</span>
            {entry.github_review_url ? (
              <a
                href={entry.github_review_url}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                View on GitHub
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
