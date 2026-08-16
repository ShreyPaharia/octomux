/**
 * Guards the in-process pino-roll destination. pino's `transport:` option spawns
 * a worker that resolves targets by module path, which fails inside a compiled
 * binary — this asserts the replacement actually writes the rotated file.
 *
 * Runs under `bun test` (see `test:bun`), with NODE_ENV=production so the logger
 * isn't silenced and writes under a throwaway OCTOMUX_DATA_DIR.
 *
 *   bun test ./server/logger.bun-test.ts
 */

import { test, expect } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-logger-'));
process.env.OCTOMUX_DATA_DIR = root;
process.env.NODE_ENV = 'production';

const { childLogger } = await import('./logger.js');

test('writes structured lines to the rotated log file, no transport worker', async () => {
  childLogger('logcheck').info({ task_id: 'task-abc' }, 'hello from the compiled logger');

  const logDir = path.join(root, 'logs');
  let lines = '';
  // The roll stream resolves asynchronously; poll briefly for the first flush.
  for (let i = 0; i < 40 && !lines; i++) {
    await Bun.sleep(50);
    if (!fs.existsSync(logDir)) continue;
    lines = fs
      .readdirSync(logDir)
      .map((f) => fs.readFileSync(path.join(logDir, f), 'utf8'))
      .join('');
  }

  expect(lines).toContain('hello from the compiled logger');
  expect(lines).toContain('"task_id":"task-abc"');
});
