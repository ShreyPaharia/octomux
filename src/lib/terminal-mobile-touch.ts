/**
 * Mobile agent terminal touch handling.
 *
 * Touch devices never emit `wheel` events, so on a phone xterm's mouse-wheel
 * handling never fires. That matters because xterm only scrolls via wheel:
 *   - Normal buffer (a shell/log): the wheel scrolls xterm's own scrollback.
 *   - Alternate buffer with mouse tracking (the Claude Code TUI): xterm encodes
 *     the wheel as a mouse-wheel escape and sends it to the PTY, so the TUI
 *     scrolls itself.
 * `term.scrollLines()` only moves the scrollback buffer, so it does nothing in
 * the alternate buffer. We therefore translate finger drags into synthetic
 * `wheel` events, which xterm routes correctly for both buffer modes.
 *
 * Direction follows the universal mobile convention — content tracks the finger:
 * dragging up reveals newer output (wheel down), dragging down reveals older
 * scrollback (wheel up).
 */
export interface TerminalMobileTouchOptions {
  getLinePx?: () => number;
}

const DEFAULT_LINE_PX = 17;
const WHEEL_TARGET_SELECTORS = ['.xterm-screen', '.xterm-viewport', '.xterm'];

function defaultLinePx(host: HTMLElement): number {
  const row = host.querySelector('.xterm-rows > div');
  if (row) {
    const height = row.getBoundingClientRect().height;
    if (height > 0) return height;
  }
  return DEFAULT_LINE_PX;
}

function wheelTarget(host: HTMLElement): HTMLElement | null {
  for (const selector of WHEEL_TARGET_SELECTORS) {
    const el = host.querySelector(selector) as HTMLElement | null;
    if (el) return el;
  }
  return null;
}

/**
 * Scroll the terminal by `lines` via synthetic wheel events: positive scrolls
 * toward newer output (wheel down), negative toward older scrollback (wheel up).
 * One wheel event is dispatched per line so the alternate-buffer mouse-wheel
 * encoding (which ignores deltaY magnitude) advances proportionally too.
 */
export function scrollTerminalByWheel(host: HTMLElement, lines: number, linePx = DEFAULT_LINE_PX): void {
  if (!lines) return;
  const target = wheelTarget(host);
  if (!target) return;

  const rect = target.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  const deltaY = Math.sign(lines) * (linePx > 0 ? linePx : DEFAULT_LINE_PX);

  for (let i = 0; i < Math.abs(lines); i++) {
    target.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY,
        deltaMode: 0,
        clientX,
        clientY,
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
  }
}

export function installTerminalMobileTouch(
  host: HTMLElement,
  { getLinePx }: TerminalMobileTouchOptions = {},
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
    // line delta → wheel down; finger down → older scrollback → wheel up.
    const lineDelta = px > 0 ? Math.trunc(-accumulatedPx / px) : 0;
    if (lineDelta !== 0) {
      scrollTerminalByWheel(host, lineDelta, px);
      accumulatedPx += lineDelta * px;
    }

    // Capture phase: take over before the browser default so the page never
    // rubber-bands or triggers pull-to-refresh.
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
