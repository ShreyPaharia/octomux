import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTasks } from './hooks';

export type TasksState = ReturnType<typeof useTasks>;

const TasksContext = createContext<TasksState | null>(null);

/**
 * Mounts a single `useTasks()` subscription at app root so GlobalNotifications,
 * UniversalSidebar, and Dashboard don't each JSON.stringify + setState per
 * websocket event. HTTP is already deduped; the savings are in JSON work and
 * state-update cascades.
 */
export function TasksProvider({ children }: { children: ReactNode }) {
  const { tasks, loading, error, refresh, addOptimistic } = useTasks();
  const value = useMemo<TasksState>(
    () => ({ tasks, loading, error, refresh, addOptimistic }),
    [tasks, loading, error, refresh, addOptimistic],
  );
  return <TasksContext.Provider value={value}>{children}</TasksContext.Provider>;
}

export function useTasksContext(): TasksState {
  const ctx = useContext(TasksContext);
  if (!ctx) throw new Error('useTasksContext must be used within TasksProvider');
  return ctx;
}

/** Optional variant — returns null when no provider is mounted (e.g. isolated component tests). */
export function useTasksContextOptional(): TasksState | null {
  return useContext(TasksContext);
}
