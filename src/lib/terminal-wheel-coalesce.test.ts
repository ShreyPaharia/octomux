import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { installTerminalWheelCoalesce } from './terminal-wheel-coalesce';
import { scrollTerminalByWheel } from './terminal-mobile-touch';

describe('terminal-wheel-coalesce', () => {
  let host: HTMLDivElement;
  let cleanup: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup?.();
    cleanup = null;
    host?.remove();
    vi.useRealTimers();
  });

  function setupHost() {
    host = document.createElement('div');
    host.className = 'octomux-terminal-host';
    host.innerHTML = `
      <div class="xterm">
        <div class="xterm-rows"><div style="height:20px"></div></div>
        <div class="xterm-screen"></div>
        <div class="xterm-viewport"></div>
      </div>
    `;
    document.body.appendChild(host);
    const screen = host.querySelector('.xterm-screen') as HTMLElement;
    // Synthetic replays are the only wheel events that survive interception
    // in the alt buffer, so counting deltas on the target counts replays.
    const deltas: number[] = [];
    screen.addEventListener('wheel', (e) => deltas.push((e as WheelEvent).deltaY));
    return { screen, deltas };
  }

  function makeTerm(type: 'normal' | 'alternate') {
    return { buffer: { active: { type } } };
  }

  function fireWheel(target: HTMLElement, deltaY: number): boolean {
    return target.dispatchEvent(
      new WheelEvent('wheel', { deltaY, deltaMode: 0, bubbles: true, cancelable: true }),
    );
  }

  it('flushes the first tick immediately and coalesces the rest of the burst', () => {
    const { screen, deltas } = setupHost();
    cleanup = installTerminalWheelCoalesce(host, makeTerm('alternate'), { getLinePx: () => 20 });

    // First event of the gesture: replayed right away (leading edge)
    expect(fireWheel(screen, 20)).toBe(false); // intercepted (preventDefault)
    expect(deltas).toEqual([20]);

    // Rapid follow-up ticks accumulate instead of dispatching
    for (let i = 0; i < 9; i++) fireWheel(screen, 20);
    expect(deltas).toEqual([20]);

    // Flush interval elapses → the 9 accumulated lines replay as one burst
    vi.advanceTimersByTime(50);
    expect(deltas).toEqual(Array(10).fill(20));
  });

  it('keeps sub-line remainders and scrolls them once accumulated', () => {
    const { screen, deltas } = setupHost();
    cleanup = installTerminalWheelCoalesce(host, makeTerm('alternate'), { getLinePx: () => 20 });

    fireWheel(screen, 8); // below one line — nothing to replay yet
    expect(deltas).toEqual([]);
    fireWheel(screen, 8);
    fireWheel(screen, 8); // 24px accumulated = 1 line + 4px remainder

    vi.advanceTimersByTime(50);
    expect(deltas).toEqual([20]);
  });

  it('does not intercept normal-buffer scrolling', () => {
    const { screen, deltas } = setupHost();
    cleanup = installTerminalWheelCoalesce(host, makeTerm('normal'), { getLinePx: () => 20 });

    expect(fireWheel(screen, 20)).toBe(true); // not cancelled — xterm scrolls locally
    vi.advanceTimersByTime(100);
    expect(deltas).toEqual([20]); // only the original event, no replays
  });

  it('passes through synthetic wheel events (mobile touch scrolling)', () => {
    const { deltas } = setupHost();
    cleanup = installTerminalWheelCoalesce(host, makeTerm('alternate'), { getLinePx: () => 20 });

    scrollTerminalByWheel(host, 2, 20);
    vi.advanceTimersByTime(100);
    // Exactly the two synthetic events — not intercepted, not duplicated
    expect(deltas).toEqual([20, 20]);
  });

  it('supports line-mode deltas (Firefox)', () => {
    const { screen, deltas } = setupHost();
    cleanup = installTerminalWheelCoalesce(host, makeTerm('alternate'), { getLinePx: () => 20 });

    screen.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 3, deltaMode: 1, bubbles: true, cancelable: true }),
    );
    expect(deltas).toEqual([20, 20, 20]);
  });
});
