import { describe, it, expect, afterEach, vi } from 'vitest';
import { installTerminalTouchIsolation } from './terminal-touch-isolation';

describe('installTerminalTouchIsolation', () => {
  let host: HTMLDivElement;

  afterEach(() => {
    host?.remove();
  });

  it('stops propagation and prevents default at top edge pull-down', () => {
    host = document.createElement('div');
    host.innerHTML = `
      <div class="xterm">
        <div class="xterm-viewport" style="height: 100px; overflow-y: scroll;">
          <div style="height: 300px;"></div>
        </div>
      </div>
    `;
    document.body.appendChild(host);

    const viewport = host.querySelector('.xterm-viewport') as HTMLElement;
    Object.defineProperty(viewport, 'scrollTop', { writable: true, value: 0 });
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 300 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 100 });

    const cleanup = installTerminalTouchIsolation(host);
    const xterm = host.querySelector('.xterm')!;

    xterm.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        touches: [{ clientY: 50 } as Touch],
        targetTouches: [{ clientY: 50 } as Touch],
        changedTouches: [{ clientY: 50 } as Touch],
      }),
    );

    const move = new TouchEvent('touchmove', {
      bubbles: true,
      cancelable: true,
      touches: [{ clientY: 80 } as Touch],
      targetTouches: [{ clientY: 80 } as Touch],
      changedTouches: [{ clientY: 80 } as Touch],
    });
    const stopPropagation = vi.spyOn(move, 'stopPropagation');
    const preventDefault = vi.spyOn(move, 'preventDefault');
    xterm.dispatchEvent(move);

    expect(stopPropagation).toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalled();
    cleanup();
  });

  it('no-ops when xterm markup is missing', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    expect(() => installTerminalTouchIsolation(host)()).not.toThrow();
  });
});
