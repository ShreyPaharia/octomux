/**
 * Opt-in local-echo typeahead (VS Code-style): render keystrokes dimmed at
 * the cursor before the server round-trip confirms them, so typing on a
 * remote dashboard feels local.
 *
 * Deliberately narrow v1 — the desync bugs in every local-echo
 * implementation come from clever cursor prediction, so there is none here:
 * only printable single-byte chars (and backspace over our own predictions)
 * are predicted, never in the alternate screen buffer, never across a line
 * wrap, and any mismatch drops every prediction and lets real output stand.
 */

const STORAGE_KEY = 'octomux-terminal-local-echo';

export function getLocalEchoEnabled(): boolean {
  return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === 'true';
}

export function setLocalEchoEnabled(v: boolean): void {
  localStorage.setItem(STORAGE_KEY, String(v));
}

/** Only predict above this measured round-trip latency — below it the real
 *  echo lands within a frame or two and predictions would just flicker. */
export const TYPEAHEAD_MIN_LATENCY_MS = 30;
/** Unconfirmed predictions are undone after this long — a target that never
 *  echoes (password prompt, `stty -echo`) must not leave typed characters
 *  visible on screen. */
export const PREDICTION_TIMEOUT_MS = 1_000;

/** The slice of xterm's Terminal the typeahead needs (kept structural for tests). */
export interface TypeaheadTerminal {
  cols: number;
  write(data: string): void;
  buffer: {
    active: {
      type: string;
      cursorX: number;
      cursorY: number;
      baseY: number;
      getLine(y: number): { getCell(x: number): { getChars(): string } | undefined } | undefined;
    };
  };
}

export interface TerminalTypeahead {
  /** Real user input on its way to the server — maybe render a prediction. */
  onInput(data: string): void;
  /** Server output about to be written. Returns a control-sequence prefix to
   *  write BEFORE it: a cursor rewind over confirmed predictions (so the real
   *  echo repaints them with real attributes) or a full undo on mismatch. */
  reconcile(data: string | Uint8Array): string;
  dispose(): void;
}

export function createTerminalTypeahead(
  term: TypeaheadTerminal,
  getLatencyMs: () => number | null,
  isEnabled: () => boolean = getLocalEchoEnabled,
): TerminalTypeahead {
  // Predicted chars not yet confirmed by server output, each with the cell
  // content it drew over (so a mismatch can restore the screen exactly).
  let pending: { ch: string; overwritten: string }[] = [];
  // Cursor position when the current prediction run started (pending empty →
  // first prediction). Prediction k sits at anchorX + k; reading cursorX per
  // keystroke would race xterm's async write processing.
  let anchorX = 0;
  let anchorY = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const undoAll = (): string => {
    if (pending.length === 0) return '';
    const restore = pending.map((p) => p.overwritten).join('');
    const seq = `\x1b[${pending.length}D${restore}\x1b[${pending.length}D`;
    pending = [];
    return seq;
  };

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const armTimer = () => {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      const seq = undoAll();
      if (seq) term.write(seq);
    }, PREDICTION_TIMEOUT_MS);
  };

  return {
    onInput(data) {
      if (!isEnabled()) return;
      // Backspace over our own prediction is the only safe backspace: we know
      // exactly what the cell held before we drew over it.
      if (data === '\x7f' && pending.length > 0) {
        const popped = pending.pop()!;
        term.write(`\x1b[1D${popped.overwritten}\x1b[1D`);
        if (pending.length === 0) clearTimer();
        return;
      }
      if (data.length !== 1) return;
      const code = data.charCodeAt(0);
      if (code < 0x20 || code > 0x7e) return;
      const latency = getLatencyMs();
      if (latency === null || latency < TYPEAHEAD_MIN_LATENCY_MS) return;
      const buf = term.buffer.active;
      // Alt screen = full-screen TUI (vim, htop, the Claude Code UI) — it
      // repaints on its own terms; predicting there is how desyncs are born.
      if (buf.type === 'alternate') return;
      if (pending.length === 0) {
        anchorX = buf.cursorX;
        anchorY = buf.baseY + buf.cursorY;
      }
      // Never predict across a line wrap — the rewind/undo sequences are
      // cursor-left moves, which don't wrap back.
      if (anchorX + pending.length >= term.cols - 1) return;
      // Best-effort read of the cell we're about to draw over; term.write is
      // async so this can be a frame stale, and a blank fallback is fine.
      const cell = buf.getLine(anchorY)?.getCell(anchorX + pending.length);
      const overwritten = cell?.getChars() || ' ';
      pending.push({ ch: data, overwritten });
      term.write(`\x1b[2m${data}\x1b[22m`);
      armTimer();
    },

    reconcile(data) {
      if (pending.length === 0 || data.length === 0) return '';
      clearTimer();
      const byteAt = (i: number) => (typeof data === 'string' ? data.charCodeAt(i) : data[i]);
      let k = 0;
      while (k < pending.length && k < data.length && byteAt(k) === pending[k].ch.charCodeAt(0)) {
        k++;
      }
      // FULL confirmation only: rewind over every predicted cell so the echo
      // repaints them with real attributes. A partial match gets no fast path:
      // once the echo wrote its k chars the cursor would sit between the
      // confirmed cells and the remaining dim predictions — a state neither
      // the plain cursor-left rewind nor anchorX can represent, and at real
      // latencies echoes arriving one char per frame make that the common
      // case. Anything short of a full confirm is treated as a mismatch:
      // restore the screen, let real output stand, and the next echoed char
      // passes through untouched.
      if (k === pending.length) {
        pending = [];
        return `\x1b[${k}D`;
      }
      return undoAll();
    },

    dispose: clearTimer,
  };
}
