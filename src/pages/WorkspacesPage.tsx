import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '@/components/layout/page-header';
import { GlassPanel } from '@/components/ui/glass-panel';
import { api } from '@/lib/api';
import type { RunMode, WorktreeSummary } from '../../server/types';

function shortRepoName(repoPath: string | null): string {
  if (!repoPath) return '—';
  const parts = repoPath.split('/').filter(Boolean);
  return parts[parts.length - 1] || repoPath;
}

function truncate(s: string, n = 48): string {
  if (!s) return '—';
  if (s.length <= n) return s;
  return '…' + s.slice(s.length - (n - 1));
}

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso.replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Date.now() - t;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

const MODE_LABEL: Record<RunMode, string> = {
  new: 'new',
  existing: 'existing',
  none: 'none',
  scratch: 'scratch',
};

export default function WorkspacesPage() {
  const navigate = useNavigate();
  const [worktrees, setWorktrees] = useState<WorktreeSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repoFilter, setRepoFilter] = useState<string>('all');
  const [modeFilter, setModeFilter] = useState<string>('all');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const rows = await api.listWorktrees();
        if (!cancelled) setWorktrees(rows);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const repoOptions = useMemo(() => {
    if (!worktrees) return [] as string[];
    const set = new Set<string>();
    for (const w of worktrees) if (w.repo_path) set.add(w.repo_path);
    return [...set].sort();
  }, [worktrees]);

  const filtered = useMemo(() => {
    if (!worktrees) return [];
    return worktrees.filter((w) => {
      if (repoFilter !== 'all' && w.repo_path !== repoFilter) return false;
      if (modeFilter !== 'all' && w.mode !== modeFilter) return false;
      return true;
    });
  }, [worktrees, repoFilter, modeFilter]);

  if (error) {
    return (
      <div className="h-full overflow-auto px-6 py-6">
        <p className="text-sm text-destructive">Failed to load workspaces: {error}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-auto">
      <PageHeader
        variant="glass"
        eyebrow="Workspaces"
        title="Workspaces"
        description="Git worktrees and scratch directories used by tasks"
        className="shrink-0"
      />

      <div className="mx-auto w-full max-w-6xl flex-1 px-6 py-6">
        <GlassPanel
          level={1}
          specular
          className="mb-4 flex flex-wrap items-center gap-4 rounded-2xl px-4 py-3"
          data-testid="workspace-filters"
        >
          <label className="text-xs text-muted-soft">
            Repo
            <select
              aria-label="Filter by repo"
              value={repoFilter}
              onChange={(e) => setRepoFilter(e.target.value)}
              className="focus-ring ml-2 rounded-lg border border-input bg-secondary px-2 py-1 text-xs text-foreground"
            >
              <option value="all">All</option>
              {repoOptions.map((r) => (
                <option key={r} value={r}>
                  {shortRepoName(r)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-muted-soft">
            Mode
            <select
              aria-label="Filter by mode"
              value={modeFilter}
              onChange={(e) => setModeFilter(e.target.value)}
              className="focus-ring ml-2 rounded-lg border border-input bg-secondary px-2 py-1 text-xs text-foreground"
            >
              <option value="all">All</option>
              {(['new', 'existing', 'none', 'scratch'] as RunMode[]).map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
        </GlassPanel>

        {worktrees === null ? (
          <p className="text-sm text-muted-soft">Loading…</p>
        ) : filtered.length === 0 ? (
          <GlassPanel level={2} className="rounded-2xl p-8 text-center text-sm text-muted-soft">
            {worktrees.length === 0
              ? "No workspaces yet. They're created automatically when you start a task."
              : 'No workspaces match these filters.'}
          </GlassPanel>
        ) : (
          <GlassPanel level={2} className="overflow-hidden rounded-2xl">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-glass-edge bg-glass-l1 text-xs font-medium text-muted-soft">
                <tr>
                  <th className="px-4 py-2.5">Repo</th>
                  <th className="px-4 py-2.5">Branch</th>
                  <th className="px-4 py-2.5">Mode</th>
                  <th className="px-4 py-2.5">Path</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Tasks</th>
                  <th className="px-4 py-2.5">Last used</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((w) => (
                  <tr
                    key={w.id}
                    data-testid={`workspace-row-${w.id}`}
                    onClick={() => navigate(`/workspaces/${w.id}`)}
                    className="cursor-pointer border-t border-glass-edge transition-colors hover:bg-glass-l1"
                  >
                    <td className="px-4 py-2.5 text-foreground">{shortRepoName(w.repo_path)}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                      {w.branch ?? '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex rounded-md border border-input bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {MODE_LABEL[w.mode]}
                      </span>
                    </td>
                    <td
                      className="max-w-[200px] truncate px-4 py-2.5 font-mono text-xs text-muted-soft"
                      title={w.path}
                    >
                      {truncate(w.path)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={w.status === 'in_use' ? 'text-success' : 'text-muted-soft'}>
                        {w.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{w.task_count}</td>
                    <td className="px-4 py-2.5 text-muted-soft">{relativeTime(w.last_used_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </GlassPanel>
        )}
      </div>
    </div>
  );
}
