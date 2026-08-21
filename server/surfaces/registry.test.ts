import { describe, it, expect, beforeEach, afterEach } from '../bun-test.js';
import {
  registerSurface,
  getSurface,
  listSurfaces,
  resetSurfaces,
  freezeCoreSurfaces,
  unregisterSurface,
  DEFAULT_SURFACE_KIND,
  CORE_SURFACE_KINDS,
} from './registry.js';
import { registerCoreSurfaces } from './core.js';
import { getLogger, setLogger } from '../logger.js';
import pino from 'pino';
import type { SurfaceDefinition } from '@octomux/plugin-api';

/** Collect pino JSON log lines into memory for assertions. */
function bufferStream() {
  const chunks: string[] = [];
  return {
    stream: {
      write(chunk: string) {
        chunks.push(chunk);
      },
    },
    lines(): Array<Record<string, unknown>> {
      return chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
  };
}

function withCapturedLogs(fn: () => void): Array<Record<string, unknown>> {
  const original = getLogger();
  const buf = bufferStream();
  setLogger(pino({ level: 'trace' }, buf.stream));
  try {
    fn();
  } finally {
    setLogger(original);
  }
  return buf.lines();
}

/** Minimal stand-in SurfaceDefinition — none of its `render`/`prompt` bodies
 *  are exercised by these tests. */
function fakeSurface(kind: string): SurfaceDefinition {
  return { kind, renderers: ['json'] };
}

describe('surfaces/registry', () => {
  beforeEach(() => {
    resetSurfaces();
  });

  afterEach(() => {
    resetSurfaces();
    registerCoreSurfaces();
    freezeCoreSurfaces();
  });

  it('registers and gets a surface by kind', () => {
    registerSurface(fakeSurface('demo:discord'));
    expect(getSurface('demo:discord')?.kind).toBe('demo:discord');
  });

  it('lists registered surfaces', () => {
    registerSurface(fakeSurface('demo:discord'));
    expect(listSurfaces().map((s) => s.kind)).toContain('demo:discord');
  });

  it('DEFAULT_SURFACE_KIND is web', () => {
    expect(DEFAULT_SURFACE_KIND).toBe('web');
  });

  it('duplicate registration warns and keeps the first', () => {
    const first = fakeSurface('demo:discord');
    const second = fakeSurface('demo:discord');
    registerSurface(first);
    registerSurface(second);
    expect(getSurface('demo:discord')).toBe(first);
  });

  it('a plugin cannot redefine a core surface after freeze — via the specific freeze diagnostic, not the generic duplicate one', () => {
    registerCoreSurfaces();
    const originalWeb = getSurface('web');
    freezeCoreSurfaces();

    const lines = withCapturedLogs(() => {
      registerSurface(fakeSurface('web'));
    });

    expect(getSurface('web')).toBe(originalWeb);
    const freezeLine = lines.find(
      (l) => l.msg === 'refusing to redefine core surface after freeze',
    );
    expect(freezeLine).toBeDefined();
    expect(freezeLine!.surface_kind).toBe('web');
    const dupLine = lines.find(
      (l) => l.msg === 'surface already registered, keeping first registration',
    );
    expect(dupLine).toBeUndefined();
  });

  it('freeze refuses a core kind even if it was never registered', () => {
    freezeCoreSurfaces();

    const lines = withCapturedLogs(() => {
      registerSurface(fakeSurface('web'));
    });

    expect(getSurface('web')).toBeUndefined();
    const freezeLine = lines.find(
      (l) => l.msg === 'refusing to redefine core surface after freeze',
    );
    expect(freezeLine).toBeDefined();
  });

  it('unregisterSurface("web") refuses, even before freeze', () => {
    registerCoreSurfaces();

    const lines = withCapturedLogs(() => {
      expect(unregisterSurface('web')).toBe(false);
    });

    expect(getSurface('web')).toBeDefined();
    const warnLine = lines.find((l) => l.msg === 'refusing to unregister core surface');
    expect(warnLine).toBeDefined();
    expect(warnLine!.surface_kind).toBe('web');
  });

  it('unregisterSurface works for a plugin surface', () => {
    registerSurface(fakeSurface('demo:discord'));
    expect(unregisterSurface('demo:discord')).toBe(true);
    expect(getSurface('demo:discord')).toBeUndefined();
  });

  it('unregisterSurface returns false for a kind that was never registered', () => {
    expect(unregisterSurface('demo:never-existed')).toBe(false);
  });

  it('CORE_SURFACE_KINDS names the shipped surfaces', () => {
    expect(CORE_SURFACE_KINDS).toEqual(['web', 'cli', 'slack', 'telegram']);
  });

  it('resetSurfaces + registerCoreSurfaces round-trips to a usable, unfrozen registry', () => {
    registerCoreSurfaces();
    freezeCoreSurfaces();

    resetSurfaces();
    expect(getSurface('web')).toBeUndefined();

    registerCoreSurfaces();
    expect(
      listSurfaces()
        .map((s) => s.kind)
        .sort(),
    ).toEqual(['cli', 'slack', 'telegram', 'web']);
    // Unfrozen again — a plugin surface can still register.
    registerSurface(fakeSurface('demo:discord'));
    expect(getSurface('demo:discord')).toBeDefined();
  });

  it('freeze is idempotent', () => {
    registerCoreSurfaces();
    freezeCoreSurfaces();
    freezeCoreSurfaces();
    expect(getSurface('web')).toBeDefined();
  });
});
