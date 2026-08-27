import { describe, it, expect, vi, beforeEach, afterEach } from '../bun-test.js';
import {
  createTerminalTypeahead,
  getLocalEchoEnabled,
  setLocalEchoEnabled,
  PREDICTION_TIMEOUT_MS,
  type TypeaheadTerminal,
} from './terminal-typeahead';

function makeTerm(
  over: { type?: string; cursorX?: number; cols?: number; cellChar?: string } = {},
) {
  const writes: string[] = [];
  const term: TypeaheadTerminal & { writes: string[] } = {
    writes,
    cols: over.cols ?? 80,
    write: (d: string) => writes.push(d),
    buffer: {
      active: {
        type: over.type ?? 'normal',
        cursorX: over.cursorX ?? 5,
        cursorY: 0,
        baseY: 0,
        getLine: () => ({ getCell: () => ({ getChars: () => over.cellChar ?? '' }) }),
      },
    },
  };
  return term;
}

const enabled = () => true;
const slowLink = () => 100;

describe('local echo setting', () => {
  beforeEach(() => localStorage.clear());

  it('is off by default', () => {
    expect(getLocalEchoEnabled()).toBe(false);
  });

  it('round-trips through localStorage', () => {
    setLocalEchoEnabled(true);
    expect(getLocalEchoEnabled()).toBe(true);
    setLocalEchoEnabled(false);
    expect(getLocalEchoEnabled()).toBe(false);
  });
});

describe('terminal typeahead', () => {
  afterEach(() => vi.useRealTimers());

  it('renders a printable keystroke dimmed at the cursor', () => {
    const term = makeTerm();
    const ta = createTerminalTypeahead(term, slowLink, enabled);
    ta.onInput('a');
    expect(term.writes).toEqual(['\x1b[2ma\x1b[22m']);
  });

  it('predicts nothing when disabled (the default)', () => {
    localStorage.clear();
    const term = makeTerm();
    const ta = createTerminalTypeahead(term, slowLink); // default isEnabled
    ta.onInput('a');
    expect(term.writes).toEqual([]);
  });

  it('confirms predictions: rewinds so the real echo repaints them, then clears', () => {
    const term = makeTerm();
    const ta = createTerminalTypeahead(term, slowLink, enabled);
    ta.onInput('a');
    ta.onInput('b');
    // Server echoes both (deflate path delivers bytes) — rewind over both cells.
    expect(ta.reconcile(new TextEncoder().encode('ab'))).toBe('\x1b[2D');
    // Nothing pending afterwards.
    expect(ta.reconcile('anything')).toBe('');
  });

  it('undoes everything on partial confirmation (echo arriving one char per frame)', () => {
    // Regression: a partial-confirm rewind desyncs the cursor — after the
    // echo writes 'a' the cursor sits BETWEEN the confirmed cell and the
    // remaining dim 'b', so a later rewind-by-pending would paint "bb" and
    // leave the client cursor one column off the server's, permanently.
    // Partial confirm therefore takes the mismatch path: full undo, real
    // output stands, the follow-up echoed char passes through untouched.
    const term = makeTerm({ cellChar: '' });
    const ta = createTerminalTypeahead(term, slowLink, enabled);
    ta.onInput('a');
    ta.onInput('b');
    expect(ta.reconcile('a')).toBe('\x1b[2D  \x1b[2D');
    expect(ta.reconcile('b')).toBe('');
  });

  it('drops all predictions and restores the screen on mismatch', () => {
    const term = makeTerm({ cellChar: '' });
    const ta = createTerminalTypeahead(term, slowLink, enabled);
    ta.onInput('a');
    ta.onInput('b');
    // Mismatching echo → cursor-left 2, restore blanks, cursor-left 2.
    expect(ta.reconcile('x')).toBe('\x1b[2D  \x1b[2D');
    expect(ta.reconcile('y')).toBe('');
  });

  it('does not predict in the alternate screen buffer (vim/htop/Claude TUI)', () => {
    const term = makeTerm({ type: 'alternate' });
    const ta = createTerminalTypeahead(term, slowLink, enabled);
    ta.onInput('a');
    expect(term.writes).toEqual([]);
  });

  it('does not predict below the latency gate or before a measurement exists', () => {
    for (const latency of [null, 10]) {
      const term = makeTerm();
      const ta = createTerminalTypeahead(term, () => latency, enabled);
      ta.onInput('a');
      expect(term.writes).toEqual([]);
    }
  });

  it('does not predict non-printable input or multi-byte sequences', () => {
    const term = makeTerm();
    const ta = createTerminalTypeahead(term, slowLink, enabled);
    ta.onInput('\r');
    ta.onInput('\x1b[A'); // arrow key
    ta.onInput('é'); // > 0x7e
    expect(term.writes).toEqual([]);
  });

  it('does not predict at the line-wrap boundary', () => {
    const term = makeTerm({ cursorX: 79, cols: 80 });
    const ta = createTerminalTypeahead(term, slowLink, enabled);
    ta.onInput('a');
    expect(term.writes).toEqual([]);
  });

  it('erases its own prediction on backspace, ignores backspace otherwise', () => {
    const term = makeTerm();
    const ta = createTerminalTypeahead(term, slowLink, enabled);
    ta.onInput('\x7f'); // nothing pending — no local erase
    expect(term.writes).toEqual([]);
    ta.onInput('a');
    ta.onInput('\x7f');
    expect(term.writes).toEqual(['\x1b[2ma\x1b[22m', '\x1b[1D \x1b[1D']);
    expect(ta.reconcile('z')).toBe(''); // pending is empty again
  });

  it('undoes unconfirmed predictions after the timeout (no-echo prompts)', () => {
    vi.useFakeTimers();
    const term = makeTerm();
    const ta = createTerminalTypeahead(term, slowLink, enabled);
    ta.onInput('s');
    vi.advanceTimersByTime(PREDICTION_TIMEOUT_MS);
    expect(term.writes).toEqual(['\x1b[2ms\x1b[22m', '\x1b[1D \x1b[1D']);
    expect(ta.reconcile('z')).toBe('');
  });
});
