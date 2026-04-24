import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type WorktreeDetail } from '@/lib/api';
import { Button } from '@/components/ui/button';
import type { RunMode, Task } from '../../server/types';

const MODE_LABEL: Record<RunMode, string> = {
  new: 'new',
  existing: 'existing',
  none: 'none',
  scratch: 'scratch',
};

function shortRepoName(repoPath: string | null): string {
  if (!repoPath) return '—';
  const parts = repoPath.split('/').filter(Boolean);
  return parts[parts.length - 1] || repoPath;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export default function WorkspaceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<WorktreeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      const data = await api.getWorktree(id);
      setDetail(data);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleNewTask = useCallback(() => {
    if (!detail) return;
    const params = new URLSearchParams();
    if (detail.worktree.repo_path) params.set('repo', detail.worktree.repo_path);
    params.set('mode', 'existing');
    if (detail.worktree.path) params.set('worktree_path', detail.worktree.path);
    navigate(`/?${params.toString()}`);
  }, [detail, navigate]);

  const handleRemove = useCallback(async () => {
    if (!detail) return;
    const userOwned = detail.worktree.mode === 'existing' || detail.worktree.mode === 'none';
    const confirmMessage = userOwned
      ? 'Forget this workspace? The filesystem directory will be left untouched; only the Octomux record is removed.'
      : 'Remove this workspace? This deletes the worktree directory and branch from disk.';
    if (!window.confirm(confirmMessage)) return;
    setRemoving(true);
    try {
      await api.deleteWorktree(detail.worktree.id);
      navigate('/workspaces');
    } catch (err) {
      setError((err as Error).message);
      setRemoving(false);
    }
  }, [detail, navigate]);

  if (error && !detail) {
    return (
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-4xl px-4 py-6 text-sm text-destructive">
          Failed to load workspace: {error}
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="h-full overflow-auto">
        <div className="mx-auto max-w-4xl px-4 py-6 text-sm text-[#8a8a8a]">Loading…</div>
      </div>
    );
  }

  const w = detail.worktree;
  const canRemove =
    w.status === 'available' && detail.active_task === null && !removing;
  const userOwned = w.mode === 'existing' || w.mode === 'none';

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-4xl px-4 py-6">
        <button
          onClick={() => navigate('/workspaces')}
          className="mb-3 text-xs text-[#8a8a8a] hover:text-foreground"
        >
          ← All workspaces
        </button>

        <div className="mb-6 flex items-start justify-between gap-4">
          <div className="min-w-0 flex flex-col gap-1.5">
            <h1 className="font-display text-[28px] font-bold leading-tight">
              {shortRepoName(w.repo_path)}
              {w.branch ? (
                <span className="ml-3 font-mono text-lg text-[#a0a0a0]">{w.branch}</span>
              ) : null}
            </h1>
            <div className="flex flex-wrap items-center gap-2 text-xs text-[#8a8a8a]">
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
              <span className={w.status === 'in_use' ? 'text-[#22C55E]' : ''}>{w.status}</span>
            </div>
            <div className="mt-1 break-all font-mono text-xs text-[#8a8a8a]">{w.path}</div>
          </div>

          <div className="flex shrink-0 flex-col items-end gap-2">
            {w.status === 'available' && (
              <Button size="sm" onClick={handleNewTask} data-testid="new-task-on-workspace">
                New task on this workspace
              </Button>
            )}
            {canRemove && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleRemove}
                data-testid="remove-workspace"
              >
                {userOwned ? 'Forget workspace' : 'Remove workspace'}
              </Button>
            )}
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <section className="mb-6">
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-[#8a8a8a]">
            Active task
          </h2>
          {detail.active_task ? (
            <TaskRow task={detail.active_task} onClick={() => navigate(`/tasks/${detail.active_task!.id}`)} />
          ) : (
            <div className="rounded-md border border-border bg-card p-4 text-sm text-[#8a8a8a]">
              No active task.
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-[#8a8a8a]">
            History ({detail.history.length})
          </h2>
          {detail.history.length === 0 ? (
            <div className="rounded-md border border-border bg-card p-4 text-sm text-[#8a8a8a]">
              No past tasks.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {detail.history.map((t) => (
                <TaskRow key={t.id} task={t} onClick={() => navigate(`/tasks/${t.id}`)} />
              ))}
            </div>
          )}
        </section>

        <div className="mt-6 text-[10px] text-[#6a6a6a]">
          Created {formatDate(w.created_at)} · Last used {formatDate(w.last_used_at)}
        </div>
      </div>
    </div>
  );
}

function TaskRow({ task, onClick }: { task: Task; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`workspace-task-${task.id}`}
      className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2 text-left hover:bg-[#141414]"
    >
      <div className="min-w-0 flex-1 truncate text-sm text-foreground">{task.title}</div>
      <div className="shrink-0 text-xs text-[#8a8a8a]">{task.status}</div>
    </button>
  );
}
