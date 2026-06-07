/**
 * Mobile browsers route vertical swipes to the document unless we capture them.
 * Scroll xterm's viewport manually and block default so the page does not move.
 */
export function installTerminalTouchScroll(host: HTMLElement): () => void {
  const viewport = host.querySelector('.xterm-viewport') as HTMLElement | null;
  if (!viewport) return () => {};

  host.classList.add('octomux-terminal-touch-scroll');

  let lastTouchY = 0;
  let touching = false;

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    touching = true;
    lastTouchY = e.touches[0].clientY;
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!touching || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const delta = lastTouchY - y;
    if (delta !== 0) {
      viewport.scrollTop += delta;
      lastTouchY = y;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const onTouchEnd = () => {
    touching = false;
  };

  const capture = { capture: true } as const;
  const capturePassive = { capture: true, passive: true } as const;
  const captureActive = { capture: true, passive: false } as const;

  host.addEventListener('touchstart', onTouchStart, capturePassive);
  host.addEventListener('touchmove', onTouchMove, captureActive);
  host.addEventListener('touchend', onTouchEnd, capture);
  host.addEventListener('touchcancel', onTouchEnd, capture);

  return () => {
    host.removeEventListener('touchstart', onTouchStart, capturePassive);
    host.removeEventListener('touchmove', onTouchMove, captureActive);
    host.removeEventListener('touchend', onTouchEnd, capture);
    host.removeEventListener('touchcancel', onTouchEnd, capture);
    host.classList.remove('octomux-terminal-touch-scroll');
  };
}
