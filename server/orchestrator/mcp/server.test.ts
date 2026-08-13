/**
 * server/orchestrator/mcp/server.test.ts
 *
 * Tests for createOctomuxMcpServer — verifies that:
 *  - report_complete is registered ONLY when OCTOMUX_TASK_ID is set (worker mode)
 *  - Conductor write tools are registered ONLY when OCTOMUX_CONVERSATION_ID + base url + token
 *    are set (and OCTOMUX_TASK_ID is NOT set)
 *  - Worker mode (OCTOMUX_TASK_ID) disables conductor write tools
 *  - The capability-registry tools (list_tasks/get_task/create_task/set_task_status/
 *    close_task/delete_task) are registered ONLY alongside the conductor write
 *    tools (orchestratorWriteEnabled()) — never for a worker session, and never
 *    for a "plain" session with no env at all.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the DB and store so the server module can be imported without a real DB
vi.mock('../../db.js', () => ({
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
      get: vi.fn(() => undefined),
      run: vi.fn(),
    })),
  })),
}));

vi.mock('../../repositories/orchestrator.js', async () => {
  const actual = await vi.importActual<typeof import('../../repositories/orchestrator.js')>(
    '../../repositories/orchestrator.js',
  );
  return {
    ...actual,
    getManagedTask: vi.fn(() => undefined),
    isOrchestratorManaged: vi.fn(() => false),
  };
});

vi.mock('../../logger.js', () => ({
  childLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Helper to extract registered tool names from an McpServer instance
// by inspecting its internal tool registry (implementation detail, but stable).
// The SDK stores them as a plain object keyed by tool name.
function getRegisteredToolNames(
  server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer,
): string[] {
  // The MCP SDK stores tools in _registeredTools (private, plain object)
  const priv = server as unknown as { _registeredTools?: Record<string, unknown> };
  if (!priv._registeredTools) return [];
  return Object.keys(priv._registeredTools);
}

describe('createOctomuxMcpServer — tool registration', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save env vars we'll mutate
    savedEnv['OCTOMUX_TASK_ID'] = process.env.OCTOMUX_TASK_ID;
    savedEnv['OCTOMUX_ACTION_TOKEN'] = process.env.OCTOMUX_ACTION_TOKEN;
    savedEnv['OCTOMUX_ACTION_BASE_URL'] = process.env.OCTOMUX_ACTION_BASE_URL;
    savedEnv['OCTOMUX_CONVERSATION_ID'] = process.env.OCTOMUX_CONVERSATION_ID;

    // Clear all
    delete process.env.OCTOMUX_TASK_ID;
    delete process.env.OCTOMUX_ACTION_TOKEN;
    delete process.env.OCTOMUX_ACTION_BASE_URL;
    delete process.env.OCTOMUX_CONVERSATION_ID;
  });

  afterEach(() => {
    // Restore
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    vi.resetModules();
  });

  it('does NOT register report_complete when OCTOMUX_TASK_ID is absent (read-only mode)', async () => {
    const { createOctomuxMcpServer } = await import('./server.js');
    const server = createOctomuxMcpServer();
    const tools = getRegisteredToolNames(server);
    expect(tools).not.toContain('report_complete');
    // Read tools with no capability-registry equivalent are always registered.
    expect(tools).toContain('monitor_status');
    expect(tools).toContain('get_task_output');
  });

  it('registers only the auto-tier capability tools for a "plain" session (no env at all)', async () => {
    const { createOctomuxMcpServer } = await import('./server.js');
    const server = createOctomuxMcpServer();
    const tools = getRegisteredToolNames(server);
    // The 'auto' tier is unconditional — reads have no blast radius, so there
    // is nothing for orchestratorWriteEnabled() to protect.
    expect(tools).toContain('list_tasks');
    expect(tools).toContain('get_task');
    // Everything above 'auto' still requires orchestratorWriteEnabled().
    expect(tools).not.toContain('create_task');
    expect(tools).not.toContain('set_task_status');
    expect(tools).not.toContain('close_task');
    expect(tools).not.toContain('delete_task');
  });

  it('registers report_complete when all three worker env vars are set', async () => {
    process.env.OCTOMUX_TASK_ID = 'task-test-worker';
    process.env.OCTOMUX_ACTION_TOKEN = 'tok-worker';
    process.env.OCTOMUX_ACTION_BASE_URL = 'http://127.0.0.1:7777';

    const { createOctomuxMcpServer } = await import('./server.js');
    const server = createOctomuxMcpServer();
    const tools = getRegisteredToolNames(server);
    expect(tools).toContain('report_complete');
  });

  it('does NOT register report_complete when OCTOMUX_TASK_ID set but token missing', async () => {
    process.env.OCTOMUX_TASK_ID = 'task-no-token';
    // No OCTOMUX_ACTION_TOKEN, no OCTOMUX_ACTION_BASE_URL

    const { createOctomuxMcpServer } = await import('./server.js');
    const server = createOctomuxMcpServer();
    const tools = getRegisteredToolNames(server);
    expect(tools).not.toContain('report_complete');
  });

  it('does NOT register conductor write tools when OCTOMUX_TASK_ID is set (worker mode)', async () => {
    process.env.OCTOMUX_TASK_ID = 'task-worker-no-write';
    process.env.OCTOMUX_ACTION_TOKEN = 'tok-w';
    process.env.OCTOMUX_ACTION_BASE_URL = 'http://127.0.0.1:7777';
    process.env.OCTOMUX_CONVERSATION_ID = 'conv-w';

    const { createOctomuxMcpServer } = await import('./server.js');
    const server = createOctomuxMcpServer();
    const tools = getRegisteredToolNames(server);
    // Worker mode: report_complete plus the 'auto'-tier reads, and nothing
    // that mutates. The tier filter in server.ts is what draws this line —
    // see the rationale at that call site.
    expect(tools).toContain('report_complete');
    expect(tools).toContain('list_tasks');
    expect(tools).toContain('get_task');
    expect(tools).not.toContain('create_task');
    expect(tools).not.toContain('send_message');
    expect(tools).not.toContain('set_task_status');
    expect(tools).not.toContain('close_task');
    expect(tools).not.toContain('delete_task');
  });

  it('registers conductor write tools when OCTOMUX_CONVERSATION_ID is set without OCTOMUX_TASK_ID', async () => {
    process.env.OCTOMUX_ACTION_TOKEN = 'tok-conductor';
    process.env.OCTOMUX_ACTION_BASE_URL = 'http://127.0.0.1:7777';
    process.env.OCTOMUX_CONVERSATION_ID = 'conv-conductor';
    // No OCTOMUX_TASK_ID → conductor mode

    const { createOctomuxMcpServer } = await import('./server.js');
    const server = createOctomuxMcpServer();
    const tools = getRegisteredToolNames(server);
    // Conductor mode: write tools, NOT report_complete
    expect(tools).not.toContain('report_complete');
    expect(tools).toContain('create_task');
    expect(tools).toContain('send_message');
    // Capability-registry tools ride the same gate.
    expect(tools).toContain('list_tasks');
    expect(tools).toContain('get_task');
    expect(tools).toContain('set_task_status');
    expect(tools).toContain('close_task');
    expect(tools).toContain('delete_task');
  });
});

// ─── onGatedInvoke wiring (this is the core of the ask/always-ask gate) ──────
//
// Proves `onGatedInvoke` is actually PASSED at the registerCapabilityMcpTools
// call site in server.ts — not just declared as an extension point. Before
// this wiring, invoking close_task ran cap.handler immediately; now it must
// hit the gate FIRST. We never let the RPC succeed here (global fetch always
// rejects), so if the gate is wired we get a distinctive
// "could not create an approval card" isError — a message that can only come
// from onGatedInvoke's own catch block (server/orchestrator/mcp/gate.ts). If
// someone strips the wiring, this test fails because the tool call would
// instead reach cap.handler's real task.close logic (a different failure, or
// no failure at all).
describe('createOctomuxMcpServer — onGatedInvoke wiring', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv['OCTOMUX_TASK_ID'] = process.env.OCTOMUX_TASK_ID;
    savedEnv['OCTOMUX_ACTION_TOKEN'] = process.env.OCTOMUX_ACTION_TOKEN;
    savedEnv['OCTOMUX_ACTION_BASE_URL'] = process.env.OCTOMUX_ACTION_BASE_URL;
    savedEnv['OCTOMUX_CONVERSATION_ID'] = process.env.OCTOMUX_CONVERSATION_ID;
    savedEnv['OCTOMUX_CAPABILITY_GATE_ENABLED'] = process.env.OCTOMUX_CAPABILITY_GATE_ENABLED;

    delete process.env.OCTOMUX_TASK_ID;
    process.env.OCTOMUX_ACTION_TOKEN = 'tok-conductor';
    process.env.OCTOMUX_ACTION_BASE_URL = 'http://127.0.0.1:7777';
    process.env.OCTOMUX_CONVERSATION_ID = 'conv-conductor';
    delete process.env.OCTOMUX_CAPABILITY_GATE_ENABLED;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('close_task (always-ask) hits onGatedInvoke instead of running immediately', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED (no server listening in this test)')),
    );

    const { createOctomuxMcpServer } = await import('./server.js');
    const server = createOctomuxMcpServer();
    const priv = server as unknown as {
      _registeredTools: Record<string, { handler: (input: unknown, extra: unknown) => unknown }>;
    };
    const tool = priv._registeredTools['close_task'];
    expect(tool).toBeDefined();

    const result = (await tool.handler({ task_id: 'task-x' }, {})) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/could not create an approval card/);
  });
});
