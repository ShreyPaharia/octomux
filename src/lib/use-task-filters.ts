import { useState, useMemo } from 'react';
import type { Task } from '../../server/types';
import { repoName } from './utils';

const REPO_FILTER_KEY = 'octomux-repo-filter';
const STATUS_FILTER_KEY = 'octomux-status-filter';

export type StatusTab = 'all' | 'running' | 'needs_you' | 'closed';

export interface TaskFilters {
  status: StatusTab;
  repo: string; // full repo_path or '' for all
}

const RUNNING_STATUSES = ['setting_up', 'running'];

const STATUS_TABS: readonly StatusTab[] = ['all', 'running', 'needs_you', 'closed'];

function isNeedsYou(t: Task): boolean {
  if (t.runtime_state === 'error') return true;
  if ((t.pending_prompts?.length ?? 0) > 0) return true;
  if (t.derived_status === 'needs_attention') return true;
  return false;
}

function readStatusTab(): StatusTab {
  const stored = localStorage.getItem(STATUS_FILTER_KEY);
  return stored && (STATUS_TABS as readonly string[]).includes(stored)
    ? (stored as StatusTab)
    : 'all';
}

export function useTaskFilters(tasks: Task[]) {
  const [filters, setFilters] = useState<TaskFilters>({
    status: readStatusTab(),
    repo: localStorage.getItem(REPO_FILTER_KEY) ?? '',
  });

  const repos = useMemo(() => {
    const paths = new Set(tasks.map((t) => t.repo_path));
    return [...paths].sort((a, b) => repoName(a).localeCompare(repoName(b)));
  }, [tasks]);

  const counts = useMemo(() => {
    const repoFiltered = filters.repo ? tasks.filter((t) => t.repo_path === filters.repo) : tasks;
    return {
      all: repoFiltered.length,
      running: repoFiltered.filter((t) => RUNNING_STATUSES.includes(t.runtime_state)).length,
      needs_you: repoFiltered.filter(isNeedsYou).length,
      closed: repoFiltered.filter((t) => t.runtime_state === 'idle').length,
    };
  }, [tasks, filters.repo]);

  const filtered = useMemo(() => {
    const result = tasks.filter((t) => {
      let statusMatch: boolean;
      if (filters.status === 'all') {
        statusMatch = true;
      } else if (filters.status === 'running') {
        statusMatch = RUNNING_STATUSES.includes(t.runtime_state);
      } else if (filters.status === 'needs_you') {
        statusMatch = isNeedsYou(t);
      } else {
        statusMatch = t.runtime_state === 'idle';
      }
      const repoMatch = !filters.repo || t.repo_path === filters.repo;
      return statusMatch && repoMatch;
    });

    // Priority sort: needs_attention → working → running → setting_up → error → draft
    const priorityOrder: Record<string, number> = {
      needs_attention: 0,
      working: 1,
      running: 2,
      setting_up: 3,
      error: 4,
      draft: 5,
    };
    result.sort((a, b) => {
      const aPriority = priorityOrder[a.derived_status ?? a.runtime_state] ?? 9;
      const bPriority = priorityOrder[b.derived_status ?? b.runtime_state] ?? 9;
      if (aPriority !== bPriority) return aPriority - bPriority;
      return b.created_at.localeCompare(a.created_at);
    });

    return result;
  }, [tasks, filters]);

  function setFilter<K extends keyof TaskFilters>(key: K, value: TaskFilters[K]) {
    if (key === 'repo') {
      localStorage.setItem(REPO_FILTER_KEY, value as string);
    } else if (key === 'status') {
      localStorage.setItem(STATUS_FILTER_KEY, value as string);
    }
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  return { filters, setFilter, filtered, counts, repos };
}
