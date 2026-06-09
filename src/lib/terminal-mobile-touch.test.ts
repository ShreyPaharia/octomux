import { describe, it, expect, afterEach } from 'vitest';
import { installTerminalMobileTouch, scrollTerminalByWheel } from './terminal-mobile-touch';

describe('terminal-mobile-touch', () => {
  let host: HTMLDivElement;

  afterEach(() => {
    host?.remove();
  });

  /** Build a host that mirrors the rendered xterm DOM and capture wheel deltaY. */
  function setupHost() {
    host = document.createElement('div');
    host.className = 'octomux-terminal-host';
    host.innerHTML = `
      <div class="xterm">
        <div class="xterm-rows"><div style="height:20px"></div></div>
        <div class="xterm-screen"></div>
        <div class="xterm-viewport"></div>
      </div>
    `;
    document.body.appendChild(host);
    const screen = host.querySelector('.xterm-screen') as HTMLElement;
    const deltas: number[] = [];
    screen.addEventListener('wheel', (e) => deltas.push((e as WheelEvent).deltaY));
    return { screen, deltas };
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

  describe('installTerminalMobileTouch', () => {
    it('finger-up drag dispatches wheel-down events (newer output)', () => {
      const { screen, deltas } = setupHost();
      const cleanup = installTerminalMobileTouch(host, { getLinePx: () => 20 });

      fireTouch(screen, 'touchstart', 100);
      fireTouch(screen, 'touchmove', 40, true); // up 60px = 3 lines

      // Content follows finger: up reveals newer output → wheel scrolls down (deltaY > 0).
      expect(deltas).toEqual([20, 20, 20]);
      cleanup();
    });

    it('finger-down drag dispatches wheel-up events (older scrollback)', () => {
      const { screen, deltas } = setupHost();
      const cleanup = installTerminalMobileTouch(host, { getLinePx: () => 20 });

      fireTouch(screen, 'touchstart', 40);
      fireTouch(screen, 'touchmove', 100, true); // down 60px = 3 lines

      expect(deltas).toEqual([-20, -20, -20]);
      cleanup();
    });

    it('takes over the gesture so the page does not scroll / pull-to-refresh', () => {
      const { screen } = setupHost();
      const cleanup = installTerminalMobileTouch(host, { getLinePx: () => 20 });

      fireTouch(screen, 'touchstart', 100);
      const move = fireTouch(screen, 'touchmove', 40, true);

      expect(move.defaultPrevented).toBe(true);
      cleanup();
    });

    it('no-ops when xterm markup is missing', () => {
      host = document.createElement('div');
      document.body.appendChild(host);
      expect(() => installTerminalMobileTouch(host, {})()).not.toThrow();
    });
  });

  describe('scrollTerminalByWheel', () => {
    it('dispatches one wheel-up event per line for older scrollback', () => {
      const { deltas } = setupHost();
      scrollTerminalByWheel(host, -5, 17);
      expect(deltas).toEqual([-17, -17, -17, -17, -17]);
    });

    it('dispatches one wheel-down event per line for newer output', () => {
      const { deltas } = setupHost();
      scrollTerminalByWheel(host, 2, 17);
      expect(deltas).toEqual([17, 17]);
    });

    it('no-ops on zero lines or when no terminal is present', () => {
      const { deltas } = setupHost();
      scrollTerminalByWheel(host, 0, 17);
      expect(deltas).toEqual([]);

      const empty = document.createElement('div');
      expect(() => scrollTerminalByWheel(empty, -3, 17)).not.toThrow();
    });
  });
});
