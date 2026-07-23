import { useEffect } from 'react';

export interface ReviewFindingKeyHandlers {
  onNextFinding?: () => void;
  onPrevFinding?: () => void;
  onAccept?: () => void;
  onReject?: () => void;
  onEdit?: () => void;
  onJumpToCode?: () => void;
  onNextFile?: () => void;
  onPrevFile?: () => void;
  onNextUnreviewed?: () => void;
  onPublish?: () => void;
  onToggleCheatsheet?: () => void;
}

export interface ReviewFindingKeybind {
  keys: string;
  description: string;
}

/** Advertised shortcuts — every entry here is wired to a real handler below. */
export const REVIEW_FINDING_KEYBINDS: readonly ReviewFindingKeybind[] = [
  { keys: 'j / k', description: 'Next / prev finding' },
  { keys: 'a', description: 'Accept' },
  { keys: 'r', description: 'Reject' },
  { keys: 'e', description: 'Edit' },
  { keys: '↵', description: 'Jump to code' },
  { keys: '] / [', description: 'Next / prev file' },
  { keys: '⇧N', description: 'Next unreviewed file' },
  { keys: '⌘/Ctrl ↵', description: 'Publish' },
  { keys: '?', description: 'Toggle shortcuts' },
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
    function fire(handler: (() => void) | undefined, e: KeyboardEvent): void {
      if (!handler) return;
      e.preventDefault();
      handler();
    }

    function onKey(e: KeyboardEvent) {
      const editable = isEditableElement(e.target) || isEditableElement(document.activeElement);

      // Cmd/Ctrl+Enter publishes even from within an editor (batch-then-publish).
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        fire(handlers.onPublish, e);
        return;
      }
      if (editable || e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case 'j':
          fire(handlers.onNextFinding, e);
          break;
        case 'k':
          fire(handlers.onPrevFinding, e);
          break;
        case 'a':
          fire(handlers.onAccept, e);
          break;
        case 'r':
          fire(handlers.onReject, e);
          break;
        case 'e':
          fire(handlers.onEdit, e);
          break;
        case 'Enter':
          fire(handlers.onJumpToCode, e);
          break;
        case ']':
          fire(handlers.onNextFile, e);
          break;
        case '[':
          fire(handlers.onPrevFile, e);
          break;
        case 'N': // Shift+N
          fire(handlers.onNextUnreviewed, e);
          break;
        case '?':
          fire(handlers.onToggleCheatsheet, e);
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlers]);
}
