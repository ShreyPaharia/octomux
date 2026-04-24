import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-6xl px-4 py-6 text-sm text-destructive">
          Failed to load workspaces: {error}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="mb-6 flex flex-col gap-1.5">
          <h1
            className="font-display text-[36px] font-bold leading-none tracking-tight"
            style={{ letterSpacing: '-1px' }}
          >
            WORKSPACES
          </h1>
          <span className="text-sm text-[#8a8a8a]">
            // git worktrees + scratch dirs used by tasks
          </span>
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-3" data-testid="workspace-filters">
          <label className="text-xs text-[#8a8a8a]">
            Repo
            <select
              aria-label="Filter by repo"
              value={repoFilter}
              onChange={(e) => setRepoFilter(e.target.value)}
              className="ml-2 bg-[#141414] px-2 py-1 text-xs text-foreground outline-none"
              style={{ border: '1px solid #2f2f2f' }}
            >
              <option value="all">All</option>
              {repoOptions.map((r) => (
                <option key={r} value={r}>
                  {shortRepoName(r)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-[#8a8a8a]">
            Mode
            <select
              aria-label="Filter by mode"
              value={modeFilter}
              onChange={(e) => setModeFilter(e.target.value)}
              className="ml-2 bg-[#141414] px-2 py-1 text-xs text-foreground outline-none"
              style={{ border: '1px solid #2f2f2f' }}
            >
              <option value="all">All</option>
              {(['new', 'existing', 'none', 'scratch'] as RunMode[]).map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {worktrees === null ? (
          <div className="text-sm text-[#8a8a8a]">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="rounded-md border border-border bg-card p-8 text-center text-sm text-[#8a8a8a]">
            {worktrees.length === 0
              ? "No workspaces yet. They're created automatically when you start a task."
              : 'No workspaces match these filters.'}
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#0f0f0f] text-[#8a8a8a] uppercase tracking-wider">
                <tr>
                  <th className="px-3 py-2 font-medium">Repo</th>
                  <th className="px-3 py-2 font-medium">Branch</th>
                  <th className="px-3 py-2 font-medium">Mode</th>
                  <th className="px-3 py-2 font-medium">Path</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Tasks</th>
                  <th className="px-3 py-2 font-medium">Last used</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((w) => (
                  <tr
                    key={w.id}
                    data-testid={`workspace-row-${w.id}`}
                    onClick={() => navigate(`/workspaces/${w.id}`)}
                    className="cursor-pointer border-t border-border hover:bg-[#141414]"
                  >
                    <td className="px-3 py-2 text-foreground">{shortRepoName(w.repo_path)}</td>
                    <td className="px-3 py-2 font-mono text-[#a0a0a0]">{w.branch ?? '—'}</td>
                    <td className="px-3 py-2">
                      <span
                        className="inline-flex items-center px-1.5 py-0.5"
                        style={{
                          fontSize: 10,
                          background: '#1a1a1a',
                          border: '1px solid #2f2f2f',
                          color: '#a0a0a0',
                        }}
                      >
                        {MODE_LABEL[w.mode]}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-[#8a8a8a]" title={w.path}>
                      {truncate(w.path)}
                    </td>
                    <td className="px-3 py-2">
                      <span className={w.status === 'in_use' ? 'text-[#22C55E]' : 'text-[#8a8a8a]'}>
                        {w.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[#a0a0a0]">{w.task_count}</td>
                    <td className="px-3 py-2 text-[#8a8a8a]">{relativeTime(w.last_used_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
