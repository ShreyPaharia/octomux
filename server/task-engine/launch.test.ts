import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from '../sqlite.js';
import { describe, it, expect, beforeEach, afterEach, vi } from '../bun-test.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────
//
// `fs` is intentionally NOT mocked here (unlike the old version of this file):
// buildAgentStartupCommand/writeWorkerMcpConfig now go through
// `localSession.files`, which is real `fs.promises` — see
// `server/task-engine/launch-prompt-respawn.test.ts` for the same real-fs
// pattern this file follows. Only `child_process` (tmux) is mocked.

let nextWindowIndex = 0;

vi.mock('child_process', () => ({
  execFile: vi.fn(
    (_cmd: string, args: string[], optsOrCb: Function | object, maybeCb?: Function) => {
      const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb!;
      if (args.includes('display-message')) {
        cb(null, { stdout: String(nextWindowIndex), stderr: '' });
      } else if (args.includes('list-windows')) {
        cb(null, { stdout: String(nextWindowIndex), stderr: '' });
      } else if (args.includes('new-window')) {
        nextWindowIndex++;
        cb(null, { stdout: '', stderr: '' });
      } else {
        cb(null, { stdout: '', stderr: '' });
      }
    },
  ),
}));

vi.mock('../repositories/orchestrator.js', (importOriginal) => {
  const actual = importOriginal<typeof import('../repositories/orchestrator.js')>();
  return {
    ...actual,
    isOrchestratorManaged: vi.fn(() => false),
  };
});

vi.mock('../orchestrator/runner.js', () => ({
  mcpServerInvocation: vi.fn(() => null),
}));

vi.mock('../hook-base-url.js', () => ({
  hookBaseUrl: vi.fn(() => 'http://127.0.0.1:7777'),
}));

const { createTestDb, insertTask, insertAgent, DEFAULTS, findExecCall } =
  await import('../test-helpers.js');

const {
  buildAgentStartupCommand,
  computeFreshSessionIds,
  prepareResumeLaunch,
  launchAgentWindow,
  applyOrchestratorMcpConfig,
  writeWorkerMcpConfig,
} = await import('./launch.js');
const { execFile } = await import('child_process');
const { isOrchestratorManaged } = await import('../repositories/orchestrator.js');
const { mcpServerInvocation } = await import('../orchestrator/runner.js');
const { localSession } = await import('../compute/index.js');

// ─── Setup ────────────────────────────────────────────────────────────────────

let db: Database;
let worktreeDir: string;

beforeEach(() => {
  db = createTestDb();
  vi.clearAllMocks();
  vi.mocked(isOrchestratorManaged).mockReturnValue(false);
  vi.mocked(mcpServerInvocation).mockReturnValue(null);
  nextWindowIndex = 0;
  worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-launch-test-'));
});

afterEach(() => {
  fs.rmSync(worktreeDir, { recursive: true, force: true });
});

// ─── buildAgentStartupCommand ─────────────────────────────────────────────────

describe('buildAgentStartupCommand', () => {
  const shell = process.env.SHELL || '/bin/sh';

  it('wraps the harness command in an interactive shell', async () => {
    const cmd = await buildAgentStartupCommand(localSession, {
      baseCmd: 'claude --session-id abc',
    });
    expect(cmd.startsWith(`${shell} -ic `)).toBe(true);
  });

  it('includes exec shell -i at the end so the pane stays alive', async () => {
    const cmd = await buildAgentStartupCommand(localSession, {
      baseCmd: 'claude --session-id abc',
    });
    expect(cmd).toContain(`exec ${shell} -i`);
  });

  it('includes the harness command verbatim', async () => {
    const cmd = await buildAgentStartupCommand(localSession, {
      baseCmd: 'claude --session-id abc --model opus',
    });
    expect(cmd).toContain('claude --session-id abc --model opus');
  });

  it('does NOT embed prompt via cat when no prompt provided', async () => {
    const cmd = await buildAgentStartupCommand(localSession, {
      baseCmd: 'claude --session-id abc',
    });
    expect(cmd).not.toContain('$(cat ');
  });

  it('embeds prompt via cat substitution when prompt + worktreePath + agentId provided', async () => {
    const cmd = await buildAgentStartupCommand(localSession, {
      baseCmd: 'claude --session-id abc',
      prompt: 'Do the thing',
      worktreePath: worktreeDir,
      agentId: 'agent123',
    });
    expect(cmd).toContain('"$(cat ');
    expect(cmd).toContain('.claude-prompt-agent123');
  });

  it('puts -- before the prompt cat substitution', async () => {
    const cmd = await buildAgentStartupCommand(localSession, {
      baseCmd: 'claude --session-id abc',
      prompt: 'Do the thing',
      worktreePath: worktreeDir,
      agentId: 'agent123',
    });
    expect(cmd).toContain('-- "$(cat ');
  });

  it('writes prompt to a file with mode 0o600', async () => {
    await buildAgentStartupCommand(localSession, {
      baseCmd: 'claude --session-id abc',
      prompt: 'Do the thing',
      worktreePath: worktreeDir,
      agentId: 'agent123',
    });
    const promptFile = path.join(worktreeDir, '.claude-prompt-agent123');
    expect(fs.readFileSync(promptFile, 'utf8')).toContain('Do the thing');
    expect(fs.statSync(promptFile).mode & 0o777).toBe(0o600);
  });

  it('appends the rename hint to the written prompt', async () => {
    await buildAgentStartupCommand(localSession, {
      baseCmd: 'claude --session-id abc',
      prompt: 'Do the thing',
      worktreePath: worktreeDir,
      agentId: 'agent123',
    });
    const promptFile = path.join(worktreeDir, '.claude-prompt-agent123');
    expect(fs.readFileSync(promptFile, 'utf8')).toContain('octomux task rename');
  });

  it('does NOT write a prompt file when prompt is absent', async () => {
    await buildAgentStartupCommand(localSession, { baseCmd: 'claude --session-id abc' });
    expect(fs.readdirSync(worktreeDir)).toHaveLength(0);
  });

  it('does not embed cat when worktreePath is missing', async () => {
    const cmd = await buildAgentStartupCommand(localSession, {
      baseCmd: 'claude --session-id abc',
      prompt: 'Do the thing',
      agentId: 'agent123',
      // no worktreePath
    });
    expect(cmd).not.toContain('$(cat ');
  });

  it('prepends shell-quoted env exports when env is provided', async () => {
    const cmd = await buildAgentStartupCommand(localSession, {
      baseCmd: 'claude --session-id abc',
      env: { OCTOMUX_ACTION_TOKEN: 'tok-123', OCTOMUX_ACTION_BASE_URL: 'http://127.0.0.1:7777' },
    });
    // The whole script (export prefix included) is itself shell-quoted by the
    // outer shellQuoteSingle(script) call, which re-escapes the single quotes
    // from each per-value shellQuoteSingle() into `'\''`. So we assert on the
    // substrings that survive that re-escaping unchanged (key=, values), the
    // same pattern the prompt-file tests above use (e.g. `"$(cat `).
    expect(cmd).toContain('export OCTOMUX_ACTION_TOKEN=');
    expect(cmd).toContain('tok-123');
    expect(cmd).toContain('OCTOMUX_ACTION_BASE_URL=');
    expect(cmd).toContain('http://127.0.0.1:7777');
    expect(cmd.indexOf('export ')).toBeLessThan(cmd.indexOf('claude --session-id abc'));
  });

  it('omits the export prefix when env is not provided', async () => {
    const cmd = await buildAgentStartupCommand(localSession, {
      baseCmd: 'claude --session-id abc',
    });
    expect(cmd).not.toContain('export ');
  });
});

// ─── computeFreshSessionIds ───────────────────────────────────────────────────

describe('computeFreshSessionIds', () => {
  it('returns same id for db and launch when sessionIdMode is orchestrator-assigned', () => {
    const stubHarness = {
      id: 'stub',
      displayName: 'Stub',
      sessionIdMode: 'orchestrator-assigned' as const,
      newSessionId: vi.fn(() => 'my-session-id'),
      buildLaunchCommand: vi.fn(),
      buildResumeCommand: vi.fn(),
      buildContinueCommand: vi.fn(),
      installHooks: vi.fn(),
      syncAgents: vi.fn(),
      resolveFlags: vi.fn(() => ''),
      validateSettings: vi.fn(() => ({})),
      validateAgentName: vi.fn((s: string) => s),
    };

    const { sessionIdForDb, sessionIdForLaunch } = computeFreshSessionIds(stubHarness as any);
    expect(sessionIdForDb).toBe('my-session-id');
    expect(sessionIdForLaunch).toBe('my-session-id');
    expect(sessionIdForDb).toBe(sessionIdForLaunch);
  });

  it('returns null for db id when sessionIdMode is harness-issued', () => {
    const stubHarness = {
      id: 'stub',
      displayName: 'Stub',
      sessionIdMode: 'harness-issued' as const,
      newSessionId: vi.fn(() => 'harness-generated-id'),
      buildLaunchCommand: vi.fn(),
      buildResumeCommand: vi.fn(),
      buildContinueCommand: vi.fn(),
      installHooks: vi.fn(),
      syncAgents: vi.fn(),
      resolveFlags: vi.fn(() => ''),
      validateSettings: vi.fn(() => ({})),
      validateAgentName: vi.fn((s: string) => s),
    };

    const { sessionIdForDb, sessionIdForLaunch } = computeFreshSessionIds(stubHarness as any);
    expect(sessionIdForDb).toBeNull();
    expect(sessionIdForLaunch).toBe('harness-generated-id');
  });

  it('calls newSessionId exactly once for orchestrator-assigned mode', () => {
    const mockNewId = vi.fn(() => 'single-id');
    const stubHarness = {
      id: 'stub',
      displayName: 'Stub',
      sessionIdMode: 'orchestrator-assigned' as const,
      newSessionId: mockNewId,
    };

    computeFreshSessionIds(stubHarness as any);
    expect(mockNewId).toHaveBeenCalledTimes(1);
  });
});

// ─── prepareResumeLaunch ──────────────────────────────────────────────────────

describe('prepareResumeLaunch', () => {
  function makeHarness(overrides: Partial<Record<string, any>> = {}) {
    return {
      id: 'stub-harness',
      displayName: 'Stub',
      sessionIdMode: 'orchestrator-assigned' as const,
      newSessionId: vi.fn(() => 'new-session-id-xyz'),
      buildResumeCommand: vi.fn(() => 'claude --resume existing-session'),
      buildContinueCommand: vi.fn(() => 'claude --continue new-session-id-xyz'),
      buildLaunchCommand: vi.fn(() => 'claude --session-id new-session-id-xyz'),
      installHooks: vi.fn(),
      syncAgents: vi.fn(),
      resolveFlags: vi.fn(() => ''),
      validateSettings: vi.fn(() => ({})),
      validateAgentName: vi.fn((s: string) => s),
      ...overrides,
    };
  }

  it('uses buildResumeCommand when harness_session_id is present', () => {
    const agent = { ...DEFAULTS.agent, harness_session_id: 'existing-session-id' };
    insertTask(db);
    insertAgent(db, agent);

    const harness = makeHarness();
    const result = prepareResumeLaunch({
      agent: agent as any,
      harness: harness as any,
      flags: '',
      model: null,
      cwd: '/wt',
    });

    expect(result).toBe('claude --resume existing-session');
    expect(harness.buildResumeCommand).toHaveBeenCalledWith({
      sessionId: 'existing-session-id',
      flags: '',
      model: null,
      workspacePath: '/wt',
    });
    expect(harness.buildContinueCommand).not.toHaveBeenCalled();
    expect(harness.buildLaunchCommand).not.toHaveBeenCalled();
  });

  it('uses buildContinueCommand when harness_session_id is absent and continue is supported', () => {
    const agent = { ...DEFAULTS.agent, harness_session_id: null };
    insertTask(db);
    insertAgent(db, agent);

    const harness = makeHarness({
      buildContinueCommand: vi.fn(() => 'claude --continue new-session-id-xyz'),
    });

    const result = prepareResumeLaunch({
      agent: agent as any,
      harness: harness as any,
      flags: '',
      model: null,
      cwd: '/wt',
    });

    expect(result).toBe('claude --continue new-session-id-xyz');
    expect(harness.buildResumeCommand).not.toHaveBeenCalled();
    expect(harness.buildContinueCommand).toHaveBeenCalled();
  });

  it('uses buildLaunchCommand when buildContinueCommand returns null', () => {
    const agent = { ...DEFAULTS.agent, harness_session_id: null };
    insertTask(db);
    insertAgent(db, agent);

    const harness = makeHarness({
      buildContinueCommand: vi.fn(() => null),
      buildLaunchCommand: vi.fn(() => 'claude --session-id new-session-id-xyz'),
    });

    const result = prepareResumeLaunch({
      agent: agent as any,
      harness: harness as any,
      flags: '',
      model: null,
      cwd: '/wt',
    });

    expect(result).toBe('claude --session-id new-session-id-xyz');
    expect(harness.buildLaunchCommand).toHaveBeenCalled();
  });

  it('calls setAgentHarnessSessionId when sessionIdMode=orchestrator-assigned and no prior session', () => {
    const agent = { ...DEFAULTS.agent, harness_session_id: null };
    insertTask(db);
    insertAgent(db, agent);

    const harness = makeHarness({
      sessionIdMode: 'orchestrator-assigned' as const,
      buildContinueCommand: vi.fn(() => 'claude --continue new-session-id-xyz'),
    });

    prepareResumeLaunch({
      agent: agent as any,
      harness: harness as any,
      flags: '',
      model: null,
      cwd: '/wt',
    });

    // setAgentHarnessSessionId should have updated the DB
    const updatedAgent = db
      .prepare('SELECT harness_session_id FROM workers WHERE id = ?')
      .get(DEFAULTS.agent.id) as { harness_session_id: string } | undefined;
    expect(updatedAgent?.harness_session_id).toBe('new-session-id-xyz');
  });

  it('does NOT call setAgentHarnessSessionId when sessionIdMode=harness-issued', () => {
    const agent = { ...DEFAULTS.agent, harness_session_id: null };
    insertTask(db);
    insertAgent(db, agent);

    const harness = makeHarness({
      sessionIdMode: 'harness-issued' as const,
      buildContinueCommand: vi.fn(() => 'claude --continue new-session-id-xyz'),
    });

    prepareResumeLaunch({
      agent: agent as any,
      harness: harness as any,
      flags: '',
      model: null,
      cwd: '/wt',
    });

    // harness_session_id should remain null (not updated)
    const updatedAgent = db
      .prepare('SELECT harness_session_id FROM workers WHERE id = ?')
      .get(DEFAULTS.agent.id) as { harness_session_id: string | null } | undefined;
    expect(updatedAgent?.harness_session_id).toBeNull();
  });

  it('does NOT call setAgentHarnessSessionId when harness_session_id is already present', () => {
    const agent = { ...DEFAULTS.agent, harness_session_id: 'existing-session-id' };
    insertTask(db);
    insertAgent(db, agent);

    const harness = makeHarness({
      sessionIdMode: 'orchestrator-assigned' as const,
      buildResumeCommand: vi.fn(() => 'claude --resume existing-session'),
    });

    prepareResumeLaunch({
      agent: agent as any,
      harness: harness as any,
      flags: '',
      model: null,
      cwd: '/wt',
    });

    // harness_session_id should remain the original value (resume path doesn't set it)
    const updatedAgent = db
      .prepare('SELECT harness_session_id FROM workers WHERE id = ?')
      .get(DEFAULTS.agent.id) as { harness_session_id: string } | undefined;
    expect(updatedAgent?.harness_session_id).toBe('existing-session-id');
  });
});

// ─── launchAgentWindow ────────────────────────────────────────────────────────

describe('launchAgentWindow', () => {
  it('fresh=true emits new-session with the startup command', async () => {
    await launchAgentWindow(localSession, {
      session: 'octomux-agent-test01',
      cwd: '/wt',
      startupCmd: 'bash -ic claude',
      fresh: true,
    });

    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['new-session'],
    });
    expect(call).toBeDefined();
  });

  it('fresh=true emits set-option aggressive-resize', async () => {
    await launchAgentWindow(localSession, {
      session: 'octomux-agent-test01',
      cwd: '/wt',
      startupCmd: 'bash -ic claude',
      fresh: true,
    });

    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['set-option', 'aggressive-resize', 'on'],
    });
    expect(call).toBeDefined();
  });

  it('fresh=true queries active window index via display-message', async () => {
    const idx = await launchAgentWindow(localSession, {
      session: 'octomux-agent-test01',
      cwd: '/wt',
      startupCmd: 'bash -ic claude',
      fresh: true,
    });

    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['display-message'],
    });
    expect(call).toBeDefined();
    expect(typeof idx).toBe('number');
  });

  it('fresh=false emits new-window (not new-session)', async () => {
    await launchAgentWindow(localSession, {
      session: 'octomux-agent-test01',
      cwd: '/wt',
      startupCmd: 'bash -ic claude',
      fresh: false,
    });

    const newWindowCall = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['new-window'],
    });
    expect(newWindowCall).toBeDefined();

    const newSessionCall = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['new-session'],
    });
    expect(newSessionCall).toBeUndefined();
  });

  it('fresh=false queries last window index via list-windows', async () => {
    const idx = await launchAgentWindow(localSession, {
      session: 'octomux-agent-test01',
      cwd: '/wt',
      startupCmd: 'bash -ic claude',
      fresh: false,
    });

    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['list-windows'],
    });
    expect(call).toBeDefined();
    expect(typeof idx).toBe('number');
  });

  it('fresh=true passes session and cwd to new-session', async () => {
    await launchAgentWindow(localSession, {
      session: 'my-session',
      cwd: '/my/worktree',
      startupCmd: 'bash -ic claude',
      fresh: true,
    });

    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['new-session', '-s', 'my-session', '-c', '/my/worktree'],
    });
    expect(call).toBeDefined();
  });

  it('fresh=false passes session and cwd to new-window', async () => {
    await launchAgentWindow(localSession, {
      session: 'my-session',
      cwd: '/my/worktree',
      startupCmd: 'bash -ic claude',
      fresh: false,
    });

    const call = findExecCall(vi.mocked(execFile), {
      cmd: 'tmux',
      argsInclude: ['new-window', '-t', 'my-session', '-c', '/my/worktree'],
    });
    expect(call).toBeDefined();
  });
});

// ─── applyOrchestratorMcpConfig ───────────────────────────────────────────────

describe('applyOrchestratorMcpConfig', () => {
  it('returns flags unchanged when task is not orchestrator-managed', async () => {
    vi.mocked(isOrchestratorManaged).mockReturnValue(false);

    const result = await applyOrchestratorMcpConfig(
      localSession,
      '--some-flag',
      worktreeDir,
      'task-001',
      'hook-token-x',
    );
    expect(result).toBe('--some-flag');
  });

  it('returns flags unchanged when managed but mcpServerInvocation returns null', async () => {
    vi.mocked(isOrchestratorManaged).mockReturnValue(true);
    vi.mocked(mcpServerInvocation).mockReturnValue(null);

    const result = await applyOrchestratorMcpConfig(
      localSession,
      '--some-flag',
      worktreeDir,
      'task-001',
      'hook-token-x',
    );
    expect(result).toBe('--some-flag');
  });

  it('appends --mcp-config to flags when managed and config written successfully', async () => {
    vi.mocked(isOrchestratorManaged).mockReturnValue(true);
    vi.mocked(mcpServerInvocation).mockReturnValue({
      command: '/usr/bin/node',
      args: ['/path/to/server.js'],
    });

    const result = await applyOrchestratorMcpConfig(
      localSession,
      '--some-flag',
      worktreeDir,
      'task-001',
      'hook-token-x',
    );
    expect(result).toContain('--mcp-config');
    expect(result.startsWith('--some-flag')).toBe(true);
  });

  it('includes the mcp config path in quotes in the flags', async () => {
    vi.mocked(isOrchestratorManaged).mockReturnValue(true);
    vi.mocked(mcpServerInvocation).mockReturnValue({
      command: '/usr/bin/node',
      args: ['/path/to/server.js'],
    });

    const result = await applyOrchestratorMcpConfig(
      localSession,
      '',
      worktreeDir,
      'task-001',
      'hook-token-x',
    );
    expect(result).toMatch(/--mcp-config '.*worker-mcp-config\.json'/);
  });
});

// ─── writeWorkerMcpConfig ─────────────────────────────────────────────────────

describe('writeWorkerMcpConfig', () => {
  it('returns null when mcpServerInvocation returns null', async () => {
    vi.mocked(mcpServerInvocation).mockReturnValue(null);

    const result = await writeWorkerMcpConfig(
      localSession,
      worktreeDir,
      'task-001',
      'hook-token-x',
    );
    expect(result).toBeNull();
  });

  it('writes the config file when invocation is found', async () => {
    vi.mocked(mcpServerInvocation).mockReturnValue({
      command: '/usr/bin/node',
      args: ['/path/to/server.js'],
    });

    const result = await writeWorkerMcpConfig(
      localSession,
      worktreeDir,
      'task-001',
      'hook-token-x',
    );
    expect(result).toContain('worker-mcp-config.json');
    expect(fs.existsSync(result!)).toBe(true);
  });

  it('includes OCTOMUX_TASK_ID in the written config env', async () => {
    vi.mocked(mcpServerInvocation).mockReturnValue({
      command: '/usr/bin/node',
      args: ['/path/to/server.js'],
    });

    const cfgPath = await writeWorkerMcpConfig(localSession, worktreeDir, 'my-task-id', 'hook-tok');

    const cfg = JSON.parse(fs.readFileSync(cfgPath!, 'utf-8'));
    expect(cfg.mcpServers?.octomux?.env?.OCTOMUX_TASK_ID).toBe('my-task-id');
  });
});
