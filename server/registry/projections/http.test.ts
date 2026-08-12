import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import type { Express, Request } from 'express';
import request from 'supertest';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { mountCapabilities, mergeInput, resolveCallerFromRequest } from './http.js';
import { defineCapability, resetRegistry } from '../index.js';
import type { Capability } from '../index.js';
import { errorMiddleware } from '../../error-middleware.js';
import { createTestDb, insertAgent, insertTestTask } from '../../test-helpers.js';

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

function appWithRegistry(): Express {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  mountCapabilities(router);
  app.use(router);
  app.use(errorMiddleware);
  return app;
}

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  resetRegistry();
});

describe('mountCapabilities', () => {
  it.each<[string, 'get' | 'post']>([
    ['get', 'get'],
    ['post', 'post'],
  ])(
    'mounts a %s capability at its declared method/path and returns the handler result',
    async (_label, method) => {
      defineCapability(
        cap({
          id: `thing.${method}`,
          http: { method, path: '/api/things/:id' },
          input: z.object({ id: z.string() }),
          handler: (input) => ({ id: (input as { id: string }).id }),
        }),
      );
      const app = appWithRegistry();
      const res = await request(app)[method]('/api/things/abc');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: 'abc' });
    },
  );

  it('passes the resolved caller into the capability handler via ctx', async () => {
    defineCapability(
      cap({
        id: 'thing.whoami',
        http: { method: 'get', path: '/api/whoami' },
        handler: (_input, ctx) => ({ caller: ctx.caller }),
      }),
    );
    const app = appWithRegistry();
    const res = await request(app).get('/api/whoami');
    expect(res.status).toBe(200);
    // No dashboard/CLI signal exists at this layer yet, so unrecognised
    // traffic fails closed to 'agent' — see the ponytail comment in http.ts.
    expect(res.body).toEqual({ caller: 'agent' });
  });

  it('returns 403 with the authorize() reason when the caller class is not permitted', async () => {
    defineCapability(
      cap({
        id: 'thing.uionly',
        http: { method: 'get', path: '/api/ui-only' },
        callers: ['ui'],
      }),
    );
    const app = appWithRegistry();
    const res = await request(app).get('/api/ui-only');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'thing.uionly is not available to agent callers',
    });
  });

  it('returns 400 with the zod issues when input validation fails', async () => {
    defineCapability(
      cap({
        id: 'thing.create',
        http: { method: 'post', path: '/api/things' },
        input: z.object({ name: z.string() }),
      }),
    );
    const app = appWithRegistry();
    const res = await request(app).post('/api/things').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['name'] })]),
    );
  });

  it.each<[string, { query?: string; body?: Record<string, unknown> }, string]>([
    ['query alone flows through when nothing else supplies the key', {}, 'from-path'],
    ['params win over query for the same key', { query: '?id=from-query' }, 'from-path'],
    [
      'body wins over params and query for the same key',
      { query: '?id=from-query', body: { id: 'from-body' } },
      'from-body',
    ],
  ])('input merge: %s', async (_label, { query, body }, expectedId) => {
    defineCapability(
      cap({
        id: 'thing.merge',
        http: { method: 'post', path: '/api/merge/:id' },
        input: z.object({ id: z.string() }),
        handler: (input) => input,
      }),
    );
    const app = appWithRegistry();
    const res = await request(app)
      .post(`/api/merge/from-path${query ?? ''}`)
      .send(body ?? {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: expectedId });
  });
});

describe('mergeInput', () => {
  it('merges query, params and body with body taking precedence', () => {
    const req = {
      query: { a: 'query-a', b: 'query-b' },
      params: { b: 'params-b', c: 'params-c' },
      body: { c: 'body-c' },
    } as unknown as Parameters<typeof mergeInput>[0];
    expect(mergeInput(req)).toEqual({ a: 'query-a', b: 'params-b', c: 'body-c' });
  });
});

describe('resolveCallerFromRequest', () => {
  // Both extraction paths (Bearer header, ?token= query) route through the
  // same checkAgentTokenExists lookup used by requireBearerHookToken
  // (server/routes/hook-auth.ts) and requireHookToken (server/hooks.ts). With
  // no dashboard/CLI signal wired at this layer yet, every case here resolves
  // to 'agent' via resolveCaller's fail-closed default — see the ponytail
  // comment in http.ts. These tests exist to prove token extraction and the
  // DB lookup run without throwing, for both signal shapes and the
  // no-token/unknown-token cases.
  it.each<[string, () => Request]>([
    [
      'a valid Bearer token',
      () => ({ headers: { authorization: 'Bearer tok-valid' }, query: {} }) as unknown as Request,
    ],
    [
      'a valid ?token= query param',
      () => ({ headers: {}, query: { token: 'tok-valid' } }) as unknown as Request,
    ],
    ['no token at all', () => ({ headers: {}, query: {} }) as unknown as Request],
    [
      'a token that does not exist',
      () => ({ headers: { authorization: 'Bearer tok-unknown' }, query: {} }) as unknown as Request,
    ],
  ])('resolves to agent for %s', (_label, buildReq) => {
    const task = insertTestTask();
    insertAgent(db, { task_id: task.id, hook_token: 'tok-valid' });
    expect(resolveCallerFromRequest(buildReq())).toBe('agent');
  });
});
