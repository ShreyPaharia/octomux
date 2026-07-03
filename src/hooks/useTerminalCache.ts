import { useState, useEffect, useRef } from 'react';
import { useTerminalCacheSize } from '@/lib/terminal-cache-settings';
import { getPerTaskUiState } from '@/hooks/perTaskUiState';

export interface UseTerminalCacheOptions {
  taskId: string;
  activeWindow: number | null;
  validWindowIndexes: Set<number>;
}

export interface UseTerminalCacheResult {
  terminalLRU: number[];
}

export function useTerminalCache({
  taskId,
  activeWindow,
  validWindowIndexes,
}: UseTerminalCacheOptions): UseTerminalCacheResult {
  const terminalCacheSize = useTerminalCacheSize();
  const [terminalLRU, setTerminalLRU] = useState<number[]>([]);
  const prevTaskIdRef = useRef<string>(taskId);

  useEffect(() => {
    const prevId = prevTaskIdRef.current;
    if (prevId !== taskId) {
      const saved = getPerTaskUiState(taskId);
      const nextActive = saved?.activeWindow ?? null;
      setTerminalLRU(nextActive !== null ? [nextActive] : []);
      prevTaskIdRef.current = taskId;
    }
  }, [taskId]);

  useEffect(() => {
    if (activeWindow === null) return;
    setTerminalLRU((prev) => {
      const without = prev.filter((k) => k !== activeWindow);
      const next = [activeWindow, ...without].slice(0, terminalCacheSize);
      if (next.length === prev.length && next.every((k, i) => k === prev[i])) return prev;
      return next;
    });
  }, [activeWindow, terminalCacheSize]);

  useEffect(() => {
    setTerminalLRU((prev) =>
      prev.length <= terminalCacheSize ? prev : prev.slice(0, terminalCacheSize),
    );
  }, [terminalCacheSize]);

  useEffect(() => {
    setTerminalLRU((prev) => {
      const filtered = prev.filter((k) => validWindowIndexes.has(k));
      return filtered.length === prev.length ? prev : filtered;
    });
  }, [validWindowIndexes]);

  return { terminalLRU };
}
