import pino, { type Logger } from 'pino';
import roll from 'pino-roll';
import pretty from 'pino-pretty';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { octomuxRoot } from './octomux-root.js';
import { redactSecretValues } from './secrets/redact.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

/** Resolve the log directory lazily so mocked fs/os in tests don't fail at module load. */
function resolveLogDir(): string {
  return isProduction
    ? path.join(octomuxRoot(), 'logs')
    : path.join(__dirname, '..', 'data', 'logs');
}

function resolveLogFile(): string {
  return path.join(resolveLogDir(), 'octomux.log');
}

function defaultLevel(): string {
  if (process.env.LOG_LEVEL) return process.env.LOG_LEVEL;
  if (isTest) return 'silent';
  return isProduction ? 'info' : 'debug';
}

/**
 * The rotating log file, as an in-process stream.
 *
 * pino's `transport:` option spawns a worker thread that resolves the target by
 * module path at runtime — which `bun build --compile` can't satisfy ("unable to
 * determine transport target for pino-roll"). pino-roll's default export is also
 * a plain stream factory, so we call it directly and skip the worker entirely.
 *
 * That factory is async while `getLogger()` is sync, so writes are buffered until
 * it resolves. ponytail: unbounded buffer, but it drains within milliseconds of
 * boot — revisit only if something logs heavily before the first tick.
 */
function rollingDestination(file: string): { write(line: string): void } {
  let out: { write(line: string): void } | null = null;
  const pending: string[] = [];

  void roll({ file, frequency: 'daily', size: '10m', mkdir: true, limit: { count: 7 } }).then(
    (stream) => {
      out = stream as unknown as { write(line: string): void };
      for (const line of pending) out.write(line);
      pending.length = 0;
    },
  );

  return {
    write(line: string): void {
      if (out) out.write(line);
      else pending.push(line);
    },
  };
}

/**
 * Wraps a write-only destination so every line passes through
 * `redactSecretValues()` before it reaches the underlying stream. Both the
 * rolling file and the dev pretty stream are wrapped with this at the
 * destination — the single choke point every `logger.*` call funnels
 * through, so redaction never needs to be scattered into call sites.
 *
 * Exported for tests only: in `NODE_ENV=test`, `buildLogger()` returns a bare
 * `pino({ level })` with no destination stream at all, so this path is inert
 * under the default test logger — a test asserting redaction has to exercise
 * this function directly against an explicit stream, not go through
 * `getLogger()`.
 */
export function withRedaction(stream: { write(line: string): unknown }): {
  write(line: string): unknown;
} {
  return {
    write(line: string): unknown {
      return stream.write(redactSecretValues(line));
    },
  };
}

function buildLogger(): Logger {
  const level = defaultLevel();

  // Tests: no file I/O, no transport workers
  if (isTest) return pino({ level });

  fs.mkdirSync(resolveLogDir(), { recursive: true });
  const file = withRedaction(rollingDestination(resolveLogFile()));

  if (isProduction) {
    // Prod: JSON to file only
    return pino({ level }, file as unknown as pino.DestinationStream);
  }

  // Dev: pretty-printed stdout + JSON rotated file
  return pino(
    { level },
    pino.multistream([
      {
        level,
        stream: withRedaction(
          pretty({ colorize: true, translateTime: 'SYS:HH:MM:ss.l' }),
        ) as unknown as pino.DestinationStream,
      },
      { level, stream: file as unknown as pino.DestinationStream },
    ]),
  );
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
