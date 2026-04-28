import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDiffKeyboardNav, DIFF_KEYBINDS } from './useDiffKeyboardNav.js';

function fire(
  key: string,
  mods: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = {},
) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, ...mods }));
}

describe('useDiffKeyboardNav', () => {
  it.each([
    ['j', 'onNextFile'],
    ['k', 'onPrevFile'],
    ['n', 'onNextHunk'],
    ['p', 'onPrevHunk'],
    ['r', 'onToggleReviewed'],
    ['c', 'onStartComment'],
  ] as const)('fires %s → %s', (key, handler) => {
    const handlers: Record<string, () => void> = {
      onNextFile: vi.fn(),
      onPrevFile: vi.fn(),
      onNextHunk: vi.fn(),
      onPrevHunk: vi.fn(),
      onToggleReviewed: vi.fn(),
      onStartComment: vi.fn(),
      onJumpToNextUnreviewed: vi.fn(),
      onSendBatch: vi.fn(),
    };
    renderHook(() => useDiffKeyboardNav(handlers));
    fire(key);
    expect(handlers[handler]).toHaveBeenCalled();
  });

  it('shift+J fires onJumpToNextUnreviewed', () => {
    const onJump = vi.fn();
    renderHook(() => useDiffKeyboardNav({ onJumpToNextUnreviewed: onJump } as never));
    fire('J', { shiftKey: true });
    expect(onJump).toHaveBeenCalled();
  });

  it.each([[{ metaKey: true }], [{ ctrlKey: true }]])(
    'mod+Enter fires onSendBatch (mods=%s)',
    (mods) => {
      const onSend = vi.fn();
      renderHook(() => useDiffKeyboardNav({ onSendBatch: onSend } as never));
      fire('Enter', mods);
      expect(onSend).toHaveBeenCalled();
    },
  );

  it('no-op when an input is focused', () => {
    const onNext = vi.fn();
    renderHook(() => useDiffKeyboardNav({ onNextFile: onNext } as never));
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fire('j');
    expect(onNext).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it('no-op when a textarea is focused', () => {
    const onNext = vi.fn();
    renderHook(() => useDiffKeyboardNav({ onNextFile: onNext } as never));
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    fire('j');
    expect(onNext).not.toHaveBeenCalled();
    document.body.removeChild(ta);
  });

  it('removes the listener on unmount', () => {
    const onNext = vi.fn();
    const { unmount } = renderHook(() => useDiffKeyboardNav({ onNextFile: onNext } as never));
    unmount();
    fire('j');
    expect(onNext).not.toHaveBeenCalled();
  });

  it('exports a non-empty DIFF_KEYBINDS array describing the shortcuts', () => {
    expect(Array.isArray(DIFF_KEYBINDS)).toBe(true);
    expect(DIFF_KEYBINDS.length).toBeGreaterThan(0);
    for (const kb of DIFF_KEYBINDS) {
      expect(typeof kb.keys).toBe('string');
      expect(kb.keys.length).toBeGreaterThan(0);
      expect(typeof kb.description).toBe('string');
      expect(kb.description.length).toBeGreaterThan(0);
    }
  });
});
