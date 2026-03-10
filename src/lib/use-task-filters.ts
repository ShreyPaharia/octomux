import { useState, useMemo } from 'react';
import type { Task } from '../../server/types';

export interface TaskFilters {
  status: 'open' | 'closed';
}

const OPEN_STATUSES = ['draft', 'setting_up', 'running', 'error'];

export function useTaskFilters(tasks: Task[]) {
  const [filters, setFilters] = useState<TaskFilters>({ status: 'open' });

  const counts = useMemo(
    () => ({
      open: tasks.filter((t) => OPEN_STATUSES.includes(t.status)).length,
      closed: tasks.filter((t) => t.status === 'closed').length,
    }),
    [tasks],
  );

  const filtered = useMemo(() => {
    return tasks.filter((t) =>
      filters.status === 'open' ? OPEN_STATUSES.includes(t.status) : t.status === 'closed',
    );
  }, [tasks, filters]);

  function setFilter<K extends keyof TaskFilters>(key: K, value: TaskFilters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  return { filters, setFilter, filtered, counts };
}
