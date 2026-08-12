import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  defineCapability,
  exemptRoute,
  authorize,
  resolveCaller,
  findUndeclaredRoutes,
  listMcpCapabilities,
  listCliCapabilities,
  resetRegistry,
} from './index.js';
import type { Capability, CallerClass, PolicyTier } from './types.js';

function cap(over: Partial<Capability> = {}): Capability {
  return {
    id: 'task.create',
    summary: 'Create a task',
    tier: 'ask',
    callers: ['ui', 'human', 'agent'],
    input: z.object({}),
    handler: () => ({ ok: true }),
    ...over,
  } as Capability;
}

beforeEach(resetRegistry);

describe('defineCapability', () => {
  it('rejects a duplicate id', () => {
    defineCapability(cap());
    expect(() => defineCapability(cap())).toThrow(/duplicate capability id/);
  });

  it('rejects a duplicate MCP tool name across different ids', () => {
    defineCapability(cap({ id: 'task.create', mcp: 'create_task' }));
    expect(() => defineCapability(cap({ id: 'task.spawn', mcp: 'create_task' }))).toThrow(
      /duplicate MCP tool name/,
    );
  });

  it('rejects a duplicate CLI command across different ids', () => {
    defineCapability(cap({ id: 'task.create', cli: 'task create' }));
    expect(() => defineCapability(cap({ id: 'task.spawn', cli: 'task create' }))).toThrow(
      /duplicate CLI command/,
    );
  });

  it('rejects a duplicate route across different ids', () => {
    defineCapability(cap({ id: 'task.create', http: { method: 'post', path: '/api/tasks' } }));
    expect(() =>
      defineCapability(cap({ id: 'task.spawn', http: { method: 'post', path: '/api/tasks' } })),
    ).toThrow(/duplicate route POST \/api\/tasks/);
  });

  it('allows the same path with a different method', () => {
    defineCapability(cap({ id: 'task.list', http: { method: 'get', path: '/api/tasks' } }));
    expect(() =>
      defineCapability(cap({ id: 'task.create', http: { method: 'post', path: '/api/tasks' } })),
    ).not.toThrow();
  });
});

describe('authorize', () => {
  // The whole point of caller identity: the declared tier binds agents only.
  it.each<[CallerClass, PolicyTier, PolicyTier]>([
    ['agent', 'auto', 'auto'],
    ['agent', 'ask', 'ask'],
    ['agent', 'always-ask', 'always-ask'],
    ['ui', 'always-ask', 'auto'],
    ['human', 'ask', 'auto'],
  ])('caller %s on a %s capability resolves to tier %s', (caller, tier, expected) => {
    const result = authorize(cap({ tier }), caller);
    expect(result).toEqual({ allowed: true, tier: expected });
  });

  it('denies a caller class the capability does not list', () => {
    const result = authorize(cap({ callers: ['ui'] }), 'agent');
    expect(result).toEqual({
      allowed: false,
      reason: 'task.create is not available to agent callers',
    });
  });
});

describe('resolveCaller', () => {
  // FAIL-CLOSED. A wrong `agent` verdict costs a prompt; a wrong `ui` verdict
  // ungates an autonomous agent.
  it.each<[string, Parameters<typeof resolveCaller>[0], CallerClass]>([
    ['nothing known', {}, 'agent'],
    ['dashboard session', { isDashboard: true }, 'ui'],
    ['interactive terminal', { isInteractiveCli: true }, 'human'],
    ['agent token', { isAgentToken: true }, 'agent'],
    ['agent token wins over dashboard', { isAgentToken: true, isDashboard: true }, 'agent'],
  ])('%s → %s', (_label, opts, expected) => {
    expect(resolveCaller(opts)).toBe(expected);
  });
});

describe('projection filters', () => {
  it('keeps MCP narrower than CLI', () => {
    defineCapability(cap({ id: 'task.create', cli: 'task create', mcp: 'create_task' }));
    defineCapability(cap({ id: 'task.delete', cli: 'task delete' })); // CLI-only, no MCP
    expect(listCliCapabilities().map((c) => c.id)).toEqual(['task.create', 'task.delete']);
    expect(listMcpCapabilities().map((c) => c.id)).toEqual(['task.create']);
  });
});

describe('findUndeclaredRoutes', () => {
  it('is empty when every mounted route is a capability or an exemption', () => {
    defineCapability(cap({ http: { method: 'post', path: '/api/tasks' } }));
    exemptRoute({
      method: 'get',
      path: '/api/tasks/:id/diff/*path',
      reason: 'wildcard-path',
      justification: 'Express wildcard; per-file diff body is not a JSON command result',
    });
    expect(
      findUndeclaredRoutes([
        { method: 'post', path: '/api/tasks' },
        { method: 'get', path: '/api/tasks/:id/diff/*path' },
      ]),
    ).toEqual([]);
  });

  it('reports a route that is neither a capability nor an exemption', () => {
    defineCapability(cap({ http: { method: 'post', path: '/api/tasks' } }));
    expect(
      findUndeclaredRoutes([
        { method: 'post', path: '/api/tasks' },
        { method: 'get', path: '/api/browse' },
      ]),
    ).toEqual([{ method: 'get', path: '/api/browse' }]);
  });
});
