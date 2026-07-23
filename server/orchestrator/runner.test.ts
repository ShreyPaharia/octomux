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

/**
 * The window index the tmux `display-message`/`list-windows` mock reports.
 * Defaults to '1'; a test sets it to '0' to simulate the common base-index=0
 * case that the `parseInt(...) || 1` regression used to mis-target.
 */
let _windowIndex = '1';

/**
 * The foreground command `display-message -p '#{pane_current_command}'` reports.
 * Defaults to 'node' (a live claude conductor is a node process → alive). A test
 * sets it to a shell name to simulate a crashed conductor (→ not alive → resume).
 */
// A live claude reports a VERSION-like pane_current_command (e.g. '2.1.218'),
// NOT 'node'/'claude' — liveness must treat that as alive. Tests default to it.
let _paneCommand = '2.1.218';

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = typeof optsOrCb === 'function' ? (optsOrCb as Function) : (maybeCb as Function);
    if (args.includes('display-message')) {
      const isPaneCmd = args.some((a) => a.includes('pane_current_command'));
      cb(null, { stdout: isPaneCmd ? _paneCommand : _windowIndex, stderr: '' });
    } else if (args.includes('list-windows')) {
      cb(null, { stdout: _windowIndex, stderr: '' });
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
  interruptTurn,
  stopConversation,
  resumeConversation,
  conversationTmuxTarget,
} from './runner.js';
import { createConversation, getConversation, updateConversation } from './store.js';
import { ORCHESTRATOR_SYSTEM_PROMPT } from './conductor-flags.js';

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
    _windowIndex = '1';
    _paneCommand = '2.1.218';
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

    it('omits theme/tui from the isolated settings (default config dir handles onboarding)', async () => {
      const convId = createConversation({ title: 'Dialog test' });
      await startConversation(convId, '/tmp/test-repo');

      const { writeFileSync } = await import('fs');
      // Find the write to the conductor settings.local.json specifically (the
      // mcp-config.json write also lives under an "orchestrator" path).
      const orchestratorSettingsWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find(
          (c) => typeof c[0] === 'string' && (c[0] as string).endsWith('settings.local.json'),
        );
      expect(orchestratorSettingsWrite).toBeDefined();
      const content = JSON.parse(orchestratorSettingsWrite![1] as string);
      // We run with the DEFAULT config dir (auth + onboarding already done). An
      // object `tui` value is rejected by claude and blocks the session on a
      // settings-error dialog, so these keys must NOT be present.
      expect(content).not.toHaveProperty('theme');
      expect(content).not.toHaveProperty('tui');
    });

    it('persists the conductor hook_token on the conversation (used by mcp-config env)', async () => {
      const convId = createConversation({ title: 'Token test' });
      await startConversation(convId, '/tmp/test-repo');

      const conv = getConversation(convId);
      // The conductor stores hook_token so the MCP stdio server can authenticate
      // back to the main server for write operations via OCTOMUX_ACTION_TOKEN.
      expect(conv!.hook_token).toBeTruthy();
    });

    it('permissions.deny includes Bash, Edit, Write in the written settings.local.json', async () => {
      const convId = createConversation({ title: 'Deny list test' });
      await startConversation(convId, '/tmp/test-repo');

      const { writeFileSync } = await import('fs');
      const orchestratorSettingsWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find(
          (c) =>
            typeof c[0] === 'string' &&
            (c[0] as string).includes(convId) &&
            (c[0] as string).endsWith('settings.local.json'),
        );
      expect(orchestratorSettingsWrite).toBeDefined();
      const content = JSON.parse(orchestratorSettingsWrite![1] as string);
      // Conductor is pure-MCP: no hooks, Bash hard-denied, repo mutation tools denied.
      expect(content.hooks).toBeUndefined();
      // Non-interactive: bypassPermissions so a prompt never hangs the tmux TUI —
      // deny still applies in this mode, so Bash/Edit/Write remain blocked.
      expect(content.permissions?.defaultMode).toBe('bypassPermissions');
      const deny: string[] = content.permissions?.deny ?? [];
      expect(deny).toContain('Bash');
      expect(deny).toContain('Edit');
      expect(deny).toContain('Write');
      expect(deny).toContain('MultiEdit');
      expect(deny).toContain('NotebookEdit');
    });

    it('allows ALL octomux MCP tools so no call ever triggers a hanging permission prompt', async () => {
      const convId = createConversation({ title: 'Allow list test' });
      await startConversation(convId, '/tmp/test-repo');

      const { writeFileSync } = await import('fs');
      const settingsWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find(
          (c) =>
            typeof c[0] === 'string' &&
            (c[0] as string).includes(convId) &&
            (c[0] as string).endsWith('settings.local.json'),
        );
      const allow: string[] = JSON.parse(settingsWrite![1] as string).permissions?.allow ?? [];
      // Whole-server allow is the robust catch-all (an un-allowed MCP tool prompts
      // in the tmux TUI and hangs the conductor).
      expect(allow).toContain('mcp__octomux');
      // The discovery read tools added in SHR-142 must be explicitly allowed too —
      // their omission is exactly what hung a real conversation on default_branch.
      expect(allow).toContain('mcp__octomux__recent_repos');
      expect(allow).toContain('mcp__octomux__default_branch');
      // And the write tools.
      expect(allow).toContain('mcp__octomux__create_task');
    });

    it('launches with --mcp-config and --strict-mcp-config (octomux read tools)', async () => {
      const convId = createConversation({ title: 'MCP test' });
      await startConversation(convId, '/tmp/test-repo');

      const newSession = findTmuxCall('new-session');
      const startupCmdArg = newSession!.find((a) => a.includes('claude'));
      expect(startupCmdArg!).toContain('--mcp-config');
      expect(startupCmdArg!).toContain('--strict-mcp-config');

      // And it writes an mcp-config.json registering the octomux stdio server.
      const { writeFileSync } = await import('fs');
      const mcpWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find(
          (c) => typeof c[0] === 'string' && (c[0] as string).endsWith('mcp-config.json'),
        );
      expect(mcpWrite).toBeDefined();
      const cfg = JSON.parse(mcpWrite![1] as string);
      expect(cfg.mcpServers?.octomux).toBeDefined();
      expect(Array.isArray(cfg.mcpServers.octomux.args)).toBe(true);
    });

    it('stores tmux session in the conversation record', async () => {
      const convId = createConversation({ title: 'Store session test' });
      await startConversation(convId, '/tmp/test-repo');

      const conv = getConversation(convId);
      expect(conv!.tmux_window).toBeTruthy();
      expect(conv!.tmux_window).toContain('octomux-orch');
    });

    it('preserves a window index of 0 (base-index=0) instead of falling back to 1', async () => {
      _windowIndex = '0';
      const convId = createConversation({ title: 'Base-index 0 test' });
      await startConversation(convId, '/tmp/test-repo');

      const conv = getConversation(convId);
      // Regression: `parseInt('0', 10) || 1` used to store ':1', a window that
      // does not exist, so every sent turn was silently dropped.
      expect(conv!.tmux_window).toBe(`octomux-orch-${convId}:0`);
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

    it('defaults to the orchestrator system prompt when opts.systemPrompt is omitted', async () => {
      const convId = createConversation({ title: 'Default prompt test' });
      await startConversation(convId, '/tmp/test-repo');

      const newSession = findTmuxCall('new-session');
      const startupCmdArg = newSession!.find((a) => a.includes('claude'));
      expect(startupCmdArg!).toContain('--append-system-prompt');
      expect(startupCmdArg!).toContain(ORCHESTRATOR_SYSTEM_PROMPT.slice(0, 40));
    });

    it('uses opts.systemPrompt for --append-system-prompt when given (Agents feature)', async () => {
      const convId = createConversation({ title: 'Agent prompt test' });
      await startConversation(convId, '/tmp/test-repo', {
        systemPrompt: 'You are Agent One. Only do X.',
      });

      const newSession = findTmuxCall('new-session');
      const startupCmdArg = newSession!.find((a) => a.includes('claude'));
      expect(startupCmdArg!).toContain('You are Agent One. Only do X.');
      expect(startupCmdArg!).not.toContain(ORCHESTRATOR_SYSTEM_PROMPT.slice(0, 40));
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

    it('uses opts.systemPrompt for --append-system-prompt when given (Agents feature)', async () => {
      const convId = createConversation({ title: 'Resume with agent prompt' });
      await resumeConversation(convId, '/tmp/test-repo', {
        systemPrompt: 'You are Agent One. Only do X.',
      });

      const newSession = findTmuxCall('new-session');
      const cmdArg = newSession!.find((a) => a.includes('claude'));
      expect(cmdArg!).toContain('You are Agent One. Only do X.');
      expect(cmdArg!).not.toContain(ORCHESTRATOR_SYSTEM_PROMPT.slice(0, 40));
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

    it('resumes a dead session (--resume) then delivers the turn', async () => {
      // A conversation whose tmux session is gone (server restart / crash / stop):
      // no tmux_window → not alive → sendTurn must resume the SAME claude session
      // and then deliver, instead of throwing.
      const convId = createConversation({
        title: 'Resume on send',
        claude_session_id: 'sess-resume-1',
      });

      const promise = sendTurn(convId, 'hello after resume');
      await vi.advanceTimersByTimeAsync(500); // flush capture-pane poll / paste sleep
      await promise;

      // It recreated the tmux session via `claude --resume <session_id>`.
      const newSession = findTmuxCall('new-session');
      expect(newSession).toBeDefined();
      const cmd = newSession!.find((a) => a.includes('claude'));
      expect(cmd).toContain('--resume sess-resume-1');

      // And then delivered the turn (a `-l` paste).
      const pasteCall = mockedExecFile.mock.calls.find(
        (c) =>
          c[0] === 'tmux' &&
          stripSocketArgs(c[1] as string[]).includes('send-keys') &&
          stripSocketArgs(c[1] as string[]).includes('-l'),
      );
      expect(pasteCall).toBeDefined();
    });

    it('interruptTurn sends the TUI interrupt key (Escape) to a live pane', async () => {
      const convId = createConversation({ title: 'Interrupt' });
      updateConversation(convId, { tmux_window: 'octomux-orch-int:1' });

      const p = interruptTurn(convId);
      await vi.advanceTimersByTimeAsync(500);
      await p;

      const escapeCall = mockedExecFile.mock.calls.find(
        (c) =>
          c[0] === 'tmux' &&
          stripSocketArgs(c[1] as string[]).includes('send-keys') &&
          stripSocketArgs(c[1] as string[]).includes('Escape'),
      );
      expect(escapeCall).toBeDefined();
    });

    it('serializes two concurrent turns — keystrokes never interleave', async () => {
      // Both writers target the SAME conversation/pane. Without the FIFO lock the
      // two pastes would land back-to-back before either Enter, submitting garbled
      // input. With it, turn A fully completes (paste → Enter) before turn B pastes.
      const convId = createConversation({ title: 'Concurrent turns' });
      updateConversation(convId, { tmux_window: 'octomux-orch-conc:1' });

      const p1 = sendTurn(convId, 'AAA');
      const p2 = sendTurn(convId, 'BBB');
      await vi.advanceTimersByTimeAsync(2000);
      await Promise.all([p1, p2]);

      // Reconstruct the ordered send-keys sequence into 'paste:<text>' / 'enter'.
      const seq: string[] = [];
      for (const c of mockedExecFile.mock.calls) {
        if (c[0] !== 'tmux') continue;
        const args = stripSocketArgs(c[1] as string[]);
        if (!args.includes('send-keys')) continue;
        const lIdx = args.indexOf('-l');
        if (lIdx !== -1) seq.push(`paste:${args[lIdx + 1]}`);
        else if (args.includes('Enter')) seq.push('enter');
      }

      // A's paste and Enter must both precede B's paste (no interleave).
      expect(seq).toEqual(['paste:AAA', 'enter', 'paste:BBB', 'enter']);
    });

    it('waits for a booting session (pane shell→claude) instead of resuming', async () => {
      // A just-launched conductor: the tmux session exists but claude is still
      // booting, so the pane briefly runs the launch shell. sendTurn must WAIT
      // for claude to take the foreground and then paste — it must NOT resume
      // (which would new-session an existing name → "duplicate session", the bug
      // that dropped the first real Telegram turn).
      const convId = createConversation({ title: 'Booting', claude_session_id: 'sess-boot' });
      updateConversation(convId, { tmux_window: 'octomux-orch-boot:1' });
      _paneCommand = 'zsh'; // claude still launching

      const p = sendTurn(convId, 'hello there');
      await vi.advanceTimersByTimeAsync(100); // a couple of alive-polls, still booting
      _paneCommand = 'node'; // claude took the pane foreground
      await vi.advanceTimersByTimeAsync(1000);
      await p;

      // No resume happened — it waited, then pasted.
      expect(findTmuxCall('new-session')).toBeUndefined();
      const pasteCall = mockedExecFile.mock.calls.find(
        (c) => c[0] === 'tmux' && stripSocketArgs(c[1] as string[]).includes('-l'),
      );
      expect(pasteCall).toBeDefined();
    });

    it('resumes (does not paste blind) when the pane fell back to a shell', async () => {
      // Session exists but claude crashed — the pane's foreground command is the
      // holding shell, not node/claude. Liveness must report DEAD so sendTurn
      // resumes rather than pasting the chat text into a live shell (which would
      // run it as a command — the security hazard T9 closes).
      const convId = createConversation({
        title: 'Crashed conductor',
        claude_session_id: 'sess-crashed-1',
      });
      updateConversation(convId, { tmux_window: 'octomux-orch-crashed:1' });
      _paneCommand = 'zsh'; // pane fell back to the holding shell

      const promise = sendTurn(convId, 'are you there?');
      await vi.advanceTimersByTimeAsync(500);
      await promise;

      // It must have resumed the SAME claude session before delivering.
      const newSession = findTmuxCall('new-session');
      expect(newSession).toBeDefined();
      const cmd = newSession!.find((a) => a.includes('claude'));
      expect(cmd).toContain('--resume sess-crashed-1');
    });
  });
});
