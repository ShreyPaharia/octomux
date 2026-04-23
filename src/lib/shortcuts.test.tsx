import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { matchShortcut, useGlobalShortcut } from './shortcuts';

function setPlatform(platform: string) {
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
}

afterEach(() => {
  setPlatform('MacIntel');
});

describe('matchShortcut', () => {
  it.each([
    {
      name: 'mac: meta+k matches',
      platform: 'MacIntel',
      event: { key: 'k', metaKey: true },
      spec: { key: 'k', mod: true },
      expected: true,
    },
    {
      name: 'mac: ctrl+k does NOT match mod',
      platform: 'MacIntel',
      event: { key: 'k', ctrlKey: true },
      spec: { key: 'k', mod: true },
      expected: false,
    },
    {
      name: 'linux: ctrl+k matches mod',
      platform: 'Linux x86_64',
      event: { key: 'k', ctrlKey: true },
      spec: { key: 'k', mod: true },
      expected: true,
    },
    {
      name: 'linux: meta+k does NOT match mod',
      platform: 'Win32',
      event: { key: 'k', metaKey: true },
      spec: { key: 'k', mod: true },
      expected: false,
    },
    {
      name: 'case-insensitive key (Shift+K)',
      platform: 'MacIntel',
      event: { key: 'K', metaKey: true, shiftKey: true },
      spec: { key: 'n', mod: true, shift: true }, // different key → false
      expected: false,
    },
    {
      name: 'case-insensitive key (K matches k)',
      platform: 'MacIntel',
      event: { key: 'K', metaKey: true, shiftKey: true },
      spec: { key: 'k', mod: true, shift: true },
      expected: true,
    },
    {
      name: 'shift required but not pressed',
      platform: 'MacIntel',
      event: { key: 'n', metaKey: true },
      spec: { key: 'n', mod: true, shift: true },
      expected: false,
    },
    {
      name: 'shift pressed but not required → reject (strict match)',
      platform: 'MacIntel',
      event: { key: 'k', metaKey: true, shiftKey: true },
      spec: { key: 'k', mod: true },
      expected: false,
    },
    {
      name: 'alt required',
      platform: 'MacIntel',
      event: { key: 'a', metaKey: true, altKey: true },
      spec: { key: 'a', mod: true, alt: true },
      expected: true,
    },
    {
      name: 'no mod required, plain Enter',
      platform: 'MacIntel',
      event: { key: 'Enter' },
      spec: { key: 'Enter' },
      expected: true,
    },
    {
      name: 'ArrowDown with cmd on mac',
      platform: 'MacIntel',
      event: { key: 'ArrowDown', metaKey: true },
      spec: { key: 'ArrowDown', mod: true },
      expected: true,
    },
  ])('$name', ({ platform, event, spec, expected }) => {
    setPlatform(platform);
    const ke = new KeyboardEvent('keydown', {
      key: event.key,
      metaKey: event.metaKey ?? false,
      ctrlKey: event.ctrlKey ?? false,
      shiftKey: event.shiftKey ?? false,
      altKey: event.altKey ?? false,
    });
    expect(matchShortcut(ke, spec)).toBe(expected);
  });
});

describe('useGlobalShortcut', () => {
  beforeEach(() => setPlatform('MacIntel'));

  function Harness({ onFire }: { onFire: (e: KeyboardEvent) => void }) {
    useGlobalShortcut({ key: 'k', mod: true }, onFire);
    return null;
  }

  function dispatchCmdK() {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
  }

  it('installs on mount and fires handler', () => {
    const fn = vi.fn();
    render(<Harness onFire={fn} />);
    dispatchCmdK();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('removes listener on unmount — handler not called after unmount', () => {
    const fn = vi.fn();
    const { unmount } = render(<Harness onFire={fn} />);
    unmount();
    dispatchCmdK();
    expect(fn).not.toHaveBeenCalled();
  });

  it('ignores non-matching events', () => {
    const fn = vi.fn();
    render(<Harness onFire={fn} />);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' })); // no mod
    expect(fn).not.toHaveBeenCalled();
  });

  it('uses the latest handler without rebinding', () => {
    const a = vi.fn();
    const b = vi.fn();
    function H({ h }: { h: (e: KeyboardEvent) => void }) {
      useGlobalShortcut({ key: 'k', mod: true }, h);
      return null;
    }
    const { rerender } = render(<H h={a} />);
    dispatchCmdK();
    rerender(<H h={b} />);
    dispatchCmdK();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
