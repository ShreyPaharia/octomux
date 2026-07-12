import { describe, it, expect } from 'vitest';
import { imeDelta, deltaToBytes } from './terminal-android-ime';

describe('terminal-android-ime', () => {
  describe('imeDelta', () => {
    it('plain append counts only the appended text', () => {
      expect(imeDelta('he', 'hel')).toEqual({ erase: 0, insert: 'l' });
    });

    it('backspace counts a single erase with nothing to insert', () => {
      expect(imeDelta('hel', 'he')).toEqual({ erase: 1, insert: '' });
    });

    it('suggestion replacement diffs to the common prefix/suffix only', () => {
      // "teh " -> "the ": common prefix "t", common suffix " " (the trailing
      // space). The differing middle "eh" -> "he" is what gets erased/inserted.
      expect(imeDelta('teh ', 'the ')).toEqual({ erase: 2, insert: 'he' });
    });

    it('identical strings produce a no-op delta', () => {
      expect(imeDelta('same', 'same')).toEqual({ erase: 0, insert: '' });
    });

    it('surrogate pair safety: appending an emoji counts as one code point', () => {
      expect(imeDelta('a', 'a😀')).toEqual({ erase: 0, insert: '😀' });
    });

    it('surrogate pair safety: removing an emoji erases exactly one code point', () => {
      expect(imeDelta('a😀', 'a')).toEqual({ erase: 1, insert: '' });
    });

    it('never splits a surrogate pair at the diff boundary when a common emoji follows', () => {
      // Both strings share a trailing emoji; the prefix boundary must not land
      // between the high and low surrogate halves of the differing "b"/"c" edit.
      expect(imeDelta('ab😀', 'ac😀')).toEqual({ erase: 1, insert: 'c' });
    });
  });

  describe('deltaToBytes', () => {
    it('maps a newline in the insert to \\r, not \\n', () => {
      expect(deltaToBytes({ erase: 0, insert: '\n' })).toBe('\r');
    });

    it('maps a CRLF insert to a single \\r', () => {
      expect(deltaToBytes({ erase: 0, insert: '\r\n' })).toBe('\r');
    });

    it('erase N produces N DEL (\\x7f) bytes', () => {
      expect(deltaToBytes({ erase: 3, insert: '' })).toBe('\x7f\x7f\x7f');
    });

    it('combines erase DELs and insert text in order', () => {
      expect(deltaToBytes({ erase: 2, insert: 'he' })).toBe('\x7f\x7fhe');
    });

    it('empty delta produces an empty string', () => {
      expect(deltaToBytes({ erase: 0, insert: '' })).toBe('');
    });
  });
});
