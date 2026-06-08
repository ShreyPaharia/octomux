/**
 * Mobile agent terminal touch handling.
 *
 * xterm keeps viewport.scrollTop at 0 while scrollback lives in the internal
 * buffer (scrollLines / ydisp), so native touch-drag does not move the view on
 * real phones. We mirror finger movement into scrollLines() and take over the
 * gesture (preventDefault) so the browser never starts native scrolling or
 * pull-to-refresh.
 *
 * Direction follows the universal mobile convention — content tracks the finger:
 * dragging up reveals newer output (scroll forward), dragging down reveals older
 * scrollback (scroll back).
 */
export interface TerminalMobileTouchOptions {
  onScrollLines: (lines: number) => void;
  getLinePx?: () => number;
}

function defaultLinePx(host: HTMLElement): number {
  const row = host.querySelector('.xterm-rows > div');
  if (row) {
    const height = row.getBoundingClientRect().height;
    if (height > 0) return height;
  }
  return 17;
}

export function installTerminalMobileTouch(
  host: HTMLElement,
  { onScrollLines, getLinePx }: TerminalMobileTouchOptions,
): () => void {
  if (!host.querySelector('.xterm')) return () => {};

  let lastY = 0;
  let active = false;
  let accumulatedPx = 0;
  const linePx = () => getLinePx?.() ?? defaultLinePx(host);

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    if (!host.contains(e.target as Node)) return;
    active = true;
    lastY = e.touches[0].clientY;
    accumulatedPx = 0;
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!active || e.touches.length !== 1) return;
    if (!host.contains(e.target as Node)) return;
    const y = e.touches[0].clientY;
    const deltaY = y - lastY;
    lastY = y;

    accumulatedPx += deltaY;
    const px = linePx();
    // Content follows finger: finger up (deltaY < 0) → newer output → positive
    // scrollLines; finger down → older scrollback → negative scrollLines.
    const lineDelta = px > 0 ? Math.trunc(-accumulatedPx / px) : 0;
    if (lineDelta !== 0) {
      onScrollLines(lineDelta);
      accumulatedPx += lineDelta * px;
    }

    // Capture phase: take over before xterm/browser default scrolling so the
    // page never rubber-bands or triggers pull-to-refresh.
    e.preventDefault();
    e.stopPropagation();
  };

  const onTouchEnd = () => {
    active = false;
    accumulatedPx = 0;
  };

  const capturePassive = { capture: true, passive: true } as const;
  const captureActive = { capture: true, passive: false } as const;

  host.addEventListener('touchstart', onTouchStart, capturePassive);
  host.addEventListener('touchmove', onTouchMove, captureActive);
  host.addEventListener('touchend', onTouchEnd, capturePassive);
  host.addEventListener('touchcancel', onTouchEnd, capturePassive);

  return () => {
    host.removeEventListener('touchstart', onTouchStart, capturePassive);
    host.removeEventListener('touchmove', onTouchMove, captureActive);
    host.removeEventListener('touchend', onTouchEnd, capturePassive);
    host.removeEventListener('touchcancel', onTouchEnd, capturePassive);
  };
}
