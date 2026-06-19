/**
 * server/orchestrator/runner.test.ts
 *
 * Tests for the interactive tmux runner (Task 1.4 / SHR-120).
 *
 * Test strategy: mock child_process (execFile → execTmux) and fs so we can
 * verify the right tmux + claude commands are issued without touching real tmux
 * or the filesystem. Pattern mirrors server/task-runner.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import { createTestDb } from '../test-helpers.js';

// ─── Mock child_process ───────────────────────────────────────────────────────

/**
 * Track the last text pasted so capture-pane can confirm it landed.
 * The mock writes to this when it sees a '-l' send-keys call, and
 * capture-pane reads it back so the confirm loop exits immediately.
 */
let _lastPastedText = '';

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = typeof optsOrCb === 'function' ? (optsOrCb as Function) : (maybeCb as Function);
    if (args.includes('display-message')) {
      cb(null, { stdout: '1', stderr: '' });
    } else if (args.includes('list-windows')) {
      cb(null, { stdout: '1', stderr: '' });
    } else if (args.includes('send-keys') && args.includes('-l')) {
      // Record what was pasted so capture-pane can confirm it
      const lIdx = args.indexOf('-l');
      if (lIdx !== -1 && args[lIdx + 1]) _lastPastedText = args[lIdx + 1]!;
      cb(null, { stdout: '', stderr: '' });
    } else if (args.includes('capture-pane')) {
      // Return the last pasted text so the confirm loop exits on the first poll
      cb(null, { stdout: `${_lastPastedText}\n❯`, stderr: '' });
    } else {
      cb(null, { stdout: '', stderr: '' });
    }
  }),
}));

// ─── Mock fs ─────────────────────────────────────────────────────────────────

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const mocked = {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(() => '{}'),
    unlinkSync: vi.fn(),
  };
  return { ...mocked, default: mocked };
});

const mockedExecFile = vi.mocked(execFile);

// Import runner under test AFTER mocks are set up
import {
  startConversation,
  sendTurn,
  stopConversation,
  resumeConversation,
  conversationTmuxTarget,
} from './runner.js';
import { createConversation, getConversation, updateConversation } from './store.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Strip the '-S <socket>' prefix that execTmux prepends to every invocation. */
function stripSocketArgs(args: string[]): string[] {
  return args[0] === '-S' ? args.slice(2) : args;
}

/** Find a specific tmux call by checking stripped args for a subcommand. */
function findTmuxCall(subcommand: string): string[] | undefined {
  for (const call of mockedExecFile.mock.calls) {
    if (call[0] !== 'tmux') continue;
    const args = stripSocketArgs(call[1] as string[]);
    if (args[0] === subcommand) return args;
  }
  return undefined;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('orchestrator runner', () => {
  beforeEach(() => {
    createTestDb();
    mockedExecFile.mockClear();
    _lastPastedText = '';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── startConversation ──────────────────────────────────────────────────────

  describe('startConversation', () => {
    it('creates a tmux session with an interactive claude command (no -p flag)', async () => {
      const convId = createConversation({ title: 'Test convo' });
      await startConversation(convId, '/tmp/test-repo');

      const newSession = findTmuxCall('new-session');
      expect(newSession).toBeDefined();

      // The startup command should NOT contain -p (no --print / headless mode)
      const startupCmdArg = newSession!.find((a) => a.includes('claude') && !a.startsWith('-'));
      expect(startupCmdArg).toBeDefined();
      expect(startupCmdArg!).not.toContain(' -p ');
      expect(startupCmdArg!).not.toContain('--print');
    });

    it('uses an isolated settings directory (not the worker harness settings)', async () => {
      const convId = createConversation({ title: 'Isolation test' });
      await startConversation(convId, '/tmp/test-repo');

      // The conductor's settings must be written to an orchestrator-specific dir
      const { writeFileSync } = await import('fs');
      const writeCall = vi
        .mocked(writeFileSync)
        .mock.calls.find(
          (c) => typeof c[0] === 'string' && (c[0] as string).includes('orchestrator'),
        );
      expect(writeCall).toBeDefined();
    });

    it('pre-clears first-run TUI dialogs in the isolated settings', async () => {
      const convId = createConversation({ title: 'Dialog test' });
      await startConversation(convId, '/tmp/test-repo');

      const { writeFileSync } = await import('fs');
      // Find the write to the orchestrator settings file
      const orchestratorSettingsWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find(
          (c) => typeof c[0] === 'string' && (c[0] as string).includes('orchestrator'),
        );
      expect(orchestratorSettingsWrite).toBeDefined();
      const content = JSON.parse(orchestratorSettingsWrite![1] as string);
      // TUI autoAccept / theme should be pre-set to prevent first-run dialogs
      expect(content).toHaveProperty('theme');
      expect(content).toHaveProperty('tui');
    });

    it('installs a PreToolUse hook with the Bash(octomux *) matcher in the conductor settings', async () => {
      const convId = createConversation({ title: 'Hook test' });
      await startConversation(convId, '/tmp/test-repo');

      const { writeFileSync } = await import('fs');
      const orchestratorSettingsWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find(
          (c) => typeof c[0] === 'string' && (c[0] as string).includes('orchestrator'),
        );
      expect(orchestratorSettingsWrite).toBeDefined();
      const content = JSON.parse(orchestratorSettingsWrite![1] as string);
      // hooks must include PreToolUse
      expect(content.hooks).toBeDefined();
      const preToolUse = content.hooks?.PreToolUse;
      expect(preToolUse).toBeDefined();
      // Matcher should restrict to Bash(octomux *) invocations
      const hook = Array.isArray(preToolUse) ? preToolUse[0] : preToolUse;
      expect(JSON.stringify(hook)).toContain('octomux');
    });

    it('stores tmux session in the conversation record', async () => {
      const convId = createConversation({ title: 'Store session test' });
      await startConversation(convId, '/tmp/test-repo');

      const conv = getConversation(convId);
      expect(conv!.tmux_window).toBeTruthy();
      expect(conv!.tmux_window).toContain('octomux-orch');
    });

    it('uses the pinned cwd (repo path) as the session working dir', async () => {
      const convId = createConversation({ title: 'CWD test' });
      await startConversation(convId, '/tmp/test-repo');

      const newSession = findTmuxCall('new-session');
      expect(newSession).toBeDefined();
      const cwdIndex = newSession!.indexOf('-c');
      expect(cwdIndex).toBeGreaterThan(-1);
      expect(newSession![cwdIndex + 1]).toBe('/tmp/test-repo');
    });
  });

  // ── resumeConversation ─────────────────────────────────────────────────────

  describe('resumeConversation', () => {
    it('uses --resume <session_id> when a claude_session_id is stored', async () => {
      const convId = createConversation({
        title: 'Resume test',
        claude_session_id: 'some-session-uuid',
      });
      updateConversation(convId, { tmux_window: 'octomux-orch-abc123:1' });
      await resumeConversation(convId, '/tmp/test-repo');

      // The startup command must include --resume <session_id>
      const newSession = findTmuxCall('new-session');
      expect(newSession).toBeDefined();
      const cmdArg = newSession!.find((a) => a.includes('claude'));
      expect(cmdArg).toBeDefined();
      expect(cmdArg!).toContain('--resume');
      expect(cmdArg!).toContain('some-session-uuid');
    });

    it('falls back to a fresh session when no claude_session_id is stored', async () => {
      const convId = createConversation({ title: 'Fresh start' });
      await resumeConversation(convId, '/tmp/test-repo');

      const newSession = findTmuxCall('new-session');
      expect(newSession).toBeDefined();
      const cmdArg = newSession!.find((a) => a.includes('claude'));
      expect(cmdArg).toBeDefined();
      // Should launch a new session (no --resume) since no session_id
      expect(cmdArg!).not.toContain('--resume');
    });
  });

  // ── stopConversation ───────────────────────────────────────────────────────

  describe('stopConversation', () => {
    it('kills the tmux session', async () => {
      const convId = createConversation({ title: 'Stop test' });
      updateConversation(convId, { tmux_window: 'octomux-orch-stop123:1', status: 'active' });
      await stopConversation(convId);

      const killSession = findTmuxCall('kill-session');
      expect(killSession).toBeDefined();
      expect(killSession!).toContain('octomux-orch-stop123');
    });

    it('is a no-op when the conversation has no tmux session', async () => {
      const convId = createConversation({ title: 'No-op stop' });
      // No tmux_window set
      await stopConversation(convId);
      const killSession = findTmuxCall('kill-session');
      expect(killSession).toBeUndefined();
    });
  });

  // ── conversationTmuxTarget ────────────────────────────────────────────────

  describe('conversationTmuxTarget', () => {
    it('returns session:windowIndex from the stored tmux_window', () => {
      const convId = createConversation({ title: 'Target test' });
      updateConversation(convId, { tmux_window: 'octomux-orch-xyz:2' });
      const conv = getConversation(convId);
      expect(conversationTmuxTarget(conv!)).toBe('octomux-orch-xyz:2');
    });

    it('returns null when no tmux_window is set', () => {
      const convId = createConversation({ title: 'No target' });
      const conv = getConversation(convId);
      expect(conversationTmuxTarget(conv!)).toBeNull();
    });
  });

  // ── sendTurn — hardened send-keys (capture-pane confirm) ──────────────────

  describe('sendTurn', () => {
    it('sends the text via bracketed paste then Enter (two separate send-keys calls)', async () => {
      const convId = createConversation({ title: 'SendTurn test' });
      updateConversation(convId, { tmux_window: 'octomux-orch-send:1' });

      const promise = sendTurn(convId, 'hello world');
      // Advance timers to flush capture-pane poll / sleep
      await vi.advanceTimersByTimeAsync(500);
      await promise;

      // Must have sent -l (bracketed paste) and then Enter
      const sendKeyCalls = mockedExecFile.mock.calls.filter(
        (c) => c[0] === 'tmux' && stripSocketArgs(c[1] as string[]).includes('send-keys'),
      );
      expect(sendKeyCalls.length).toBeGreaterThanOrEqual(2);

      const pasteCall = sendKeyCalls.find((c) => stripSocketArgs(c[1] as string[]).includes('-l'));
      expect(pasteCall).toBeDefined();

      const enterCall = sendKeyCalls.find((c) =>
        stripSocketArgs(c[1] as string[]).includes('Enter'),
      );
      expect(enterCall).toBeDefined();
    });

    it('uses capture-pane to confirm text is in the pane before sending Enter', async () => {
      const convId = createConversation({ title: 'CapturePane confirm test' });
      updateConversation(convId, { tmux_window: 'octomux-orch-cap:1' });

      const promise = sendTurn(convId, 'confirm me');
      await vi.advanceTimersByTimeAsync(500);
      await promise;

      // capture-pane must be called at some point during sendTurn
      const captureCall = findTmuxCall('capture-pane');
      expect(captureCall).toBeDefined();
    });

    it('handles multi-line turns (passes the full text including newlines)', async () => {
      const convId = createConversation({ title: 'Multi-line turn' });
      updateConversation(convId, { tmux_window: 'octomux-orch-ml:1' });
      const multiLine = 'line one\nline two\nline three';

      const promise = sendTurn(convId, multiLine);
      await vi.advanceTimersByTimeAsync(500);
      await promise;

      const sendKeyCalls = mockedExecFile.mock.calls.filter(
        (c) => c[0] === 'tmux' && stripSocketArgs(c[1] as string[]).includes('send-keys'),
      );
      const pasteCall = sendKeyCalls.find((c) => stripSocketArgs(c[1] as string[]).includes('-l'));
      expect(pasteCall).toBeDefined();
      const pasteArgs = stripSocketArgs(pasteCall![1] as string[]);
      const msgIndex = pasteArgs.indexOf('-l') + 1;
      expect(pasteArgs[msgIndex]).toBe(multiLine);
    });

    it('rejects when conversation has no tmux session', async () => {
      const convId = createConversation({ title: 'No session send' });
      await expect(sendTurn(convId, 'hello')).rejects.toThrow(/no tmux/i);
    });
  });
});
