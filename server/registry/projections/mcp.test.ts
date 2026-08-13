import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { defineCapability, resetRegistry } from '../index.js';
import type { Capability, CallerClass, PolicyTier } from '../types.js';
import { registerCapabilityTools } from './mcp.js';

function cap(over: Partial<Capability> = {}): Capability {
  return {
    id: 'task.create',
    summary: 'Create a task',
    mcp: 'create_task',
    tier: 'ask',
    callers: ['ui', 'human', 'agent'],
    input: z.object({ title: z.string() }),
    handler: () => ({ ok: true }),
    ...over,
  } as Capability;
}

function newServer(): McpServer {
  return new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
}

// The MCP SDK stores registered tools in a private `_registeredTools` plain
// object keyed by name, each holding `description`, `inputSchema`, and
// `handler` (the wrapped callback). Implementation detail, but stable — the
// same pattern is already used in orchestrator/mcp/server.test.ts.
interface RegisteredTool {
  description?: string;
  inputSchema?: unknown;
  handler: (input: unknown, extra: unknown) => unknown;
}

function registeredTools(server: McpServer): Record<string, RegisteredTool> {
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
}

beforeEach(resetRegistry);

describe('registerCapabilityTools', () => {
  it('registers a capability that has an explicit mcp name', () => {
    defineCapability(cap());
    const server = newServer();
    registerCapabilityTools(server, { caller: 'agent' });
    expect(Object.keys(registeredTools(server))).toEqual(['create_task']);
  });

  it('never registers a capability that lacks an explicit mcp name', () => {
    defineCapability(cap({ id: 'task.list', mcp: undefined, cli: 'task list' }));
    const server = newServer();
    registerCapabilityTools(server, { caller: 'agent' });
    expect(registeredTools(server)).toEqual({});
  });

  it.each<[string, CallerClass[], CallerClass, boolean]>([
    ['caller is in the callers list', ['ui', 'human', 'agent'], 'agent', true],
    ['caller is missing from the callers list', ['ui', 'human'], 'agent', false],
    ['ui excluded from an agent-only capability', ['agent'], 'ui', false],
  ])('%s → registered=%s', (_label, callers, caller, expected) => {
    defineCapability(cap({ callers }));
    const server = newServer();
    registerCapabilityTools(server, { caller });
    expect('create_task' in registeredTools(server)).toBe(expected);
  });

  // Unavailable tools must be invisible, not registered-then-rejected.
  it('does not register a denied capability at all (no entry in the tool map)', () => {
    defineCapability(cap({ callers: ['ui'] }));
    const server = newServer();
    registerCapabilityTools(server, { caller: 'agent' });
    expect(registeredTools(server)).toEqual({});
  });

  it.each<PolicyTier>(['auto', 'ask', 'always-ask'])(
    "registers a '%s' tier capability — the tier gates invocation, not visibility",
    (tier) => {
      defineCapability(cap({ tier }));
      const server = newServer();
      registerCapabilityTools(server, { caller: 'agent' });
      expect(registeredTools(server)).toHaveProperty('create_task');
    },
  );

  it('uses cap.summary as the description and cap.input as the schema', () => {
    const input = z.object({ title: z.string() });
    defineCapability(cap({ summary: 'does the thing', input }));
    const server = newServer();
    registerCapabilityTools(server, { caller: 'agent' });
    const tool = registeredTools(server)['create_task'];
    expect(tool.description).toBe('does the thing');
    expect(tool.inputSchema).toBe(input);
  });

  it('calls cap.handler with the input and a context carrying the caller', async () => {
    const handler = vi.fn((input: unknown) => ({ echoed: input }));
    defineCapability(cap({ handler }));
    const server = newServer();
    registerCapabilityTools(server, { caller: 'agent' });
    const tool = registeredTools(server)['create_task'];

    const result = await tool.handler({ title: 'T' }, {});

    expect(handler).toHaveBeenCalledWith({ title: 'T' }, { caller: 'agent' });
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ echoed: { title: 'T' } }, null, 2) }],
    });
  });

  it.each<[string, Capability['handler']]>([
    [
      'sync throw',
      () => {
        throw new Error('boom');
      },
    ],
    [
      'rejected promise',
      async () => {
        throw new Error('boom');
      },
    ],
  ])('returns isError content when the handler fails (%s)', async (_label, handler) => {
    defineCapability(cap({ handler }));
    const server = newServer();
    registerCapabilityTools(server, { caller: 'agent' });
    const tool = registeredTools(server)['create_task'];

    const result = await tool.handler({}, {});

    expect(result).toEqual({
      content: [{ type: 'text', text: 'create_task failed: boom' }],
      isError: true,
    });
  });

  describe('onGatedInvoke extension point', () => {
    it('runs before the handler when the resolved tier is not auto', async () => {
      const order: string[] = [];
      const onGatedInvoke = vi.fn(async () => {
        order.push('gate');
      });
      const handler = vi.fn(() => {
        order.push('handler');
        return { ok: true };
      });
      defineCapability(cap({ tier: 'ask', handler }));
      const server = newServer();
      registerCapabilityTools(server, { caller: 'agent', onGatedInvoke });
      const tool = registeredTools(server)['create_task'];

      await tool.handler({}, {});

      expect(onGatedInvoke).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'task.create' }),
        'ask',
        {},
      );
      expect(order).toEqual(['gate', 'handler']);
    });

    it('does not run for an auto tier capability', async () => {
      const onGatedInvoke = vi.fn();
      defineCapability(cap({ tier: 'auto' }));
      const server = newServer();
      registerCapabilityTools(server, { caller: 'agent', onGatedInvoke });
      const tool = registeredTools(server)['create_task'];

      await tool.handler({}, {});

      expect(onGatedInvoke).not.toHaveBeenCalled();
    });

    it('does not run for a human caller even on an always-ask capability (resolves to auto)', async () => {
      const onGatedInvoke = vi.fn();
      defineCapability(cap({ tier: 'always-ask' }));
      const server = newServer();
      registerCapabilityTools(server, { caller: 'human', onGatedInvoke });
      const tool = registeredTools(server)['create_task'];

      await tool.handler({}, {});

      expect(onGatedInvoke).not.toHaveBeenCalled();
    });
  });
});
