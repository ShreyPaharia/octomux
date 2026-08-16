import { afterEach, beforeEach, describe, expect, it } from '../bun-test.js';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { Command } from 'commander';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type Database from '../sqlite.js';
import {
  installCapabilities,
  mountCapabilityRoutes,
  registerCapabilityMcpTools,
  registerCapabilityCli,
  resetInstalled,
} from './mount.js';
import { defineCapability, resetRegistry, listCapabilities, listExemptions } from './index.js';
import type { Capability } from './types.js';
import { errorMiddleware } from '../error-middleware.js';
import { createTestDb } from '../test-helpers.js';

function cap(over: Partial<Capability> = {}): Capability {
  return {
    id: 'thing.get',
    summary: 'Test capability',
    tier: 'auto',
    callers: ['ui', 'human', 'agent'],
    input: z.object({}),
    handler: () => ({ ok: true }),
    ...over,
  } as Capability;
}

function newMcpServer(): McpServer {
  return new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
}

// Mirrors server/registry/projections/mcp.test.ts's helper for reading the
// MCP SDK's private tool map.
function registeredToolNames(server: McpServer): string[] {
  return Object.keys(
    (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
  );
}

/** Mirrors server/registry/projections/cli.test.ts's fresh-program builder. */
function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  return program;
}

function findCommand(program: Command, ...path: string[]): Command | undefined {
  let current: Command | undefined = program;
  for (const part of path) {
    current = current?.commands.find((c) => c.name() === part);
    if (!current) return undefined;
  }
  return current;
}

let db: Database;

beforeEach(() => {
  db = createTestDb();
  resetRegistry();
  resetInstalled();
});

afterEach(() => {
  db.close();
});

describe('installCapabilities', () => {
  it('does not throw when called twice (idempotent)', () => {
    installCapabilities();
    expect(() => installCapabilities()).not.toThrow();
  });

  it('registers the real capability and exemption modules', () => {
    installCapabilities();
    // Static imports, so this is the actual production set — not a stub.
    expect(listCapabilities().map((c) => c.id)).toContain('task.create');
    expect(listExemptions().length).toBeGreaterThan(0);
  });

  it('registers each capability exactly once across repeated calls', () => {
    installCapabilities();
    const first = listCapabilities().length;
    installCapabilities();
    expect(listCapabilities()).toHaveLength(first);
  });
});

describe('mountCapabilityRoutes', () => {
  function appWithRegistry(): Express {
    const app = express();
    app.use(express.json());
    return app;
  }

  it('mounts without throwing when nothing extra is registered', () => {
    const app = appWithRegistry();
    expect(() => mountCapabilityRoutes(app)).not.toThrow();
  });

  it('mounts a capability defined before mounting, reachable over HTTP', async () => {
    defineCapability(
      cap({
        http: { method: 'get', path: '/api/things/:id' },
        input: z.object({ id: z.string() }),
        handler: (input) => ({ id: (input as { id: string }).id }),
      }),
    );

    const app = appWithRegistry();
    mountCapabilityRoutes(app);
    app.use(errorMiddleware);

    const res = await request(app).get('/api/things/abc');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'abc' });
  });
});

describe('registerCapabilityMcpTools', () => {
  it('registers without throwing when nothing extra is registered', () => {
    const server = newMcpServer();
    expect(() => registerCapabilityMcpTools(server, 'agent')).not.toThrow();
  });

  it('registers a capability defined before mounting as an MCP tool', () => {
    defineCapability(cap({ mcp: 'get_thing', input: z.object({ id: z.string() }) }));

    const server = newMcpServer();
    registerCapabilityMcpTools(server, 'agent');

    // Superset, not equality: installCapabilities() also registers the real
    // task capabilities, and asserting equality would couple this test to
    // whichever nouns happen to be migrated.
    expect(registeredToolNames(server)).toContain('get_thing');
  });
});

describe('registerCapabilityCli', () => {
  it('registers without throwing when nothing extra is registered', () => {
    const program = buildProgram();
    expect(() => registerCapabilityCli(program)).not.toThrow();
  });

  it('registers a capability defined before mounting as a commander subcommand', async () => {
    defineCapability(
      cap({
        cli: 'thing get',
        http: { method: 'get', path: '/api/things/:id' },
        input: z.object({ id: z.string().describe('Thing id') }),
      }),
    );

    const program = buildProgram();
    registerCapabilityCli(program);

    expect(findCommand(program, 'thing', 'get')).toBeDefined();
  });
});

describe('cross-transport idempotency', () => {
  it('calling all three wiring functions in sequence does not throw duplicate-registration errors', async () => {
    defineCapability(
      cap({
        cli: 'thing get',
        mcp: 'get_thing',
        http: { method: 'get', path: '/api/things/:id' },
        input: z.object({ id: z.string() }),
      }),
    );

    const app = express();
    app.use(express.json());
    const server = newMcpServer();
    const program = buildProgram();

    mountCapabilityRoutes(app);
    registerCapabilityMcpTools(server, 'agent');
    registerCapabilityCli(program);

    // installCapabilities() ran three times but installed once — a second run
    // would have thrown on the duplicate ids the real task-capabilities module
    // defines.
    expect(registeredToolNames(server)).toContain('get_thing');
    expect(findCommand(program, 'thing', 'get')).toBeDefined();
  });
});
