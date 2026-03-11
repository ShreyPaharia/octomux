import { useState, useEffect, useCallback, useRef } from 'react';
import type { Task } from '../../server/types';
import { api } from './api';
import { subscribe } from './event-source';

/**
 * Wraps an async function so that concurrent calls are deduplicated.
 * If a call is already in-flight, subsequent calls return the existing promise
 * instead of firing a new request.
 */
function dedup<T>(fn: () => Promise<T>): () => Promise<T> {
  let inflight: Promise<T> | null = null;
  return () => {
    if (inflight) return inflight;
    inflight = fn().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}

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
    return subscribe(refresh);
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

  // Deduplicate: rapid WebSocket events can trigger many refreshes, but only
  // one API call should be in-flight at a time.
  const refreshImpl = useCallback(async () => {
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

  const dedupedRef = useRef(dedup(refreshImpl));
  useEffect(() => {
    dedupedRef.current = dedup(refreshImpl);
  }, [refreshImpl]);

  const refresh = useCallback(() => dedupedRef.current(), []);

  useEffect(() => {
    refresh();
    return subscribe(refresh);
  }, [refresh]);

  return { tasks, loading, error, refresh };
}

export function useTask(id: string) {
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastJsonRef = useRef<string>('');

  // Deduplicate: rapid WebSocket events can trigger many refreshes, but only
  // one API call should be in-flight at a time.
  const refreshImpl = useCallback(async () => {
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

  const dedupedRef = useRef(dedup(refreshImpl));
  useEffect(() => {
    dedupedRef.current = dedup(refreshImpl);
  }, [refreshImpl]);

  const refresh = useCallback(() => dedupedRef.current(), []);

  useEffect(() => {
    refresh();
    return subscribe(refresh);
  }, [refresh]);

  return { task, loading, error, refresh };
}
