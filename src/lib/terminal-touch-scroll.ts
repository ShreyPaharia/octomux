/**
 * iOS Safari often won't scroll xterm's viewport when swiping the canvas layer.
 * Mirror touch drags into viewport.scrollTop so agent session history is reachable on mobile.
 */
export function installTerminalTouchScroll(root: HTMLElement): () => void {
  const xtermRoot = root.querySelector('.xterm');
  const viewport = root.querySelector('.xterm-viewport') as HTMLElement | null;
  if (!xtermRoot || !viewport) return () => {};

  let touchStartY = 0;
  let touchStartScrollTop = 0;
  let touching = false;

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    touching = true;
    touchStartY = e.touches[0].clientY;
    touchStartScrollTop = viewport.scrollTop;
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!touching || e.touches.length !== 1) return;
    const deltaY = touchStartY - e.touches[0].clientY;
    viewport.scrollTop = touchStartScrollTop + deltaY;
  };

  const onTouchEnd = () => {
    touching = false;
  };

  xtermRoot.addEventListener('touchstart', onTouchStart, { passive: true });
  xtermRoot.addEventListener('touchmove', onTouchMove, { passive: true });
  xtermRoot.addEventListener('touchend', onTouchEnd);
  xtermRoot.addEventListener('touchcancel', onTouchEnd);

  return () => {
    xtermRoot.removeEventListener('touchstart', onTouchStart);
    xtermRoot.removeEventListener('touchmove', onTouchMove);
    xtermRoot.removeEventListener('touchend', onTouchEnd);
    xtermRoot.removeEventListener('touchcancel', onTouchEnd);
  };
}
