/**
 * Stop terminal touch gestures from chaining to the document (pull-to-refresh).
 * xterm cancels touchmove only while the viewport still scrolls; at edges the
 * event bubbles and mobile browsers trigger pull-to-refresh.
 */
export function installTerminalTouchIsolation(host: HTMLElement): () => void {
  const xtermEl = host.querySelector('.xterm');
  const viewport = host.querySelector('.xterm-viewport') as HTMLElement | null;
  if (!xtermEl || !viewport) return () => {};

  let lastY = 0;
  let active = false;

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    active = true;
    lastY = e.touches[0].clientY;
    e.stopPropagation();
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!active || e.touches.length !== 1) return;
    const y = e.touches[0].clientY;
    const deltaY = y - lastY;
    lastY = y;

    e.stopPropagation();

    const maxScroll = viewport.scrollHeight - viewport.clientHeight;
    const atTop = viewport.scrollTop <= 0;
    const atBottom = maxScroll <= 0 || viewport.scrollTop >= maxScroll - 1;

    if ((atTop && deltaY > 0) || (atBottom && deltaY < 0)) {
      e.preventDefault();
    }
  };

  const onTouchEnd = () => {
    active = false;
  };

  const passive = { passive: true } as const;
  const activeOpts = { passive: false } as const;

  xtermEl.addEventListener('touchstart', onTouchStart, passive);
  xtermEl.addEventListener('touchmove', onTouchMove, activeOpts);
  xtermEl.addEventListener('touchend', onTouchEnd, passive);
  xtermEl.addEventListener('touchcancel', onTouchEnd, passive);

  return () => {
    xtermEl.removeEventListener('touchstart', onTouchStart, passive);
    xtermEl.removeEventListener('touchmove', onTouchMove, activeOpts);
    xtermEl.removeEventListener('touchend', onTouchEnd, passive);
    xtermEl.removeEventListener('touchcancel', onTouchEnd, passive);
  };
}
