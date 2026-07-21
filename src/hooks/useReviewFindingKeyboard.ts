import { useEffect } from 'react';

export interface ReviewFindingKeyHandlers {
  onNextFinding?: () => void;
  onPrevFinding?: () => void;
  onAccept?: () => void;
  onReject?: () => void;
  onJumpToCode?: () => void;
}

export interface ReviewFindingKeybind {
  keys: string;
  description: string;
}

export const REVIEW_FINDING_KEYBINDS: readonly ReviewFindingKeybind[] = [
  { keys: 'j', description: 'Next finding' },
  { keys: 'k', description: 'Previous finding' },
  { keys: 'a', description: 'Accept finding' },
  { keys: 'x', description: 'Reject finding' },
  { keys: 'g', description: 'Jump to code in diff' },
] as const;

function isEditableElement(t: unknown): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (t.isContentEditable) return true;
  return false;
}

export function useReviewFindingKeyboard(handlers: ReviewFindingKeyHandlers): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isEditableElement(e.target) || isEditableElement(document.activeElement)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case 'j':
          e.preventDefault();
          handlers.onNextFinding?.();
          break;
        case 'k':
          e.preventDefault();
          handlers.onPrevFinding?.();
          break;
        case 'a':
          e.preventDefault();
          handlers.onAccept?.();
          break;
        case 'x':
          e.preventDefault();
          handlers.onReject?.();
          break;
        case 'g':
          e.preventDefault();
          handlers.onJumpToCode?.();
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlers]);
}
