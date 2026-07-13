import { extractApi, type PrExtract } from '../lib/api/extractApi';
import { useResource } from '../lib/use-resource';
import { GlassPanel } from '@/components/ui/glass-panel';
import { Badge } from '../components/ui/badge';
import { PageHeader } from '@/components/layout/page-header';
import { timeAgo } from '@/lib/time';

const RISK_VARIANT: Record<PrExtract['risk'], 'default' | 'secondary' | 'destructive'> = {
  low: 'secondary',
  medium: 'default',
  high: 'destructive',
};

export default function ExtractsPage() {
  const { data, loading } = useResource<PrExtract[]>(
    'pr-extracts',
    () => extractApi.listExtracts(),
    {
      events: (event) => event.type === 'pr_extract:created',
    },
  );
  const rows = data ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col p-6">
      <PageHeader title="PR Extracts" description="Structured metadata extracted from merged PRs" />

      {loading ? (
        <div className="mt-4 space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-2xl border border-glass-edge bg-glass-l1"
            />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No extracts yet.</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {rows.map((row) => (
            <li key={row.id}>
              <GlassPanel
                level={2}
                specular
                data-testid={`extract-row-${row.id}`}
                className="flex flex-col gap-2 rounded-2xl px-4 py-3 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-foreground">
                      {row.repo_path} #{row.pr_number}
                    </span>
                    <Badge variant={RISK_VARIANT[row.risk]}>{row.risk}</Badge>
                    <span className="text-[10px] text-muted-soft">{timeAgo(row.created_at)}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    area: {row.area} · surface: {row.surface} · loc: {row.loc} ·{' '}
                    {row.has_migration ? 'has migration' : 'no migration'}
                  </p>
                </div>
              </GlassPanel>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
