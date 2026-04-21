import pino, { type Logger, type TransportTargetOptions } from 'pino';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

export const PROD_LOG_DIR = path.join(os.homedir(), '.octomux', 'logs');
export const DEV_LOG_DIR = path.join(__dirname, '..', 'data', 'logs');
export const LOG_DIR = isProduction ? PROD_LOG_DIR : DEV_LOG_DIR;
export const LOG_FILE = path.join(LOG_DIR, 'octomux.log');

function defaultLevel(): string {
  if (process.env.LOG_LEVEL) return process.env.LOG_LEVEL;
  if (isTest) return 'silent';
  return isProduction ? 'info' : 'debug';
}

function rollTarget(level: string): TransportTargetOptions {
  return {
    target: 'pino-roll',
    level,
    options: {
      file: LOG_FILE,
      frequency: 'daily',
      size: '10m',
      mkdir: true,
      limit: { count: 7 },
    },
  };
}

function buildLogger(): Logger {
  const level = defaultLevel();

  // Tests: no file I/O, no transport workers
  if (isTest) return pino({ level });

  fs.mkdirSync(LOG_DIR, { recursive: true });

  if (isProduction) {
    // Prod: JSON to file only
    return pino({
      level,
      transport: rollTarget(level),
    });
  }

  // Dev: pretty-printed stdout + JSON rotated file
  return pino({
    level,
    transport: {
      targets: [
        {
          target: 'pino-pretty',
          level,
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
        rollTarget(level),
      ],
    },
  });
}

let rootLogger: Logger | null = null;

export function getLogger(): Logger {
  if (!rootLogger) rootLogger = buildLogger();
  return rootLogger;
}

/** Replace the singleton logger (for testing). */
export function setLogger(logger: Logger): void {
  rootLogger = logger;
}

/**
 * Child logger tagged with `module`. Returns a proxy that re-resolves against
 * the current singleton on every access so tests can swap the root via
 * `setLogger` without rebinding every captured reference.
 */
export function childLogger(module: string): Logger {
  let cached: { root: Logger; child: Logger } | null = null;
  const resolve = (): Logger => {
    const root = getLogger();
    if (!cached || cached.root !== root) {
      cached = { root, child: root.child({ module }) };
    }
    return cached.child;
  };
  return new Proxy({} as Logger, {
    get(_target, prop: string | symbol): unknown {
      const current = resolve();
      const val = Reflect.get(current, prop);
      return typeof val === 'function' ? val.bind(current) : val;
    },
  });
}
