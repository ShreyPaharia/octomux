import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { claudeCodeHarness } from './claude-code.js';

describe('claudeCodeHarness', () => {
  it('has stable id and display name', () => {
    expect(claudeCodeHarness.id).toBe('claude-code');
    expect(claudeCodeHarness.displayName).toBe('Claude Code');
    expect(claudeCodeHarness.sessionIdMode).toBe('orchestrator-assigned');
  });

  it('newSessionId returns a UUID', () => {
    const id = claudeCodeHarness.newSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  describe('buildLaunchCommand', () => {
    it.each([
      [{ sessionId: 's1' }, 'claude --session-id s1'],
      [{ sessionId: 's1', agent: null }, 'claude --session-id s1'],
      [{ sessionId: 's1', agent: 'orchestrator' }, 'claude --agent orchestrator --session-id s1'],
      [{ sessionId: 's1', flags: ' --verbose' }, 'claude --session-id s1 --verbose'],
      [
        { sessionId: 's1', agent: 'planner', flags: ' --verbose' },
        'claude --agent planner --session-id s1 --verbose',
      ],
    ])('builds %j -> %s', (opts, expected) => {
      expect(claudeCodeHarness.buildLaunchCommand(opts)).toBe(expected);
    });

    it('rejects bad agent names', () => {
      expect(() =>
        claudeCodeHarness.buildLaunchCommand({ sessionId: 's1', agent: 'evil; rm' }),
      ).toThrow(/Invalid agent name/);
    });
  });

  describe('buildResumeCommand', () => {
    it.each([
      [{ sessionId: 's1' }, 'claude --resume s1'],
      [{ sessionId: 's1', flags: ' --verbose' }, 'claude --resume s1 --verbose'],
    ])('builds %j -> %s', (opts, expected) => {
      expect(claudeCodeHarness.buildResumeCommand(opts)).toBe(expected);
    });
  });

  describe('buildContinueCommand', () => {
    it('builds with --continue and a fresh session id', () => {
      expect(claudeCodeHarness.buildContinueCommand({ sessionId: 's1' })).toBe(
        'claude --continue --session-id s1',
      );
    });

    it('appends flags', () => {
      expect(claudeCodeHarness.buildContinueCommand({ sessionId: 's1', flags: ' --verbose' })).toBe(
        'claude --continue --session-id s1 --verbose',
      );
    });
  });
});

describe('buildLaunchCommand model override', () => {
  it('appends --model when model is set and flags has no --model', () => {
    expect(claudeCodeHarness.buildLaunchCommand({ sessionId: 's1', model: 'sonnet' })).toBe(
      "claude --session-id s1 --model 'sonnet'",
    );
  });

  it('replaces --model in flags with per-task model', () => {
    expect(
      claudeCodeHarness.buildLaunchCommand({
        sessionId: 's1',
        flags: ' --model opus',
        model: 'sonnet',
      }),
    ).toBe("claude --session-id s1 --model 'sonnet'");
  });

  it('preserves non-model flags alongside per-task model', () => {
    expect(
      claudeCodeHarness.buildLaunchCommand({
        sessionId: 's1',
        flags: ' --dangerously-skip-permissions --model opus',
        model: 'sonnet',
      }),
    ).toBe("claude --session-id s1 --dangerously-skip-permissions --model 'sonnet'");
  });

  it('leaves flags unchanged when no per-task model', () => {
    expect(claudeCodeHarness.buildLaunchCommand({ sessionId: 's1', flags: ' --model opus' })).toBe(
      'claude --session-id s1 --model opus',
    );
  });
});

describe('buildResumeCommand model override', () => {
  it('replaces --model in flags with per-task model', () => {
    expect(
      claudeCodeHarness.buildResumeCommand({
        sessionId: 's1',
        flags: ' --model opus',
        model: 'sonnet',
      }),
    ).toBe("claude --resume s1 --model 'sonnet'");
  });
});

describe('buildContinueCommand model override', () => {
  it('replaces --model in flags with per-task model', () => {
    expect(
      claudeCodeHarness.buildContinueCommand({
        sessionId: 's1',
        flags: ' --model opus',
        model: 'sonnet',
      }),
    ).toBe("claude --continue --session-id s1 --model 'sonnet'");
  });
});

describe('claudeCodeHarness.installHooks', () => {
  it('writes settings.local.json with token in URLs', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-harness-'));
    await claudeCodeHarness.installHooks(tmp, 'http://127.0.0.1:7777', 'tok-abc');
    const written = JSON.parse(
      fs.readFileSync(path.join(tmp, '.claude', 'settings.local.json'), 'utf-8'),
    );
    expect(written.hooks.Stop[0].hooks[0].url).toBe(
      'http://127.0.0.1:7777/api/hooks/stop?token=tok-abc',
    );
    expect(written.permissions.allow).toContain('Bash(git diff:*)');
  });

  it('uri-encodes the token', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-harness-'));
    await claudeCodeHarness.installHooks(tmp, 'http://127.0.0.1:7777', 'tok&special=value');
    const written = JSON.parse(
      fs.readFileSync(path.join(tmp, '.claude', 'settings.local.json'), 'utf-8'),
    );
    expect(written.hooks.Stop[0].hooks[0].url).toBe(
      'http://127.0.0.1:7777/api/hooks/stop?token=tok%26special%3Dvalue',
    );
  });

  it('forces editorMode: emacs so send-keys Enter submits (defeats global vim mode)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-harness-'));
    await claudeCodeHarness.installHooks(tmp, 'http://127.0.0.1:7777', 'tok');
    const written = JSON.parse(
      fs.readFileSync(path.join(tmp, '.claude', 'settings.local.json'), 'utf-8'),
    );
    expect(written.editorMode).toBe('emacs');
  });

  it('preserves an explicit worktree editorMode', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-harness-'));
    fs.mkdirSync(path.join(tmp, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.claude', 'settings.local.json'),
      JSON.stringify({ editorMode: 'vim' }),
    );
    await claudeCodeHarness.installHooks(tmp, 'http://127.0.0.1:7777', 'tok');
    const written = JSON.parse(
      fs.readFileSync(path.join(tmp, '.claude', 'settings.local.json'), 'utf-8'),
    );
    expect(written.editorMode).toBe('vim');
  });
});
