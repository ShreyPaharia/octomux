import { useState, useMemo } from 'react';
import type { Task } from '../../server/types';

const REPO_FILTER_KEY = 'octomux-repo-filter';
const STATUS_FILTER_KEY = 'octomux-status-filter';

export type StatusTab = 'open' | 'closed' | 'backlog';

export interface TaskFilters {
  status: StatusTab;
  repo: string; // full repo_path or '' for all
}

const OPEN_STATUSES = ['setting_up', 'running', 'error'];

export function useTaskFilters(tasks: Task[]) {
  const [filters, setFilters] = useState<TaskFilters>({
    status: (localStorage.getItem(STATUS_FILTER_KEY) as StatusTab) ?? 'open',
    repo: localStorage.getItem(REPO_FILTER_KEY) ?? '',
  });

  const repos = useMemo(() => {
    const paths = new Set(tasks.map((t) => t.repo_path));
    return [...paths].sort((a, b) => {
      const nameA = a.split('/').pop() || a;
      const nameB = b.split('/').pop() || b;
      return nameA.localeCompare(nameB);
    });
  }, [tasks]);

  const counts = useMemo(() => {
    const repoFiltered = filters.repo ? tasks.filter((t) => t.repo_path === filters.repo) : tasks;
    return {
      open: repoFiltered.filter((t) => OPEN_STATUSES.includes(t.status)).length,
      closed: repoFiltered.filter((t) => t.status === 'closed').length,
      backlog: repoFiltered.filter((t) => t.status === 'draft').length,
    };
  }, [tasks, filters.repo]);

  const filtered = useMemo(() => {
    const result = tasks.filter((t) => {
      let statusMatch: boolean;
      if (filters.status === 'open') {
        statusMatch = OPEN_STATUSES.includes(t.status);
      } else if (filters.status === 'backlog') {
        statusMatch = t.status === 'draft';
      } else {
        statusMatch = t.status === 'closed';
      }
      const repoMatch = !filters.repo || t.repo_path === filters.repo;
      return statusMatch && repoMatch;
    });

    // Sort open tasks: needs_attention first, then working, then others
    if (filters.status === 'open') {
      const priorityOrder: Record<string, number> = {
        needs_attention: 0,
        working: 1,
        running: 2,
        setting_up: 3,
        error: 4,
        draft: 5,
      };
      result.sort((a, b) => {
        const aPriority = priorityOrder[a.derived_status ?? a.status] ?? 9;
        const bPriority = priorityOrder[b.derived_status ?? b.status] ?? 9;
        if (aPriority !== bPriority) return aPriority - bPriority;
        // Within same priority, keep newest first
        return b.created_at.localeCompare(a.created_at);
      });
    }

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
