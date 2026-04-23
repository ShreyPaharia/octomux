import { useEffect, useRef } from 'react';

export interface ShortcutKeys {
  /** KeyboardEvent.key value — matched case-insensitively. */
  key: string;
  /** ⌘ on Mac, Ctrl elsewhere. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /mac/i.test(navigator.platform) || /Mac/i.test(navigator.userAgent);
}

export function matchShortcut(e: KeyboardEvent, keys: ShortcutKeys): boolean {
  const modPressed = isMac() ? e.metaKey : e.ctrlKey;
  const otherModPressed = isMac() ? e.ctrlKey : e.metaKey;
  const modRequired = !!keys.mod;
  if (modRequired !== modPressed) return false;
  if (modRequired && otherModPressed) return false;
  if ((keys.shift ?? false) !== e.shiftKey) return false;
  if ((keys.alt ?? false) !== e.altKey) return false;

  return e.key.toLowerCase() === keys.key.toLowerCase();
}

export function useGlobalShortcut(keys: ShortcutKeys, handler: (e: KeyboardEvent) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const { key, mod, shift, alt } = keys;
  useEffect(() => {
    const spec = { key, mod, shift, alt };
    const listener = (e: KeyboardEvent) => {
      if (matchShortcut(e, spec)) {
        handlerRef.current(e);
      }
    };
    window.addEventListener('keydown', listener, { capture: true });
    return () => window.removeEventListener('keydown', listener, { capture: true });
  }, [key, mod, shift, alt]);
}
