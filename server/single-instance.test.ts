import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkInstanceLock, isProcessAlive } from './single-instance.js';

const LOCK = 'octomux.lock';

describe('single-instance lock', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-lock-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is free when no lockfile exists', () => {
    expect(checkInstanceLock(dir)).toEqual({ free: true });
  });

  it('reclaims a stale lock held by a dead pid', () => {
    fs.writeFileSync(path.join(dir, LOCK), '999999');
    expect(checkInstanceLock(dir, () => false)).toEqual({ free: true });
  });

  it('blocks when a live foreign instance holds the lock', () => {
    fs.writeFileSync(path.join(dir, LOCK), '4242');
    expect(checkInstanceLock(dir, () => true)).toEqual({ free: false, holderPid: 4242 });
  });

  it('ignores its own pid (restart / re-entry)', () => {
    fs.writeFileSync(path.join(dir, LOCK), String(process.pid));
    expect(checkInstanceLock(dir, () => true)).toEqual({ free: true });
  });

  it('isProcessAlive: true for self, false for a nonexistent pid', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0x7fffffff)).toBe(false);
  });
});
