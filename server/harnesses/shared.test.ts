import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  applyModel,
  buildClaudeContinueCommand,
  buildClaudeLaunchCommand,
  buildClaudeResumeCommand,
  formatHarnessFlags,
  formatJsonConfig,
  validateSettingsObject,
  writeJsonConfig,
} from './shared.js';

describe('buildClaudeLaunchCommand — flag spacing', () => {
  // Regression: flags must never glue onto the session id. runAgentSession passes
  // flags without a leading space; the builder must still separate them, or claude
  // reads `<uuid><flags>` as the session id → "Invalid session ID" and exits.
  it('separates session id from flags with a single space', () => {
    const cmd = buildClaudeLaunchCommand({
      sessionId: 'abc-123',
      flags: '--dangerously-skip-permissions --mcp-config /x.json',
      model: null,
    });
    expect(cmd).toBe(
      'claude --session-id abc-123 --dangerously-skip-permissions --mcp-config /x.json',
    );
    expect(cmd).not.toContain('abc-123--');
  });

  it('handles a stray leading space in flags without doubling', () => {
    expect(buildClaudeLaunchCommand({ sessionId: 'sid', flags: '  --print', model: null })).toBe(
      'claude --session-id sid --print',
    );
  });

  it('emits no trailing space when flags are empty', () => {
    expect(buildClaudeLaunchCommand({ sessionId: 'sid', flags: '', model: null })).toBe(
      'claude --session-id sid',
    );
  });

  it('resume and continue commands separate flags too', () => {
    expect(buildClaudeResumeCommand({ sessionId: 'sid', flags: '--foo', model: null })).toBe(
      'claude --resume sid --foo',
    );
    expect(buildClaudeContinueCommand({ sessionId: 'sid', flags: '--foo', model: null })).toBe(
      'claude --continue --session-id sid --foo',
    );
  });
});

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
  it('appends model when absent from flags — value is single-quoted', () => {
    expect(applyModel('', 'claude-opus-4-8')).toBe(" --model 'claude-opus-4-8'");
  });

  it('replaces existing --model token — new value is single-quoted', () => {
    expect(applyModel(' --model opus', 'sonnet')).toBe(" --model 'sonnet'");
  });

  it('returns flags unchanged when model is unset', () => {
    expect(applyModel(' --verbose', null)).toBe(' --verbose');
  });

  it('returns flags unchanged when model is undefined', () => {
    expect(applyModel(' --verbose', undefined)).toBe(' --verbose');
  });

  it('returns flags unchanged when model is empty string', () => {
    expect(applyModel(' --verbose', '')).toBe(' --verbose');
  });

  it('single-quotes model containing semicolon — metacharacter cannot escape', () => {
    // ';rm -rf /' must not execute as a second shell command
    const result = applyModel('', 'bad;rm -rf /');
    expect(result).toBe(" --model 'bad;rm -rf /'");
    // The semicolon is inside single quotes — it is not an unquoted shell metacharacter
    expect(result).toContain("'bad;rm -rf /'");
  });

  it('single-quotes model containing spaces', () => {
    expect(applyModel('', 'my model name')).toBe(" --model 'my model name'");
  });

  it('single-quotes model containing $(...) — command substitution cannot run', () => {
    const result = applyModel('', '$(evil-cmd)');
    expect(result).toBe(" --model '$(evil-cmd)'");
    // The $( is wrapped in single quotes — it will not be interpolated by the shell.
    // The raw (unquoted) sequence $( must not appear outside of single quotes.
    expect(result).not.toMatch(/(?<!')\$\(/);
  });

  it('simple model id round-trips as single-quoted form', () => {
    expect(applyModel('', 'claude-opus-4-8')).toBe(" --model 'claude-opus-4-8'");
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
