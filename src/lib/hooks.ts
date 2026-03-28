import { useState, useEffect, useCallback, useRef } from 'react';
import type { Task } from '../../server/types';
import type { Skill, OrchestratorPromptData, RepoConfig, AgentDefinition } from './api';
import { api } from './api';
import { subscribe } from './event-source';

export function useOrchestrator() {
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.orchestratorStatus();
      setRunning(data.running);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    return subscribe(() => refresh());
  }, [refresh]);

  const start = useCallback(async () => {
    try {
      await api.orchestratorStart();
      setRunning(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const stop = useCallback(async () => {
    try {
      await api.orchestratorStop();
      setRunning(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const restart = useCallback(async () => {
    try {
      await api.orchestratorStop();
      await api.orchestratorStart();
      setRunning(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  return { running, loading, error, start, stop, restart, refresh };
}

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastJsonRef = useRef<string>('');

  const refresh = useCallback(async () => {
    try {
      const data = await api.listTasks();
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

  useEffect(() => {
    refresh();
    return subscribe(() => refresh());
  }, [refresh]);

  return { tasks, loading, error, refresh };
}

export function useTask(id: string) {
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastJsonRef = useRef<string>('');

  const refresh = useCallback(async () => {
    try {
      const data = await api.getTask(id);
      // Only trigger a re-render when the task data actually changed.
      // Without this, every event creates a new object reference and causes
      // the entire TaskDetail tree to re-render, risking terminal remounts.
      const json = JSON.stringify(data);
      if (json !== lastJsonRef.current) {
        lastJsonRef.current = json;
        setTask(data);
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    refresh();
    return subscribe((event) => {
      if (event.payload.taskId === id) {
        refresh();
      }
    });
  }, [refresh, id]);

  return { task, loading, error, refresh };
}

export function useSkills() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listSkills();
      setSkills(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { skills, loading, error, refresh };
}

export function useRepoConfigs() {
  const [configs, setConfigs] = useState<RepoConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listRepoConfigs();
      setConfigs(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { configs, loading, error, refresh };
}

export function useAgents() {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listAgents();
      setAgents(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { agents, loading, error, refresh };
}

export function useOrchestratorPrompt() {
  const [data, setData] = useState<OrchestratorPromptData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.getOrchestratorPrompt();
      setData(result);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = useCallback(
    async (content: string) => {
      const result = await api.updateOrchestratorPrompt(content);
      await refresh();
      return result;
    },
    [refresh],
  );

  const reset = useCallback(async () => {
    const result = await api.resetOrchestratorPrompt();
    await refresh();
    return result;
  }, [refresh]);

  return { data, loading, error, save, reset, refresh };
}
