// Adapted from supermux (MIT, © Sander van Meggelen): web/src/lib/android-ime.ts
//
// Android (GBoard & friends) IME → pty translation layer.
//
// WHY. xterm.js does not support Android IMEs (upstream #3600 / #2403 / #1101):
// soft keyboards deliver nearly everything through COMPOSITION events
// (keydown keyCode 229), and xterm's CompositionHelper diffs the hidden
// textarea naively — `newValue.replace(oldValue, '')` degenerates to
// re-sending the WHOLE value on a word replacement, and a shrink of N chars
// sends exactly ONE DEL. Tapping an autocomplete suggestion ("delete the
// composing word, insert the replacement") therefore lands as duplicated
// text at the shell prompt.
//
// THE FIX. On Android we take xterm out of the IME loop entirely and own the
// textarea→pty translation ourselves:
//
//   1. A `term.attachCustomKeyEventHandler` that returns false for keydown
//      keyCode 229 short-circuits xterm's `_keyDown` BEFORE
//      `CompositionHelper.keydown` (which would otherwise schedule its naive
//      `_handleAnyTextareaChanges` diff-sender on a 0ms timer).
//   2. This module installs CAPTURE-phase listeners on `term.element` (an
//      ANCESTOR of the hidden textarea — capture on an ancestor runs before
//      the at-target listeners xterm registered) and stopPropagation()s
//      `compositionstart/update/end` + `input` so xterm's own handlers
//      (CompositionHelper + `_inputEvent`) never see IME traffic.
//   3. We translate the textarea mutations to pty bytes with a REAL diff:
//      snapshot the value on `beforeinput` (fires before the DOM mutation,
//      so programmatic value clears between events can never corrupt the
//      pairing), then on `input` compute the longest-common-prefix/suffix
//      delta and send DEL × (erased code points) followed by the inserted
//      text. A GBoard suggestion tap becomes exactly "N backspaces + the new
//      word" — which any readline-style prompt applies correctly.
//
// WHAT STAYS WITH XTERM. Real key events keep flowing through xterm's keymap
// untouched: hardware keys, Enter (keyCode 13), Backspace when there is no
// composition (GBoard sends a real keyCode 8 then), arrows, Ctrl chords.
// xterm preventDefault()s every keydown it handles, so those never mutate
// the textarea → never produce an `input` event → no double-send with the
// diff path. Paste stays on xterm's `paste` listener (also preventDefault'd).
//
// KNOWN LIMITS (accepted): if the IME edits text it remembers from BEFORE
// the current line (e.g. cursor-control moves the caret into an earlier
// word), the DELs land at the pty cursor — which sits at the line end — and
// the edit desyncs. That niche gesture was equally broken before; the common
// flows (type, suggestion tap, autocorrect-on-space, backspace-through-word,
// dictation) all map correctly.

import type { Terminal } from '@xterm/xterm';

/** ASCII DEL — what a terminal Backspace sends (xterm's own default). */
const DEL = '\x7f';

/** Android detection. UA-based on purpose: the breakage is specific to
 *  Android IME behaviour, not to coarse pointers in general (iOS keyboards
 *  deliver discrete key events and work with xterm's composition handling). */
export function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
}

export interface ImeDelta {
  /** Number of CODE POINTS to erase (→ that many DEL bytes). */
  erase: number;
  /** Replacement text to type after the erases. */
  insert: string;
}

/** Longest-common-prefix/suffix delta between two textarea values, with
 *  surrogate-pair-safe boundaries. Exported for direct testing. */
export function imeDelta(before: string, after: string): ImeDelta {
  if (before === after) return { erase: 0, insert: '' };
  let p = 0;
  const maxP = Math.min(before.length, after.length);
  while (p < maxP && before.charCodeAt(p) === after.charCodeAt(p)) p++;
  // Never split a surrogate pair at the prefix boundary: if the last common
  // unit is a high surrogate, pull it back into the differing region.
  if (p > 0 && isHighSurrogate(before.charCodeAt(p - 1))) p--;
  let s = 0;
  const maxS = Math.min(before.length, after.length) - p;
  while (
    s < maxS &&
    before.charCodeAt(before.length - 1 - s) === after.charCodeAt(after.length - 1 - s)
  )
    s++;
  // Mirror guard: don't let the suffix start on a low surrogate whose high
  // half is inside the differing region.
  if (s > 0 && isLowSurrogate(before.charCodeAt(before.length - s))) s--;
  const removed = before.slice(p, before.length - s);
  const inserted = after.slice(p, after.length - s);
  return { erase: codePointCount(removed), insert: inserted };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
function codePointCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n++;
    if (
      isHighSurrogate(s.charCodeAt(i)) &&
      i + 1 < s.length &&
      isLowSurrogate(s.charCodeAt(i + 1))
    ) {
      i++;
    }
  }
  return n;
}

/** Translate one textarea delta into pty bytes. Newlines map to `\r` — the
 *  byte xterm itself sends for Enter (a bare `\n` would be Ctrl+J; the shell
 *  treats `\r` as submit, which is the soft-keyboard Enter's meaning here). */
export function deltaToBytes(delta: ImeDelta): string {
  if (delta.erase === 0 && delta.insert.length === 0) return '';
  return DEL.repeat(delta.erase) + delta.insert.replace(/\r?\n/g, '\r');
}

/**
 * Install the Android IME bridge on an OPEN terminal (term.element and
 * term.textarea must exist — call after `term.open()`).
 *
 * Returns a dispose function. The caller gates on `isAndroid()` + writability;
 * this module does not re-check.
 */
export function attachAndroidImeBridge(term: Terminal, send: (data: string) => void): () => void {
  const root = term.element;
  const textarea = term.textarea;
  if (!root || !textarea) return () => {};

  // Value snapshot taken on `beforeinput` — the true pre-mutation value even
  // if something (xterm clears it on real-Enter keydowns) reset it between
  // events. `null` = no beforeinput seen for the upcoming input event; fall
  // back to the running shadow value then.
  let pending: string | null = null;
  // Running shadow of the last value we reconciled — the fallback `before`
  // for engines/IMEs that fire `input` without a preceding `beforeinput`.
  let shadow = textarea.value;

  const isOurs = (e: Event) => e.target === textarea;

  // Composition events: blackhole them before xterm's at-target listeners.
  // The `input` events carry every mutation; CompositionHelper would only
  // double-send. (Capture on an ancestor fires before at-target listeners,
  // and stopPropagation() halts delivery to the target.)
  const onComposition = (e: Event) => {
    if (!isOurs(e)) return;
    e.stopPropagation();
  };

  const onBeforeInput = (e: Event) => {
    if (!isOurs(e)) return;
    // Snapshot only — never stopPropagation/preventDefault here:
    // `insertCompositionText` beforeinput is not cancelable anyway, and xterm
    // has no beforeinput listener to shield.
    pending = textarea.value;
  };

  const onInput = (e: Event) => {
    if (!isOurs(e)) return;
    // Keep xterm's `_inputEvent` (and any ancestor delegates) out of the loop.
    e.stopPropagation();
    const before = pending ?? shadow;
    pending = null;
    const after = textarea.value;
    const bytes = deltaToBytes(imeDelta(before, after));
    if (bytes.length > 0) send(bytes);
    // A committed newline ends the "line" the IME is editing — reset the
    // textarea so the next suggestion context starts clean and the value
    // can't grow without bound. Safe outside composition only (clearing a
    // mid-composition value confuses IMEs).
    const composing = (e as InputEvent).isComposing === true;
    if (!composing && after.includes('\n')) {
      textarea.value = '';
      shadow = '';
    } else {
      shadow = textarea.value;
    }
  };

  // On (re)focus, resync the shadow to whatever the textarea holds — xterm
  // and the browser may have touched the value while we weren't looking.
  const onFocus = () => {
    pending = null;
    shadow = textarea.value;
  };

  root.addEventListener('compositionstart', onComposition, { capture: true });
  root.addEventListener('compositionupdate', onComposition, { capture: true });
  root.addEventListener('compositionend', onComposition, { capture: true });
  root.addEventListener('beforeinput', onBeforeInput, { capture: true });
  root.addEventListener('input', onInput, { capture: true });
  textarea.addEventListener('focus', onFocus);

  return () => {
    root.removeEventListener('compositionstart', onComposition, { capture: true });
    root.removeEventListener('compositionupdate', onComposition, { capture: true });
    root.removeEventListener('compositionend', onComposition, { capture: true });
    root.removeEventListener('beforeinput', onBeforeInput, { capture: true });
    root.removeEventListener('input', onInput, { capture: true });
    textarea.removeEventListener('focus', onFocus);
  };
}
