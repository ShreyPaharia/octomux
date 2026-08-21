/**
 * The end-to-end proof that the compute seam is real: a provider registered
 * from OUTSIDE core, through `ctx.compute`, is selected per task and is the
 * thing core's task-engine actually talks to.
 *
 * `server/plugins/context.test.ts` already covers registration/qualification
 * and `server/plugins/lifecycle.test.ts` covers unmount. What neither covers
 * is the half that matters for the ticket: that `tasks.compute` routes
 * `sessionFor()` to a plugin's provider, and that real task-engine helpers
 * (tmux window launch, worktree file writes) land on THAT provider rather
 * than on the server's own machine.
 */
import { describe, it, expect, beforeEach, vi } from '../bun-test.js';
import type { Task } from '../types.js';
import type { ComputeCreateContext, ComputeSession, ExecResult } from './types.js';

const { createPluginContext } = await import('../plugins/context.js');
const { qualify } = await import('../plugins/qualify.js');
const { resetCompute, freezeCoreCompute, getCompute, registerCompute } =
  await import('./registry.js');
const { localCompute } = await import('./local.js');
const { sessionFor, releaseSession, _resetSessions } = await import('./index.js');
const { launchAgentWindow, writeAgentLocalSettings } = await import('../task-engine/launch.js');

const PLUGIN_ID = 'acme-cloud';
const LOCAL_KIND = 'box';
const QUALIFIED = qualify(PLUGIN_ID, LOCAL_KIND);

/** A provider that records everything core asks of it. */
function recordingProvider() {
  const tmuxCalls: string[][] = [];
  const execCalls: string[][] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const disposed: Array<{ destroy?: boolean }> = [];
  let seenCtx: ComputeCreateContext | undefined;
  let seenTaskId: string | undefined;

  const ok = (stdout = ''): ExecResult => ({ stdout, stderr: '', exitCode: 0 });

  const provider = {
    kind: LOCAL_KIND,
    async create(task: Task, ctx: ComputeCreateContext): Promise<ComputeSession> {
      seenCtx = ctx;
      seenTaskId = task.id;
      return {
        kind: LOCAL_KIND,
        taskId: task.id,
        // Deliberately NOT task.repo_path — a remote provider clones
        // elsewhere, and core must use what the provider reports.
        repoPath: '/remote/checkouts/acme',
        async exec(argv: string[]) {
          execCalls.push(argv);
          return ok();
        },
        async tmux(args: string[]) {
          tmuxCalls.push(args);
          // `launchWindow(fresh: true)` parses a window index out of stdout.
          return { stdout: '7', stderr: '' };
        },
        spawn: vi.fn(),
        files: {
          exists: async () => false,
          mkdirp: async () => {},
          read: async () => null,
          write: async (path: string, content: string) => {
            writes.push({ path, content });
          },
          chmod: async () => {},
          copy: async () => {},
          rm: async () => {},
        },
        async dispose(opts?: { destroy?: boolean }) {
          disposed.push(opts ?? {});
        },
      } as unknown as ComputeSession;
    },
  };

  return {
    provider,
    tmuxCalls,
    execCalls,
    writes,
    disposed,
    ctx: () => seenCtx,
    taskId: () => seenTaskId,
  };
}

function taskOn(kind: string): Task {
  return {
    id: 'task-seam-1',
    repo_path: '/on/the/server',
    compute: kind,
  } as unknown as Task;
}

describe('a plugin-registered compute provider drives a task', () => {
  let rec: ReturnType<typeof recordingProvider>;

  beforeEach(() => {
    resetCompute();
    // resetCompute() wipes the core registration that local.ts does at import
    // time; put it back so the default-fallback case is still exercised.
    registerCompute(localCompute);
    _resetSessions();
    rec = recordingProvider();
    // Register the way a third-party plugin does — never touching the
    // registry directly, and never choosing its own qualified id.
    createPluginContext(PLUGIN_ID).compute.register(rec.provider);
    freezeCoreCompute();
  });

  it('is reachable only under its qualified id', () => {
    // The host qualifies on the way in; the plugin declared the bare `box`
    // and never sees or chooses `acme-cloud:box`.
    expect(getCompute(QUALIFIED).kind).toBe(QUALIFIED);
    expect(() => getCompute(LOCAL_KIND)).toThrow(/unknown compute/i);
  });

  it('tasks.compute selects it, and it receives the task plus a broker context', async () => {
    const session = await sessionFor(taskOn(QUALIFIED));

    expect(session.kind).toBe(LOCAL_KIND);
    expect(rec.taskId()).toBe('task-seam-1');
    // repoPath comes from the PROVIDER, not from task.repo_path.
    expect(session.repoPath).toBe('/remote/checkouts/acme');

    const ctx = rec.ctx()!;
    expect(typeof ctx.host.exec).toBe('function');
    expect(typeof ctx.host.spawnPty).toBe('function');
    expect(typeof ctx.execBackedFiles).toBe('function');
    expect(ctx.secrets).toEqual({});
  });

  it('core task-engine tmux work lands on the provider, not the local machine', async () => {
    const session = await sessionFor(taskOn(QUALIFIED));

    const windowIndex = await launchAgentWindow(session, {
      session: 'octomux-agent-task-seam-1',
      cwd: '/remote/checkouts/acme/.worktrees/feature',
      startupCmd: 'claude --session-id abc',
      fresh: true,
    });

    expect(windowIndex).toBe(7);
    expect(rec.tmuxCalls).toHaveLength(1);
    expect(rec.tmuxCalls[0]).toContain('new-session');
    expect(rec.tmuxCalls[0]).toContain('octomux-agent-task-seam-1');
  });

  it('core task-engine file writes land on the provider', async () => {
    const session = await sessionFor(taskOn(QUALIFIED));

    await writeAgentLocalSettings(session, '/remote/checkouts/acme/.worktrees/feature');

    expect(rec.writes).toHaveLength(1);
    expect(rec.writes[0]!.path).toBe(
      '/remote/checkouts/acme/.worktrees/feature/.claude/settings.local.json',
    );
    expect(JSON.parse(rec.writes[0]!.content)).toHaveProperty('plugins');
  });

  it('releaseSession({ destroy }) reaches the provider so a remote box is not leaked', async () => {
    const task = taskOn(QUALIFIED);
    await sessionFor(task);

    await releaseSession(task.id);
    expect(rec.disposed).toEqual([{}]);

    await sessionFor(task);
    await releaseSession(task.id, { destroy: true });
    expect(rec.disposed[1]).toEqual({ destroy: true });
  });

  it('a task with no compute column still falls back to local', async () => {
    const session = await sessionFor({ id: 'plain', repo_path: '/on/the/server' } as Task);
    expect(session.kind).toBe('local');
    expect(session.repoPath).toBe('/on/the/server');
  });
  it('a task pinned to a provider whose plugin is gone fails loudly, not silently local', async () => {
    // Disabling or uninstalling a plugin leaves its tasks pointing at a kind
    // nothing serves. Falling back to `local` here would quietly run the task
    // on the wrong machine; the caller (startTask) turns this rejection into
    // the task's `error` state instead.
    await expect(sessionFor(taskOn('ghost:box'))).rejects.toThrow(/unknown compute provider/i);
  });
});
