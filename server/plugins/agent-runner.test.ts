/**
 * server/plugins/agent-runner.test.ts
 *
 * Tests `ctx.agents.run()` (SHR-272) — the plugin-facing wrapper context.ts
 * builds around `runAgentSession`. These drive the REAL `runAgentSession`
 * (server/agent-session/session.ts is not mocked) so they actually prove the
 * wiring: only the two injection points a plugin cannot reasonably exercise
 * for real — the harness registry and the pty substrate — are stubbed. `fs`
 * is deliberately left real (unlike context.test.ts) so the ephemeral-scratch
 * -dir behavior is exercised against a real tmpdir; suites run
 * `--parallel`/`--isolate`, so this file's unmocked `fs` cannot collide with
 * context.test.ts's mocked one.
 */
import { describe, it, expect, vi, beforeEach } from '../bun-test.js';
import os from 'os';
import path from 'path';
import fs from 'fs';
import type { Harness } from '../harnesses/types.js';
import type { SpawnOptions } from '../agent-session/substrate.js';
import { createTestDb } from '../test-helpers.js';
import { listAllRuns } from '../repositories/runs.js';

// ─── Injection-point mocks (registered before importing context.js) ────────

const mockGetHarness = vi.fn();
vi.mock('../harnesses/registry.js', () => ({
  getHarness: (...args: unknown[]) => mockGetHarness(...args),
}));

const mockSpawn = vi.fn();
vi.mock('../agent-session/substrate-pty.js', () => ({
  ptySubstrate: {
    kind: 'pty',
    spawn: (...args: unknown[]) => mockSpawn(...(args as [SpawnOptions])),
  },
}));

const { createPluginContext, disposePluginContext } = await import('./context.js');

// ─── Stub factories ──────────────────────────────────────────────────────────
// Copied shape from server/agent-session/session.test.ts's makeStubHarness /
// makeStubHandle — only `runAgentSession`'s two injected collaborators.

function makeStubHarness(): Harness {
  return {
    id: 'stub',
    displayName: 'Stub Harness',
    sessionIdMode: 'orchestrator-assigned',
    newSessionId: () => 'stub-session-id',
    buildLaunchCommand: ({
      flags = '',
      model,
    }: {
      sessionId: string;
      agent?: string | null;
      flags?: string;
      model?: string | null;
      workspacePath?: string;
    }) => {
      const modelPart = model ? ` --model ${model}` : '';
      return `stub-agent ${flags}${modelPart}`.trim();
    },
    buildResumeCommand: vi.fn().mockReturnValue('stub-resume'),
    buildContinueCommand: vi.fn().mockReturnValue(null),
    installHooks: vi.fn().mockResolvedValue(undefined),
    uninstallHooks: vi.fn().mockResolvedValue(undefined),
    resolveFlags: vi.fn().mockReturnValue(''),
    validateSettings: vi.fn().mockReturnValue({}),
    validateAgentName: vi.fn().mockImplementation((n: string) => n),
  };
}

type ExitCb = (info: { code: number; signal?: number }) => void;

interface StubHandle {
  write: ReturnType<typeof vi.fn>;
  onData: ReturnType<typeof vi.fn>;
  onExit(cb: ExitCb): void;
  dispose(): void;
  disposeSpy: ReturnType<typeof vi.fn>;
  _triggerExit(code: number): void;
}

/** A handle that never exits on its own unless `_triggerExit` is called. */
function makeStubHandle(): StubHandle {
  const disposeSpy = vi.fn();
  let exitCb: ExitCb | null = null;
  let disposed = false;
  return {
    write: vi.fn(),
    onData: vi.fn(),
    onExit(cb: ExitCb) {
      exitCb = cb;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      disposeSpy();
    },
    disposeSpy,
    _triggerExit(code: number) {
      exitCb?.({ code });
    },
  };
}

/** The prompt file path is a quoted `--print < '<promptFile>'` tail on every
 *  launch command runAgentSession builds; its dirname is the per-run resultDir
 *  (mcp-config.json + result.json live there). */
function resultDirFromCommand(command: string): string {
  const m = command.match(/--print < '([^']+)'/);
  if (!m) throw new Error(`resultDirFromCommand: no prompt file in command: ${command}`);
  return path.dirname(m[1]);
}

function mcpConfigPathFromCommand(command: string): string | null {
  const m = command.match(/--mcp-config '([^']+)'/);
  return m ? m[1] : null;
}

/** Polls until `check()` is true, instead of a fixed sleep. */
async function waitUntil(check: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs)
      throw new Error('waitUntil: timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

beforeEach(() => {
  mockGetHarness.mockReset();
  mockGetHarness.mockReturnValue(makeStubHarness());
  mockSpawn.mockReset();
});

describe('ctx.agents.run — result plumbing', () => {
  it(
    "resolves with the result UNWRAPPED (not {result: ...}), and threads the caller's " +
      'outputSchema into the MCP submit_result config — schema ENFORCEMENT itself lives in ' +
      'the submit_result MCP server, which is stubbed out here; this only asserts the agent ' +
      "is handed the caller's schema, not core's",
    async () => {
      let capturedCommand = '';
      let resultDir = '';
      mockSpawn.mockImplementation(async (opts: SpawnOptions) => {
        capturedCommand = opts.command;
        resultDir = resultDirFromCommand(opts.command);
        return makeStubHandle();
      });

      const schema = {
        type: 'object',
        properties: { outcome: { type: 'string' }, summary: { type: 'string' } },
        required: ['outcome', 'summary'],
      };
      const ctx = createPluginContext('agentplugin', ['agents.run']);
      const runPromise = ctx.agents.run<{ outcome: string; summary: string }>({
        input: 'do the thing',
        outputSchema: schema,
      });

      await waitUntil(() => resultDir !== '');

      const cfgPath = mcpConfigPathFromCommand(capturedCommand);
      expect(cfgPath).not.toBeNull();
      const cfg = JSON.parse(fs.readFileSync(cfgPath as string, 'utf8'));
      const schemaHandedToAgent = JSON.parse(
        cfg.mcpServers.submit_result.env.OCTOMUX_SUBMIT_RESULT_SCHEMA,
      );
      expect(schemaHandedToAgent).toEqual(schema);

      const expectedResult = { outcome: 'ok', summary: 'hi' };
      fs.writeFileSync(path.join(resultDir, 'result.json'), JSON.stringify(expectedResult));

      const result = await runPromise;
      expect(result).toEqual(expectedResult);
    },
  );
});

describe('ctx.agents.run — timeout', () => {
  it('rejects (does not hang) when the agent never submits a result, and disposes the handle', async () => {
    let handle: StubHandle | null = null;
    mockSpawn.mockImplementation(async () => {
      handle = makeStubHandle(); // never exits, nothing ever writes result.json
      return handle;
    });

    const ctx = createPluginContext('agentplugin', ['agents.run']);
    await expect(
      ctx.agents.run({ input: 'x', outputSchema: { type: 'object' }, timeoutMs: 50 }),
    ).rejects.toThrow(/timed out/);

    expect(handle).not.toBeNull();
    expect((handle as unknown as StubHandle).disposeSpy).toHaveBeenCalledOnce();
  });
});

describe('ctx.agents.run — workspace handling', () => {
  it('with workspaceDir omitted: spawns in a fresh dir under os.tmpdir() named octomux-plugin-<id>-*, empty at spawn time, removed after settling', async () => {
    let capturedCwd = '';
    let entriesAtSpawnTime: string[] = [];
    let existedAtSpawnTime = false;
    let resultDir = '';
    mockSpawn.mockImplementation(async (opts: SpawnOptions) => {
      capturedCwd = opts.cwd;
      existedAtSpawnTime = fs.existsSync(opts.cwd);
      entriesAtSpawnTime = existedAtSpawnTime ? fs.readdirSync(opts.cwd) : [];
      resultDir = resultDirFromCommand(opts.command);
      return makeStubHandle();
    });

    const ctx = createPluginContext('agentplugin', ['agents.run']);
    const runPromise = ctx.agents.run({ input: 'x', outputSchema: { type: 'object' } });

    await waitUntil(() => resultDir !== '');

    expect(capturedCwd.startsWith(os.tmpdir())).toBe(true);
    expect(path.basename(capturedCwd).startsWith('octomux-plugin-agentplugin-')).toBe(true);
    expect(existedAtSpawnTime).toBe(true);
    expect(entriesAtSpawnTime).toEqual([]);

    fs.writeFileSync(path.join(resultDir, 'result.json'), JSON.stringify({ ok: true }));
    await runPromise;

    expect(fs.existsSync(capturedCwd)).toBe(false);
  });

  it('with a caller-supplied workspaceDir: uses it verbatim and does NOT delete it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-test-caller-ws-'));
    try {
      let capturedCwd = '';
      let resultDir = '';
      mockSpawn.mockImplementation(async (opts: SpawnOptions) => {
        capturedCwd = opts.cwd;
        resultDir = resultDirFromCommand(opts.command);
        return makeStubHandle();
      });

      const ctx = createPluginContext('agentplugin', ['agents.run']);
      const runPromise = ctx.agents.run({
        input: 'x',
        outputSchema: { type: 'object' },
        workspaceDir: dir,
      });

      await waitUntil(() => resultDir !== '');
      expect(capturedCwd).toBe(dir);

      fs.writeFileSync(path.join(resultDir, 'result.json'), JSON.stringify({ ok: true }));
      await runPromise;

      expect(fs.existsSync(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the workspace is git-free: no worktree, no .git dir', async () => {
    let entriesAtSpawnTime: string[] = [];
    let resultDir = '';
    mockSpawn.mockImplementation(async (opts: SpawnOptions) => {
      entriesAtSpawnTime = fs.readdirSync(opts.cwd);
      resultDir = resultDirFromCommand(opts.command);
      return makeStubHandle();
    });

    const ctx = createPluginContext('agentplugin', ['agents.run']);
    const runPromise = ctx.agents.run({ input: 'x', outputSchema: { type: 'object' } });
    await waitUntil(() => resultDir !== '');

    expect(entriesAtSpawnTime).not.toContain('.git');

    fs.writeFileSync(path.join(resultDir, 'result.json'), JSON.stringify({ ok: true }));
    await runPromise;
  });
});

describe('ctx.agents.run — disposal', () => {
  it('disposePluginContext does not strand an in-flight run: returns promptly, the run still settles on its own, and a run started after disposal is rejected', async () => {
    let resultDir = '';
    let handle: StubHandle | null = null;
    mockSpawn.mockImplementation(async (opts: SpawnOptions) => {
      resultDir = resultDirFromCommand(opts.command);
      handle = makeStubHandle();
      return handle;
    });

    const ctx = createPluginContext('agentplugin', ['agents.run']);
    const inFlight = ctx.agents.run({
      input: 'x',
      outputSchema: { type: 'object' },
      timeoutMs: 300,
    });
    await waitUntil(() => resultDir !== '');

    const disposeStart = Date.now();
    const disposeFailures = await disposePluginContext(ctx);
    const disposeElapsed = Date.now() - disposeStart;

    expect(disposeFailures).toEqual([]);
    // Must not have waited out the in-flight run's 300ms timeout.
    expect(disposeElapsed).toBeLessThan(150);

    // The in-flight run was NOT cancelled by disposal — it settles on its own
    // (here, via its own timeout, since nothing ever writes result.json).
    await expect(inFlight).rejects.toThrow(/timed out/);

    // A NEW run after disposal is refused outright.
    await expect(ctx.agents.run({ input: 'y', outputSchema: { type: 'object' } })).rejects.toThrow(
      /revoked/,
    );
  });
});

describe('ctx.agents.run — no runs row', () => {
  it('does not create a `runs` row: ctx.agents.run never passes run: to runAgentSession', async () => {
    createTestDb();
    let resultDir = '';
    mockSpawn.mockImplementation(async (opts: SpawnOptions) => {
      resultDir = resultDirFromCommand(opts.command);
      return makeStubHandle();
    });

    const ctx = createPluginContext('agentplugin', ['agents.run']);
    const runPromise = ctx.agents.run({ input: 'x', outputSchema: { type: 'object' } });
    await waitUntil(() => resultDir !== '');

    fs.writeFileSync(path.join(resultDir, 'result.json'), JSON.stringify({ ok: true }));
    await runPromise;

    expect(listAllRuns()).toHaveLength(0);
  });
});
