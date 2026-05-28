import { useEffect, useState } from 'react';

const STORAGE_KEY = 'octomux-terminal-cache-size';
const CHANGE_EVENT = 'octomux:terminal-cache-size-changed';

export const TERMINAL_CACHE_DEFAULT = 3;
export const TERMINAL_CACHE_MIN = 1;
export const TERMINAL_CACHE_MAX = 20;

function clamp(n: number): number {
  return Math.max(TERMINAL_CACHE_MIN, Math.min(TERMINAL_CACHE_MAX, Math.floor(n)));
}

export function getTerminalCacheSize(): number {
  if (typeof localStorage === 'undefined') return TERMINAL_CACHE_DEFAULT;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return TERMINAL_CACHE_DEFAULT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return TERMINAL_CACHE_DEFAULT;
  return clamp(n);
}

export function setTerminalCacheSize(n: number): number {
  const clamped = clamp(n);
  localStorage.setItem(STORAGE_KEY, String(clamped));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: clamped }));
  return clamped;
}

export function useTerminalCacheSize(): number {
  const [size, setSize] = useState(getTerminalCacheSize);
  useEffect(() => {
    const handler = () => setSize(getTerminalCacheSize());
    window.addEventListener(CHANGE_EVENT, handler);
    return () => window.removeEventListener(CHANGE_EVENT, handler);
  }, []);
  return size;
}
