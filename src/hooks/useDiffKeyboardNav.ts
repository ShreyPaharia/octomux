import { useEffect } from 'react';

export interface DiffNavHandlers {
  onNextFile?: () => void;
  onPrevFile?: () => void;
  onNextHunk?: () => void;
  onPrevHunk?: () => void;
  onToggleReviewed?: () => void;
  onJumpToNextUnreviewed?: () => void;
  onStartComment?: () => void;
  onSendBatch?: () => void;
}

export interface DiffKeybind {
  keys: string;
  description: string;
}

export const DIFF_KEYBINDS: readonly DiffKeybind[] = [
  { keys: 'j', description: 'Next file' },
  { keys: 'k', description: 'Previous file' },
  { keys: 'n', description: 'Next hunk' },
  { keys: 'p', description: 'Previous hunk' },
  { keys: 'r', description: 'Toggle file reviewed' },
  { keys: 'Shift+J', description: 'Jump to next unreviewed file' },
  { keys: 'c', description: 'Start a comment on the focused line' },
  { keys: 'Cmd/Ctrl+Enter', description: 'Send batched comments to active agent' },
] as const;

function isEditableElement(t: unknown): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (t.isContentEditable) return true;
  return false;
}

export function useDiffKeyboardNav(handlers: DiffNavHandlers): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Events dispatched on window may have target === window even when an
      // input is focused, so also consult document.activeElement.
      if (isEditableElement(e.target) || isEditableElement(document.activeElement)) return;

      // Mod+Enter → send batch
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        handlers.onSendBatch?.();
        return;
      }

      switch (e.key) {
        case 'j':
          handlers.onNextFile?.();
          break;
        case 'k':
          handlers.onPrevFile?.();
          break;
        case 'n':
          handlers.onNextHunk?.();
          break;
        case 'p':
          handlers.onPrevHunk?.();
          break;
        case 'r':
          handlers.onToggleReviewed?.();
          break;
        case 'c':
          handlers.onStartComment?.();
          break;
        case 'J': // shift+j
          handlers.onJumpToNextUnreviewed?.();
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlers]);
}
