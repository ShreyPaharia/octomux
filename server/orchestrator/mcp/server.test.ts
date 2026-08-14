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
    // close_task is 'auto' too: it is reversible (the session stays resumable,
    // worktree and branch survive) and it is the routine end of a task's life.
    expect(tools).toContain('close_task');
    // Everything above 'auto' still requires orchestratorWriteEnabled().
    expect(tools).not.toContain('create_task');
    expect(tools).not.toContain('set_task_status');
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
    // that mutates. The caller-class 'worker' + each capability's `callers`
    // list is what draws this line now — see the rationale at that call site.
    expect(tools).toContain('report_complete');
    expect(tools).toContain('list_tasks');
    expect(tools).toContain('get_task');
    // A worker gets close_task because it is 'auto'. That is not a widening of
    // what a worker can DO — every worker already has Bash and the review
    // prompts literally instruct it to run `octomux close-task <id>`. This is
    // the same power by a second route, not a new one.
    expect(tools).toContain('close_task');
    // NEW: a worker can now block on a human via ask_owner (always-ask tier,
    // but included in owner.ask's `callers` — see packages/capabilities/src/
    // capabilities/ask.ts). This is the capability this test file exists to
    // guard the boundary of.
    expect(tools).toContain('ask_owner');
    expect(tools).not.toContain('create_task');
    expect(tools).not.toContain('send_message');
    expect(tools).not.toContain('set_task_status');
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

  it('delete_task (ask) hits onGatedInvoke instead of running immediately', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED (no server listening in this test)')),
    );

    const { createOctomuxMcpServer } = await import('./server.js');
    const server = createOctomuxMcpServer();
    const priv = server as unknown as {
      _registeredTools: Record<string, { handler: (input: unknown, extra: unknown) => unknown }>;
    };
    const tool = priv._registeredTools['delete_task'];
    expect(tool).toBeDefined();

    const result = (await tool.handler({ task_id: 'task-x' }, {})) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };

    // Card creation fails (no server listening), so the gate denies. The point
    // is that it never reached the handler — a fail-open gate would have
    // returned a delete result or a "task not found" error instead.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/could not create an approval card/);
  });

  it('close_task (auto) runs immediately — no approval card, no gate', async () => {
    // The counterpart to the test above, and the reason close was moved off
    // always-ask: an auto capability must reach its handler with no human in
    // the loop. Reaching runCloseTask (and failing on a nonexistent task) is
    // proof the gate was not consulted; a gated call would have failed on
    // card creation first, exactly as delete_task does above.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED (no server listening in this test)')),
    );

    const { createOctomuxMcpServer } = await import('./server.js');
    const server = createOctomuxMcpServer();
    const priv = server as unknown as {
      _registeredTools: Record<string, { handler: (input: unknown, extra: unknown) => unknown }>;
    };
    const result = (await priv._registeredTools['close_task'].handler(
      { task_id: 'task-x' },
      {},
    )) as { content: Array<{ type: string; text: string }>; isError?: boolean };

    expect(result.content[0].text).not.toMatch(/could not create an approval card/);
    expect(result.content[0].text).toMatch(/task-x/);
  });
});

// ─── Worker can ask_owner but cannot create/delete/move a task ──────────────
//
// The property the whole change exists to prove: a worker session (caller
// class 'worker', not 'agent') gets ask_owner — including the SAME
// onGatedInvoke blocking behaviour the conductor's write tools get — while
// still being denied create_task/delete_task/set_task_status outright. Denied
// means "never registered as a tool at all" (registerCapabilityTools skips
// unauthorized capabilities — see projections/mcp.ts's module doc), which
// this asserts directly by checking the tool is undefined, not merely absent
// from a name list (belt-and-suspenders against the earlier list-based checks
// being weakened independently of this one).
describe('createOctomuxMcpServer — worker ask_owner vs. destructive tools', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv['OCTOMUX_TASK_ID'] = process.env.OCTOMUX_TASK_ID;
    savedEnv['OCTOMUX_ACTION_TOKEN'] = process.env.OCTOMUX_ACTION_TOKEN;
    savedEnv['OCTOMUX_ACTION_BASE_URL'] = process.env.OCTOMUX_ACTION_BASE_URL;
    savedEnv['OCTOMUX_CONVERSATION_ID'] = process.env.OCTOMUX_CONVERSATION_ID;
    savedEnv['OCTOMUX_CAPABILITY_GATE_ENABLED'] = process.env.OCTOMUX_CAPABILITY_GATE_ENABLED;

    process.env.OCTOMUX_TASK_ID = 'task-worker-ask';
    process.env.OCTOMUX_ACTION_TOKEN = 'tok-worker';
    process.env.OCTOMUX_ACTION_BASE_URL = 'http://127.0.0.1:7777';
    delete process.env.OCTOMUX_CONVERSATION_ID; // workers never have this
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

  it('a worker session gets ask_owner, and it hits onGatedInvoke (blocks) instead of the no-op handler', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED (no server listening in this test)')),
    );

    const { createOctomuxMcpServer } = await import('./server.js');
    const server = createOctomuxMcpServer();
    const priv = server as unknown as {
      _registeredTools: Record<string, { handler: (input: unknown, extra: unknown) => unknown }>;
    };
    const tool = priv._registeredTools['ask_owner'];
    expect(tool).toBeDefined();

    const result = (await tool.handler({ question: 'which approach?' }, {})) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };

    // Card creation is attempted (proving the gate ran, not the no-op
    // registry/capabilities/owner.ts handler, which would have returned
    // {answer: null, note: '...gating is disabled...'} instead of an isError).
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/could not create an approval card/);
  });

  it('a worker session never gets create_task, delete_task, or set_task_status as tools at all', async () => {
    const { createOctomuxMcpServer } = await import('./server.js');
    const server = createOctomuxMcpServer();
    const priv = server as unknown as { _registeredTools: Record<string, unknown> };

    expect(priv._registeredTools['create_task']).toBeUndefined();
    expect(priv._registeredTools['delete_task']).toBeUndefined();
    expect(priv._registeredTools['set_task_status']).toBeUndefined();
  });
});
