import { describe, it, expect, afterEach, vi } from 'vitest';
import { installTerminalTouchScroll } from './terminal-touch-scroll';

describe('installTerminalTouchScroll', () => {
  let root: HTMLDivElement;

  afterEach(() => {
    root?.remove();
  });

  it('scrolls the xterm viewport incrementally on touchmove', () => {
    root = document.createElement('div');
    root.innerHTML = `
      <div class="xterm">
        <div class="xterm-viewport" style="overflow-y: scroll; height: 100px;">
          <div class="xterm-screen" style="height: 400px;"></div>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    const viewport = root.querySelector('.xterm-viewport') as HTMLElement;
    let scrollTop = 0;
    Object.defineProperty(viewport, 'scrollTop', {
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
    });

    const cleanup = installTerminalTouchScroll(root);

    root.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        touches: [{ clientY: 100 } as Touch],
        targetTouches: [{ clientY: 100 } as Touch],
        changedTouches: [{ clientY: 100 } as Touch],
      }),
    );

    const move = new TouchEvent('touchmove', {
      bubbles: true,
      cancelable: true,
      touches: [{ clientY: 60 } as Touch],
      targetTouches: [{ clientY: 60 } as Touch],
      changedTouches: [{ clientY: 60 } as Touch],
    });
    const preventDefault = vi.spyOn(move, 'preventDefault');
    root.dispatchEvent(move);

    expect(scrollTop).toBe(40);
    expect(preventDefault).toHaveBeenCalled();
    cleanup();
    expect(root.classList.contains('octomux-terminal-touch-scroll')).toBe(false);
  });

  it('no-ops when xterm markup is missing', () => {
    root = document.createElement('div');
    document.body.appendChild(root);
    expect(() => installTerminalTouchScroll(root)()).not.toThrow();
  });
});
