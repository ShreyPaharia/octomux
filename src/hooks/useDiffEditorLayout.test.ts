import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { useDiffEditorLayout } from './useDiffEditorLayout';

describe('useDiffEditorLayout', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn(() => ({
        observe: vi.fn(),
        disconnect: vi.fn(),
        unobserve: vi.fn(),
      })),
    );
    vi.stubGlobal(
      'IntersectionObserver',
      vi.fn(() => ({
        observe: vi.fn(),
        disconnect: vi.fn(),
        unobserve: vi.fn(),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls editor.layout when editor and container are present', () => {
    const layout = vi.fn();
    const editor = { layout } as unknown as import('monaco-editor').editor.IStandaloneDiffEditor;

    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { value: 640, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
    document.body.appendChild(el);

    const { result } = renderHook(() => {
      const ref = useRef<HTMLDivElement | null>(el);
      useDiffEditorLayout(editor, ref);
      return ref;
    });

    expect(result.current.current).toBe(el);
    expect(layout).toHaveBeenCalledWith({ width: 640, height: 400 });

    el.remove();
  });
});
