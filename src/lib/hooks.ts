import { useState, useEffect, useCallback, useRef } from 'react';
import type { Task } from '../../server/types';
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

  return { running, loading, error, start, stop, refresh };
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
