import { useState, useEffect, useCallback, useRef } from 'react';
import type { Task } from '../../server/types';
import { api } from './api';

export function useOrchestrator(pollInterval = 5000) {
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    intervalRef.current = setInterval(refresh, pollInterval);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refresh, pollInterval]);

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

export function useTasks(pollInterval = 5000) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listTasks();
      setTasks(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    intervalRef.current = setInterval(refresh, pollInterval);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refresh, pollInterval]);

  return { tasks, loading, error, refresh };
}

export function useTask(id: string, pollInterval = 5000) {
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.getTask(id);
      setTask(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    refresh();
    intervalRef.current = setInterval(refresh, pollInterval);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refresh, pollInterval]);

  return { task, loading, error, refresh };
}
