import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { nanoid } from 'nanoid';
import { runAgentSession, mcpSubmitResultCapture } from './session.js';
import type { CaptureStrategy, RunAgentSessionOptions } from './session.js';
import type { ProcessHandle, ProcessSubstrate } from './substrate.js';
import type { Harness } from '../harnesses/types.js';

// ─── Stub factories ──────────────────────────────────────────────────────────

type ExitCb = (info: { code: number; signal?: number }) => void;

interface StubHandle extends ProcessHandle {
  _triggerExit(code: number): void;
  disposeSpy: ReturnType<typeof vi.fn>;
}

function makeStubHandle(autoExit?: { afterMs: number; code: number }): StubHandle {
  const disposeSpy = vi.fn();
  let exitCb: ExitCb | null = null;
  let disposed = false;

  const handle: StubHandle = {
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
    _triggerExit(code: number) {
      exitCb?.({ code });
    },
    disposeSpy,
  };

  if (autoExit) {
    setTimeout(() => {
      handle._triggerExit(autoExit.code);
    }, autoExit.afterMs);
  }

  return handle;
}

function makeStubSubstrate(handle: ProcessHandle): ProcessSubstrate {
  return {
    kind: 'pty' as const,
    spawn: vi.fn().mockResolvedValue(handle),
  };
}

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
    syncAgents: vi.fn().mockResolvedValue(undefined),
    resolveFlags: vi.fn().mockReturnValue(''),
    validateSettings: vi.fn().mockReturnValue({}),
    validateAgentName: vi.fn().mockImplementation((n: string) => n),
  };
}

function makeStubCapture<T>(
  result: T,
  delay = 0,
): CaptureStrategy<T> & { disposeSpy: ReturnType<typeof vi.fn> } {
  const disposeSpy = vi.fn();
  return {
    setup: vi.fn().mockResolvedValue({ extraArgs: '' }),
    waitForResult: () =>
      new Promise<T>((resolve) => {
        setTimeout(() => resolve(result), delay);
      }),
    dispose: disposeSpy,
    disposeSpy,
  };
}

// ─── Test suites ─────────────────────────────────────────────────────────────

describe('runAgentSession', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = path.join(os.tmpdir(), `octomux-test-${nanoid(8)}`);
    fs.mkdirSync(workspaceDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('resolves with result and calls dispose on both handle and capture', async () => {
    const expectedResult = { reply: 'ok' };
    const handle = makeStubHandle();
    const substrate = makeStubSubstrate(handle);
    const capture = makeStubCapture(expectedResult);
    const harness = makeStubHarness();

    const resultDir = path.join(os.tmpdir(), `octomux-test-rd-${nanoid(8)}`);
    fs.mkdirSync(resultDir, { recursive: true });

    try {
      const opts: RunAgentSessionOptions<typeof expectedResult> = {
        workspaceDir,
        harness,
        input: 'hello world prompt',
        substrate,
        outputSchema: {
          type: 'object',
          properties: { reply: { type: 'string' } },
          required: ['reply'],
        },
        capture,
        resultDir,
      };

      const { result } = await runAgentSession(opts);

      // Assert the result is correct
      expect(result).toEqual(expectedResult);

      // Assert substrate.spawn was called with a command containing the input (via prompt file ref)
      // and with cwd === workspaceDir
      expect(substrate.spawn).toHaveBeenCalledOnce();
      const spawnOpts = (substrate.spawn as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        command: string;
        cwd: string;
      };
      expect(spawnOpts.cwd).toBe(workspaceDir);
      // The command should reference the prompt file (contains --print or < path)
      expect(spawnOpts.command).toContain('--print');

      // Both handle.dispose and capture.dispose must have been called
      expect(handle.disposeSpy).toHaveBeenCalledOnce();
      expect(capture.disposeSpy).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(resultDir, { recursive: true, force: true });
    }
  });

  it('rejects when agent exits before submitting result, and still calls dispose', async () => {
    const handle = makeStubHandle();
    const substrate = makeStubSubstrate(handle);
    const harness = makeStubHarness();

    // A capture whose waitForResult never resolves
    const disposeSpy = vi.fn();
    const neverCapture: CaptureStrategy<never> = {
      setup: vi.fn().mockResolvedValue({ extraArgs: '' }),
      waitForResult: () => new Promise(() => {}), // never resolves
      dispose: disposeSpy,
    };

    const resultDir = path.join(os.tmpdir(), `octomux-test-rd-${nanoid(8)}`);
    fs.mkdirSync(resultDir, { recursive: true });

    try {
      const sessionPromise = runAgentSession({
        workspaceDir,
        harness,
        input: 'some prompt',
        substrate,
        outputSchema: { type: 'object' },
        capture: neverCapture,
        resultDir,
      });

      // Trigger the agent exit immediately after spawn
      // We need to wait a tick for substrate.spawn to complete and onExit to be registered
      await new Promise<void>((resolve) => setImmediate(resolve));
      handle._triggerExit(0);

      await expect(sessionPromise).rejects.toThrow('exited before submitting result');

      // dispose must still have been called on both
      expect(handle.disposeSpy).toHaveBeenCalledOnce();
      expect(disposeSpy).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(resultDir, { recursive: true, force: true });
    }
  });

  it('rejects on timeout and calls dispose', async () => {
    const handle = makeStubHandle();
    const substrate = makeStubSubstrate(handle);
    const harness = makeStubHarness();

    const disposeSpy = vi.fn();
    const slowCapture: CaptureStrategy<never> = {
      setup: vi.fn().mockResolvedValue({ extraArgs: '' }),
      waitForResult: () => new Promise(() => {}), // never resolves
      dispose: disposeSpy,
    };

    const resultDir = path.join(os.tmpdir(), `octomux-test-rd-${nanoid(8)}`);
    fs.mkdirSync(resultDir, { recursive: true });

    try {
      await expect(
        runAgentSession({
          workspaceDir,
          harness,
          input: 'some prompt',
          substrate,
          outputSchema: { type: 'object' },
          capture: slowCapture,
          timeoutMs: 50, // very short timeout
          resultDir,
        }),
      ).rejects.toThrow(/timed out/);

      expect(handle.disposeSpy).toHaveBeenCalledOnce();
      expect(disposeSpy).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(resultDir, { recursive: true, force: true });
    }
  });
});

describe('mcpSubmitResultCapture — default capture round-trip', () => {
  it('resolves waitForResult when result file is written', async () => {
    const resultDir = path.join(os.tmpdir(), `octomux-test-cap-${nanoid(8)}`);
    const schema = {
      type: 'object',
      properties: { reply: { type: 'string' } },
      required: ['reply'],
      additionalProperties: false,
    };

    const capture = mcpSubmitResultCapture<{ reply: string }>(schema, { resultDir });

    try {
      // setup() creates the resultDir and returns extraArgs
      const { extraArgs } = await capture.setup({ workspaceDir: resultDir });
      // extraArgs either contains --mcp-config or is empty (if invocation not found in prod)
      expect(typeof extraArgs).toBe('string');

      const resultPath = path.join(resultDir, 'result.json');
      const expectedValue = { reply: 'hi' };

      // Start waiting for result
      const waitPromise = capture.waitForResult();

      // Manually write the result file (simulating what the MCP server would do)
      await new Promise<void>((resolve) => setImmediate(resolve)); // let watcher attach
      fs.writeFileSync(resultPath, JSON.stringify(expectedValue));

      // The capture should resolve with the written value
      const result = await waitPromise;
      expect(result).toEqual(expectedValue);
    } finally {
      capture.dispose();
      // dispose() removes the resultDir, but guard in case it was already cleaned
      fs.rmSync(resultDir, { recursive: true, force: true });
    }
  }, 10_000);

  it('resolves immediately if result file already exists when waitForResult is called', async () => {
    const resultDir = path.join(os.tmpdir(), `octomux-test-cap2-${nanoid(8)}`);
    const schema = {
      type: 'object',
      properties: { answer: { type: 'number' } },
      required: ['answer'],
    };

    const capture = mcpSubmitResultCapture<{ answer: number }>(schema, { resultDir });

    try {
      await capture.setup({ workspaceDir: resultDir });

      const resultPath = path.join(resultDir, 'result.json');
      const expectedValue = { answer: 42 };

      // Write the file BEFORE calling waitForResult
      fs.writeFileSync(resultPath, JSON.stringify(expectedValue));

      const result = await capture.waitForResult();
      expect(result).toEqual(expectedValue);
    } finally {
      capture.dispose();
      fs.rmSync(resultDir, { recursive: true, force: true });
    }
  });
});
