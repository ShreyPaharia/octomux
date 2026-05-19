import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { cursorHarness } from './cursor.js';

// ---------------------------------------------------------------------------
// Stub setup for installHooks (bridge.js doesn't exist yet — Part B)
// ---------------------------------------------------------------------------

const bridgeSrcPath = fileURLToPath(new URL('../../bin/octomux-hook-bridge.js', import.meta.url));
let stubCreated = false;

beforeAll(() => {
  if (!fs.existsSync(bridgeSrcPath)) {
    fs.mkdirSync(path.dirname(bridgeSrcPath), { recursive: true });
    fs.writeFileSync(bridgeSrcPath, '#!/usr/bin/env node\n');
    stubCreated = true;
  }
});

afterAll(() => {
  if (stubCreated && fs.existsSync(bridgeSrcPath)) {
    fs.rmSync(bridgeSrcPath);
  }
});

// ---------------------------------------------------------------------------
// Basic identity
// ---------------------------------------------------------------------------

describe('cursorHarness', () => {
  it('has stable id, display name, and sessionIdMode', () => {
    expect(cursorHarness.id).toBe('cursor');
    expect(cursorHarness.displayName).toBe('Cursor');
    expect(cursorHarness.sessionIdMode).toBe('harness-issued');
  });

  it('newSessionId returns a UUID', () => {
    const id = cursorHarness.newSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  // -------------------------------------------------------------------------
  // buildLaunchCommand
  // -------------------------------------------------------------------------

  describe('buildLaunchCommand', () => {
    it.each([
      [{ sessionId: 's1' }, 'cursor-agent'],
      [{ sessionId: 's1', flags: ' --verbose' }, 'cursor-agent --verbose'],
    ])('builds %j -> %s', (opts, expected) => {
      expect(cursorHarness.buildLaunchCommand(opts)).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // buildResumeCommand
  // -------------------------------------------------------------------------

  describe('buildResumeCommand', () => {
    it.each([
      [{ sessionId: 'chat-abc' }, 'cursor-agent --resume chat-abc'],
      [{ sessionId: 'chat-abc', flags: ' --verbose' }, 'cursor-agent --resume chat-abc --verbose'],
    ])('builds %j -> %s', (opts, expected) => {
      expect(cursorHarness.buildResumeCommand(opts)).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // buildContinueCommand
  // -------------------------------------------------------------------------

  describe('buildContinueCommand', () => {
    it('returns null', () => {
      expect(cursorHarness.buildContinueCommand({ sessionId: 's1' })).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // resolveFlags
  // -------------------------------------------------------------------------

  describe('resolveFlags', () => {
    it.each([
      [{ harnesses: {} }, ''],
      [{ harnesses: { cursor: { force: true } } }, ' --force'],
      [{ harnesses: { cursor: { flags: '--mode plan' } } }, ' --mode plan'],
      [{ harnesses: { cursor: { force: true, flags: '--mode plan' } } }, ' --force --mode plan'],
    ])('settings %j -> %s', (settings, expected) => {
      expect(cursorHarness.resolveFlags(settings as any)).toBe(expected);
    });

    it('throws on bad flags', () => {
      expect(() =>
        cursorHarness.resolveFlags({ harnesses: { cursor: { flags: '; rm -rf /' } } } as any),
      ).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // validateSettings
  // -------------------------------------------------------------------------

  describe('validateSettings', () => {
    it.each([
      [{}, {}],
      [{ flags: '--x' }, { flags: '--x' }],
      [{ force: true }, { force: true }],
    ])('accepts %j -> %j', (input, expected) => {
      expect(cursorHarness.validateSettings(input)).toEqual(expected);
    });

    it('throws on wrong type for force', () => {
      expect(() => cursorHarness.validateSettings({ force: 'yes' })).toThrow(/force/);
    });

    it('throws on unknown key', () => {
      expect(() => cursorHarness.validateSettings({ unknown: 'x' })).toThrow(/unknown/);
    });

    it.each([null, 42, 'string', []])('throws on non-object: %j', (val) => {
      expect(() => cursorHarness.validateSettings(val)).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // syncAgents
  // -------------------------------------------------------------------------

  it('syncAgents resolves without error', async () => {
    await expect(cursorHarness.syncAgents('/tmp/some-path')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// installHooks integration test
// ---------------------------------------------------------------------------

describe('cursorHarness.installHooks', () => {
  it('writes all required files with correct modes and content', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-cursor-hooks-'));
    try {
      await cursorHarness.installHooks(tmpDir, 'http://127.0.0.1:7777', 'tok-abc');

      const bridgeDest = path.join(tmpDir, '.octomux-hooks', 'bridge.js');
      const configPath = path.join(tmpDir, '.octomux-hooks', 'config.json');
      const hooksJsonPath = path.join(tmpDir, '.cursor', 'hooks.json');

      // bridge.js exists and has mode 0500
      expect(fs.existsSync(bridgeDest)).toBe(true);
      expect(fs.statSync(bridgeDest).mode & 0o777).toBe(0o500);

      // config.json exists, mode 0600, correct content
      expect(fs.existsSync(configPath)).toBe(true);
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(config).toEqual({ baseUrl: 'http://127.0.0.1:7777', token: 'tok-abc' });

      // hooks.json exists with correct structure
      expect(fs.existsSync(hooksJsonPath)).toBe(true);
      const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8'));
      expect(hooksJson.version).toBe(1);
      const eventNames = [
        'sessionStart',
        'beforeSubmitPrompt',
        'beforeShellExecution',
        'postToolUse',
        'afterFileEdit',
      ];
      for (const event of eventNames) {
        expect(hooksJson.hooks[event]).toHaveLength(1);
        expect(hooksJson.hooks[event][0].command).toBe(bridgeDest);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
