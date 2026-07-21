import fs from 'fs';
import path from 'path';
import { getDataDir } from './db.js';
import { childLogger } from './logger.js';

const logger = childLogger('single-instance');
const LOCK_FILE = 'octomux.lock';

/** True if a process with this pid is running (including one we don't own). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH → gone; EPERM → alive but owned by another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readPid(file: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Probe the lock without mutating it. `alive` is injectable for tests. */
export function checkInstanceLock(
  dir: string,
  alive: (pid: number) => boolean = isProcessAlive,
): { free: boolean; holderPid?: number } {
  const pid = readPid(path.join(dir, LOCK_FILE));
  if (pid != null && pid !== process.pid && alive(pid)) {
    return { free: false, holderPid: pid };
  }
  return { free: true };
}

/**
 * Guarantee one octomux server per database. Two instances on one SQLite file
 * corrupt each other's task lifecycle — e.g. a stale build's merged-PR poller
 * re-closes a task the live server just resumed. Exits if another live instance
 * already holds the lock; otherwise claims it and releases on process exit.
 *
 * ponytail: read-check-write pidfile, not atomic — a dead-heat first start could
 * let two processes both win. Fine for a single-user local dashboard; reach for
 * O_EXCL + stale reclaim only if that ever bites.
 */
export function acquireInstanceLock(dir: string = getDataDir()): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);

  const { free, holderPid } = checkInstanceLock(dir);
  if (!free) {
    logger.error(
      { lock: file, holder_pid: holderPid, data_dir: dir },
      'another octomux instance is already running on this database — refusing to start',
    );
    process.exit(1);
  }

  fs.writeFileSync(file, String(process.pid), { mode: 0o600 });
  process.on('exit', () => {
    try {
      if (readPid(file) === process.pid) fs.rmSync(file, { force: true });
    } catch {
      // best-effort cleanup
    }
  });
}
