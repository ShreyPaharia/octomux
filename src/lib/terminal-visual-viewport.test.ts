import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { installTerminalVisualViewport } from './terminal-visual-viewport';

describe('installTerminalVisualViewport', () => {
  let host: HTMLDivElement;
  let onResize: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    onResize = vi.fn();
    vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 500,
      left: 0,
      right: 400,
      width: 400,
      height: 400,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    });
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  it('sizes host to visible viewport and calls onResize', async () => {
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: {
        height: 400,
        offsetTop: 0,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });

    const cleanup = installTerminalVisualViewport(host, onResize);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    expect(host.style.height).toBe('300px');
    expect(onResize).toHaveBeenCalled();
    cleanup();
    expect(host.style.height).toBe('');
  });

  it('no-ops when visualViewport is unavailable', () => {
    const original = window.visualViewport;
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: null });
    expect(() => installTerminalVisualViewport(host, onResize)()).not.toThrow();
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: original });
  });
});
