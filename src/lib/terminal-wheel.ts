/**
 * Build an SGR (1006) mouse-wheel escape sequence for the PTY.
 *
 * xterm.js's default for wheel events on the alternate screen is to send
 * Up/Down arrow keystrokes — which TUIs like Cursor CLI then treat as
 * prompt-history navigation. We intercept the wheel in TerminalView and
 * send a real mouse event instead, so tmux (with `mouse on`) can route it
 * through its WheelUpPane / WheelDownPane bindings into copy-mode.
 *
 * SGR mouse button codes: 64 = wheel up, 65 = wheel down. tmux uses the
 * button code (not the coordinates) to dispatch wheel events, so 1;1 is
 * fine as the position.
 */
export function buildSgrWheelSequence(deltaY: number): string {
  if (deltaY === 0) return '';
  const button = deltaY < 0 ? 64 : 65;
  return `\x1b[<${button};1;1M`;
}
