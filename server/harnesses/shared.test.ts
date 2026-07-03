import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  applyModel,
  formatHarnessFlags,
  formatJsonConfig,
  validateSettingsObject,
  writeJsonConfig,
} from './shared.js';

describe('formatJsonConfig / writeJsonConfig', () => {
  it('serializes with 2-space indent and trailing newline', () => {
    expect(formatJsonConfig({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });

  it('writeJsonConfig writes byte-identical output', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-shared-'));
    const filePath = path.join(tmp, 'cfg.json');
    writeJsonConfig(filePath, { x: true });
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(formatJsonConfig({ x: true }));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('formatHarnessFlags', () => {
  it.each([
    [[], ''],
    [['--verbose'], ' --verbose'],
    [['--force', '--model x'], ' --force --model x'],
  ])('%j -> %s', (parts, expected) => {
    expect(formatHarnessFlags(parts)).toBe(expected);
  });
});

describe('applyModel', () => {
  it('appends model when absent from flags', () => {
    expect(applyModel('', 'sonnet')).toBe(' --model sonnet');
  });

  it('replaces existing --model token', () => {
    expect(applyModel(' --model opus', 'sonnet')).toBe(' --model sonnet');
  });

  it('returns flags unchanged when model is unset', () => {
    expect(applyModel(' --verbose', null)).toBe(' --verbose');
  });
});

describe('validateSettingsObject', () => {
  const fields = {
    flags: (v: unknown) => (typeof v === 'string' ? v.trim() : v),
    force: (v: unknown) => {
      if (typeof v !== 'boolean') throw new Error('expected boolean');
      return v;
    },
  };

  it('throws on non-object input', () => {
    expect(() => validateSettingsObject(null, 'test', fields)).toThrow(
      'Invalid test settings: expected object',
    );
  });

  it('validates only present keys', () => {
    expect(validateSettingsObject({ flags: ' --x ' }, 'test', fields)).toEqual({ flags: '--x' });
  });

  it('rejects unknown keys when configured', () => {
    expect(() =>
      validateSettingsObject({ extra: 1 }, 'test', fields, { rejectUnknownKeys: true }),
    ).toThrow('unknown key "extra"');
  });

  it('omits validator results that are undefined', () => {
    const withOptional = {
      ...fields,
      model: (v: unknown) => {
        if (typeof v !== 'string') throw new Error('expected string');
        const trimmed = v.trim();
        return trimmed || undefined;
      },
    };
    expect(validateSettingsObject({ model: '  ' }, 'test', withOptional)).toEqual({});
  });
});
