import { describe, it, expect, afterEach, vi } from 'vitest';
import { installTerminalMobileTouch } from './terminal-mobile-touch';

describe('installTerminalMobileTouch', () => {
  let host: HTMLDivElement;

  afterEach(() => {
    host?.remove();
  });

  function setupHost() {
    host = document.createElement('div');
    host.innerHTML = `
      <div class="xterm">
        <div class="xterm-rows"><div style="height:20px"></div></div>
        <div class="xterm-viewport"></div>
      </div>
    `;
    document.body.appendChild(host);
    const canvas = document.createElement('canvas');
    host.querySelector('.xterm')!.appendChild(canvas);
    return canvas;
  }

  function fireTouch(
    target: HTMLElement,
    type: 'touchstart' | 'touchmove',
    clientY: number,
    cancelable = false,
  ) {
    const touch = { clientY, target } as unknown as Touch;
    const event = new TouchEvent(type, {
      bubbles: true,
      cancelable,
      touches: [touch],
      targetTouches: [touch],
      changedTouches: [touch],
    });
    target.dispatchEvent(event);
    return event;
  }

  it('maps finger-up drag to positive scrollLines (newer output)', () => {
    const canvas = setupHost();
    const onScrollLines = vi.fn();
    const cleanup = installTerminalMobileTouch(host, {
      onScrollLines,
      getLinePx: () => 20,
    });

    fireTouch(canvas, 'touchstart', 100);
    fireTouch(canvas, 'touchmove', 40, true);

    // Content follows finger: dragging up reveals newer output (scroll forward).
    expect(onScrollLines).toHaveBeenCalledWith(3);
    cleanup();
  });

  it('maps finger-down drag to negative scrollLines (older output)', () => {
    const canvas = setupHost();
    const onScrollLines = vi.fn();
    const cleanup = installTerminalMobileTouch(host, {
      onScrollLines,
      getLinePx: () => 20,
    });

    fireTouch(canvas, 'touchstart', 40);
    fireTouch(canvas, 'touchmove', 100, true);

    // Dragging down reveals older scrollback (scroll back).
    expect(onScrollLines).toHaveBeenCalledWith(-3);
    cleanup();
  });

  it('takes over the gesture so the page does not scroll / pull-to-refresh', () => {
    const canvas = setupHost();
    const cleanup = installTerminalMobileTouch(host, {
      onScrollLines: vi.fn(),
      getLinePx: () => 20,
    });

    fireTouch(canvas, 'touchstart', 100);
    const move = fireTouch(canvas, 'touchmove', 40, true);

    expect(move.defaultPrevented).toBe(true);
    cleanup();
  });

  it('no-ops when xterm markup is missing', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    expect(() =>
      installTerminalMobileTouch(host, { onScrollLines: vi.fn() })(),
    ).not.toThrow();
  });
});
