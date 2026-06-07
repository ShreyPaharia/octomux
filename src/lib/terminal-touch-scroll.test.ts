import { describe, it, expect, afterEach } from 'vitest';
import { installTerminalTouchScroll } from './terminal-touch-scroll';

describe('installTerminalTouchScroll', () => {
  let root: HTMLDivElement;

  afterEach(() => {
    root?.remove();
  });

  it('scrolls the xterm viewport on touchmove', () => {
    root = document.createElement('div');
    root.innerHTML = `
      <div class="xterm">
        <div class="xterm-viewport" style="overflow-y: scroll; height: 100px;">
          <div class="xterm-screen"></div>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    const viewport = root.querySelector('.xterm-viewport') as HTMLElement;
    Object.defineProperty(viewport, 'scrollTop', { writable: true, value: 0 });

    const cleanup = installTerminalTouchScroll(root);
    const xterm = root.querySelector('.xterm')!;

    xterm.dispatchEvent(
      new TouchEvent('touchstart', {
        touches: [{ clientY: 100 } as Touch],
        targetTouches: [{ clientY: 100 } as Touch],
        changedTouches: [{ clientY: 100 } as Touch],
      }),
    );

    xterm.dispatchEvent(
      new TouchEvent('touchmove', {
        touches: [{ clientY: 60 } as Touch],
        targetTouches: [{ clientY: 60 } as Touch],
        changedTouches: [{ clientY: 60 } as Touch],
      }),
    );

    expect(viewport.scrollTop).toBe(40);
    cleanup();
  });

  it('no-ops when xterm markup is missing', () => {
    root = document.createElement('div');
    document.body.appendChild(root);
    expect(() => installTerminalTouchScroll(root)()).not.toThrow();
  });
});
