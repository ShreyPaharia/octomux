/**
 * Keep the terminal sized to the visible viewport above the mobile keyboard.
 * Pattern from ttyd (visualViewport resize/scroll) — see ttyd PR #1504.
 */
export function installTerminalVisualViewport(host: HTMLElement, onResize: () => void): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};

  const sync = () => {
    const hostRect = host.getBoundingClientRect();
    const available = Math.floor(vv.height + vv.offsetTop - hostRect.top);
    if (available > 80) {
      host.style.height = `${available}px`;
      host.style.maxHeight = `${available}px`;
    }
    onResize();
  };

  let rafId = 0;
  const scheduleSync = () => {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(sync);
  };

  vv.addEventListener('resize', scheduleSync);
  vv.addEventListener('scroll', scheduleSync);
  window.addEventListener('resize', scheduleSync);
  scheduleSync();

  return () => {
    cancelAnimationFrame(rafId);
    vv.removeEventListener('resize', scheduleSync);
    vv.removeEventListener('scroll', scheduleSync);
    window.removeEventListener('resize', scheduleSync);
    host.style.height = '';
    host.style.maxHeight = '';
  };
}
