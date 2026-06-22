/**
 * server/orchestrator/mcp/server.test.ts
 *
 * Tests for createOctomuxMcpServer — verifies that:
 *  - report_complete is registered ONLY when OCTOMUX_TASK_ID is set (worker mode)
 *  - Conductor write tools are registered ONLY when OCTOMUX_CONVERSATION_ID + base url + token
 *    are set (and OCTOMUX_TASK_ID is NOT set)
 *  - Worker mode (OCTOMUX_TASK_ID) disables conductor write tools
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

vi.mock('../store.js', async () => {
  const actual = await vi.importActual<typeof import('../store.js')>('../store.js');
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
    // Read tools are always registered
    expect(tools).toContain('list_tasks');
    expect(tools).toContain('get_task');
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
    // Worker mode: only report_complete, NOT conductor write tools like create_task
    expect(tools).toContain('report_complete');
    expect(tools).not.toContain('create_task');
    expect(tools).not.toContain('send_message');
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
  });
});
