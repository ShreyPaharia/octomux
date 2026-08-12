import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Express } from 'express';
import request from 'supertest';
import { Command } from 'commander';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import {
  installCapabilities,
  mountCapabilityRoutes,
  registerCapabilityMcpTools,
  registerCapabilityCli,
  resetInstalled,
} from './mount.js';
import { defineCapability, resetRegistry } from './index.js';
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

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  resetRegistry();
  resetInstalled();
});

afterEach(() => {
  db.close();
});

describe('installCapabilities', () => {
  it('does not throw when called twice (idempotent)', async () => {
    await installCapabilities();
    await expect(installCapabilities()).resolves.toBeUndefined();
  });

  it('does not throw when the concurrently-written capability/exemption modules are absent', async () => {
    // server/registry/capabilities/task.ts and server/registry/exemptions.ts
    // may not exist yet — installCapabilities must degrade gracefully rather
    // than reject.
    await expect(installCapabilities()).resolves.toBeUndefined();
  });
});

describe('mountCapabilityRoutes', () => {
  function appWithRegistry(): Express {
    const app = express();
    app.use(express.json());
    return app;
  }

  it('is safe to call with zero capabilities registered', async () => {
    const app = appWithRegistry();
    await expect(mountCapabilityRoutes(app)).resolves.toBeUndefined();
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
    await mountCapabilityRoutes(app);
    app.use(errorMiddleware);

    const res = await request(app).get('/api/things/abc');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'abc' });
  });
});

describe('registerCapabilityMcpTools', () => {
  it('is safe to call with zero capabilities registered', async () => {
    const server = newMcpServer();
    await expect(registerCapabilityMcpTools(server, 'agent')).resolves.toBeUndefined();
    expect(registeredToolNames(server)).toEqual([]);
  });

  it('registers a capability defined before mounting as an MCP tool', async () => {
    defineCapability(cap({ mcp: 'get_thing', input: z.object({ id: z.string() }) }));

    const server = newMcpServer();
    await registerCapabilityMcpTools(server, 'agent');

    expect(registeredToolNames(server)).toEqual(['get_thing']);
  });
});

describe('registerCapabilityCli', () => {
  it('is safe to call with zero capabilities registered', async () => {
    const program = buildProgram();
    await expect(registerCapabilityCli(program)).resolves.toBeUndefined();
    expect(program.commands).toEqual([]);
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
    await registerCapabilityCli(program);

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

    await mountCapabilityRoutes(app);
    await registerCapabilityMcpTools(server, 'agent');
    await registerCapabilityCli(program);

    // installCapabilities() ran three times (once per call above) but only
    // installed once — a second run would have re-thrown on any duplicate
    // capability id defined by the (still-hypothetical) task-capabilities
    // module, which it didn't.
    expect(registeredToolNames(server)).toEqual(['get_thing']);
    expect(findCommand(program, 'thing', 'get')).toBeDefined();
  });
});
