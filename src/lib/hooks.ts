import { useState, useEffect, useCallback, useRef } from 'react';
import type { Task } from '@octomux/types';
import type {
  RepoConfig,
  AgentDefinition,
  HarnessSummary,
  IntegrationProvider,
  IntegrationRow,
  HookTemplate,
  OctomuxSettings,
} from './api/configApi';
import { taskApi } from './api/taskApi';
import { configApi } from './api/configApi';
import { reviewApi, type ReviewDetail } from './api/reviewApi';
import { subscribe } from './event-source';
import { useResource, REFETCH_THROTTLE_MS } from './use-resource';
import { throttle } from './throttle';

const DEFAULT_GRACE_HOURS = 6;

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastJsonRef = useRef<string>('');

  const refresh = useCallback(async () => {
    try {
      // Fetch active tasks and trash tasks in parallel so the board can
      // populate the trash column with soft-deleted tasks.
      const [active, trashed] = await Promise.all([
        taskApi.listTasks(),
        taskApi.listTasks({ trash: true }),
      ]);
      // Deduplicate by id (active wins) in case mock returns overlapping data in tests
      const seen = new Set(active.map((t) => t.id));
      const data = [...active, ...trashed.filter((t) => !seen.has(t.id))];
      // Only trigger a re-render when the task list actually changed.
      // Without this, every WebSocket event creates a new array reference
      // and causes the entire Dashboard + TaskList tree to re-render.
      const json = JSON.stringify(data);
      if (json !== lastJsonRef.current) {
        lastJsonRef.current = json;
        setTasks(data);
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Optimistically inject a newly created task into local state so the
  // sidebar/board reflect it before the next listTasks() round-trip lands.
  // The subsequent refresh from the WS event will reconcile with server state.
  const addOptimistic = useCallback((task: Task) => {
    setTasks((prev) => {
      if (prev.some((t) => t.id === task.id)) return prev;
      const next = [task, ...prev];
      lastJsonRef.current = JSON.stringify(next);
      return next;
    });
  }, []);

  useEffect(() => {
    refresh();
    // useTasks listens to every event of every task, so agent tool-call
    // broadcasts would otherwise refetch the full list per event.
    const throttled = throttle(() => void refresh(), REFETCH_THROTTLE_MS);
    const unsubscribe = subscribe(throttled);
    return () => {
      unsubscribe();
      throttled.cancel();
    };
  }, [refresh]);

  return { tasks, loading, error, refresh, addOptimistic };
}

export function useTask(id: string) {
  // Content-dedup (inside useResource) keeps the task object reference stable
  // unless the data actually changed, so an unrelated event can't re-render the
  // TaskDetail tree and remount its terminals.
  const { data, loading, error, refresh } = useResource<Task>(
    `task:${id}`,
    () => taskApi.getTask(id),
    {
      events: (event) => event.payload.taskId === id,
    },
  );
  return { task: data, loading, error, refresh };
}

export function useRepoConfigs() {
  const { data, loading, error, refresh } = useResource<RepoConfig[]>('repo-configs', () =>
    configApi.listRepoConfigs(),
  );
  return { configs: data ?? [], loading, error, refresh };
}

export function useAgents() {
  const { data, loading, error, refresh } = useResource<AgentDefinition[]>('agents', () =>
    configApi.listAgents(),
  );
  return { agents: data ?? [], loading, error, refresh };
}

export function useHarnesses() {
  const { data, loading, error, refresh } = useResource<HarnessSummary[]>('harnesses', () =>
    configApi.listHarnesses(),
  );
  return { harnesses: data ?? [], loading, error, refresh };
}

export function useGraceHours() {
  const { data } = useResource('settings:grace-hours', async () => {
    try {
      const settings = await configApi.getSettings();
      return settings.deleteGraceHours ?? DEFAULT_GRACE_HOURS;
    } catch {
      return DEFAULT_GRACE_HOURS;
    }
  });
  return { graceHours: data ?? DEFAULT_GRACE_HOURS };
}

export function useProviders() {
  const { data, loading, error, refresh } = useResource<IntegrationProvider[]>('providers', () =>
    configApi.listProviders(),
  );
  return { providers: data ?? [], loading, error, refresh };
}

export function useIntegrations() {
  const { data, loading, error, refresh } = useResource<IntegrationRow[]>('integrations', () =>
    configApi.listIntegrations(),
  );
  return { integrations: data ?? [], loading, error, refresh };
}

export function useHookTemplates() {
  const { data, loading, error, refresh } = useResource<HookTemplate[]>(
    'hook-templates',
    async () => {
      try {
        return await configApi.listHookTemplates();
      } catch {
        return [];
      }
    },
  );
  return { hookTemplates: data ?? [], loading, error, refresh };
}

export function useSettings() {
  const { data, loading, error, refresh } = useResource<OctomuxSettings | null>(
    'settings',
    async () => {
      try {
        return await configApi.getSettings();
      } catch {
        return null;
      }
    },
  );
  return { settings: data, loading, error, refresh };
}

export function useReviewDetail(id: string | undefined) {
  const { data, loading, error, refresh } = useResource<ReviewDetail>(
    id ? `review:${id}` : null,
    () => reviewApi.getReviewDetail(id!),
    {
      events: (e) =>
        e.payload.taskId === id &&
        (e.type === 'review:drafts-ready' || e.type === 'review:published'),
    },
  );
  return { detail: data, loading, error, refresh };
}
