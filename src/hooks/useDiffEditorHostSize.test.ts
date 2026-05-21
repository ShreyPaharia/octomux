import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { useDiffEditorHostSize } from './useDiffEditorHostSize';

describe('useDiffEditorHostSize', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns non-zero width in test env when host has zero clientWidth', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { value: 0, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 0, configurable: true });
    document.body.appendChild(el);

    const { result } = renderHook(() => {
      const ref = useRef(el);
      return useDiffEditorHostSize(ref, true);
    });

    expect(result.current.width).toBeGreaterThan(0);
    el.remove();
  });
});
