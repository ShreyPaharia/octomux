/**
 * Wheel coalescing for remote alt-screen TUIs.
 *
 * In the alternate buffer (the Claude Code TUI) every wheel event becomes a
 * mouse report to the PTY, and the TUI repaints per report — so one trackpad
 * flick generates dozens of full-screen repaints that trail in over a slow
 * link for seconds. This interceptor accumulates real wheel deltas and
 * replays the net scroll as synthetic wheel bursts at most once per
 * FLUSH_INTERVAL_MS (leading edge immediate, so a single notch stays
 * instant). Normal-buffer scrolling is untouched — xterm handles it locally
 * with zero network cost.
 */
import { scrollTerminalByWheel, isSyntheticWheel, defaultLinePx } from './terminal-mobile-touch';

const FLUSH_INTERVAL_MS = 50;

export interface WheelCoalesceOptions {
  getLinePx?: () => number;
}

interface TermBufferInfo {
  buffer: { active: { type: string } };
}

export function installTerminalWheelCoalesce(
  host: HTMLElement,
  term: TermBufferInfo,
  { getLinePx }: WheelCoalesceOptions = {},
): () => void {
  let pendingPx = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const linePx = () => getLinePx?.() ?? defaultLinePx(host);

  /** Replay whole accumulated lines; keep the sub-line remainder. */
  const flush = (): boolean => {
    const px = linePx();
    const lines = px > 0 ? Math.trunc(pendingPx / px) : 0;
    if (lines === 0) return false;
    pendingPx -= lines * px;
    scrollTerminalByWheel(host, lines, px);
    return true;
  };

  const onTimer = () => {
    if (flush()) {
      timer = setTimeout(onTimer, FLUSH_INTERVAL_MS);
    } else {
      timer = null;
      pendingPx = 0;
    }
  };

  const onWheel = (e: WheelEvent) => {
    if (isSyntheticWheel(e)) return; // our own replays + mobile-touch events
    if (term.buffer.active.type !== 'alternate') return; // local scrollback — free
    e.preventDefault();
    e.stopPropagation();
    pendingPx += e.deltaMode === 1 ? e.deltaY * linePx() : e.deltaY;
    if (timer === null) {
      flush(); // leading edge: first movement reacts within one RTT
      timer = setTimeout(onTimer, FLUSH_INTERVAL_MS);
    }
  };

  host.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => {
    host.removeEventListener('wheel', onWheel, { capture: true });
    if (timer !== null) clearTimeout(timer);
  };
}
