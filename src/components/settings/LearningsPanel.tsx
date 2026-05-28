import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import type { ReviewLearning } from '@/lib/api';
import { showToast } from '@/components/CustomToast';
import { repoName } from '@/lib/utils';
import { ROW_DIVIDER } from '@/lib/design-tokens';
import { SectionCard } from '@/components/layout/section-card';
import { useTasksContextOptional } from '@/lib/tasks-context';

// ─── Repo paths derived from tasks ──────────────────────────────────────────

const REPO_FILTER_KEY = 'octomux-repo-filter';

function useRepoPaths(): string[] {
  const ctx = useTasksContextOptional();
  if (!ctx || ctx.loading) return [];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const task of ctx.tasks) {
    if (task.repo_path && !seen.has(task.repo_path)) {
      seen.add(task.repo_path);
      paths.push(task.repo_path);
    }
  }
  return paths;
}

// ─── LearningsPanel ──────────────────────────────────────────────────────────

export interface LearningsPanelProps {
  repoPath: string;
}

export function LearningsPanel({ repoPath }: LearningsPanelProps) {
  const [learnings, setLearnings] = useState<ReviewLearning[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    setLoading(true);
    api
      .listLearnings(repoPath)
      .then((data) => setLearnings(data))
      .catch((err: Error) => showToast('error', 'LEARNINGS', err.message))
      .finally(() => setLoading(false));
  }, [repoPath]);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = useCallback(
    async (id: string) => {
      // Optimistic remove
      const snapshot = learnings;
      setLearnings((prev) => prev.filter((l) => l.id !== id));
      setDeletingIds((prev) => new Set(prev).add(id));
      try {
        await api.deleteLearning(id);
      } catch (err) {
        // Revert on failure
        setLearnings(snapshot);
        showToast('error', 'LEARNINGS', (err as Error).message);
      } finally {
        setDeletingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [learnings],
  );

  if (loading) {
    return (
      <div className="space-y-2" data-testid="learnings-loading">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-12 animate-pulse bg-glass-l1 border border-glass-edge" />
        ))}
      </div>
    );
  }

  if (learnings.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-[#8a8a8a]" data-testid="learnings-empty">
        No learnings recorded yet.
      </div>
    );
  }

  return (
    <div data-testid="learnings-list">
      {learnings.map((learning, i) => (
        <div
          key={learning.id}
          className="group flex items-start justify-between gap-3 py-3"
          style={i === learnings.length - 1 ? undefined : ROW_DIVIDER}
          data-testid={`learning-row-${learning.id}`}
        >
          <div className="flex-1 min-w-0">
            <p className="text-sm text-white break-words">{learning.why}</p>
            <div className="mt-1 flex items-center gap-3 text-xs text-[#8a8a8a]">
              <span>
                used <span className="text-[#b5b5bd]">{learning.usage_count}</span>x
              </span>
              {learning.last_used_at && (
                <span>
                  last:{' '}
                  <span className="text-[#b5b5bd]">{formatDate(learning.last_used_at)}</span>
                </span>
              )}
              <span>
                added <span className="text-[#b5b5bd]">{formatDate(learning.created_at)}</span>
              </span>
            </div>
          </div>
          <button
            type="button"
            aria-label="Delete learning"
            data-testid={`delete-learning-${learning.id}`}
            disabled={deletingIds.has(learning.id)}
            className="focus-ring mt-0.5 shrink-0 text-xs text-[#8a8a8a] opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-400 focus-visible:opacity-100 disabled:opacity-40"
            onClick={() => handleDelete(learning.id)}
          >
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}

// ─── ReviewsSection (mounted by SettingsPage) ────────────────────────────────

export interface ReviewsSectionProps {
  scrollRef: (el: HTMLElement | null) => void;
}

export function ReviewsSection({ scrollRef }: ReviewsSectionProps) {
  const repoPaths = useRepoPaths();

  const initialRepo = (() => {
    const stored = localStorage.getItem(REPO_FILTER_KEY);
    if (stored) return stored;
    return null;
  })();

  const [selectedRepo, setSelectedRepo] = useState<string | null>(initialRepo);

  // Once task list resolves, pick a default if nothing is selected
  useEffect(() => {
    if (!selectedRepo && repoPaths.length > 0) {
      setSelectedRepo(repoPaths[0]);
    }
  }, [repoPaths, selectedRepo]);

  return (
    <SectionCard id="reviews" title="Reviews" scrollRef={scrollRef}>
      {repoPaths.length > 1 && (
        <div className="mb-3 flex items-center gap-2">
          <label className="text-xs text-[#8a8a8a]">Repo</label>
          <select
            data-testid="learnings-repo-select"
            value={selectedRepo ?? ''}
            onChange={(e) => setSelectedRepo(e.target.value)}
            className="focus-ring bg-[#0B0C0F] border border-glass-edge px-2 py-1 text-xs text-white outline-none focus:border-[#3B82F6]"
          >
            {repoPaths.map((p) => (
              <option key={p} value={p}>
                {repoName(p)}
              </option>
            ))}
          </select>
        </div>
      )}
      {selectedRepo ? (
        <LearningsPanel repoPath={selectedRepo} />
      ) : (
        <div className="py-8 text-center text-sm text-[#8a8a8a]">
          No repositories found. Create a task to get started.
        </div>
      )}
    </SectionCard>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(isoOrSqlite: string): string {
  const d = new Date(isoOrSqlite.replace(' ', 'T'));
  if (isNaN(d.getTime())) return isoOrSqlite;
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
