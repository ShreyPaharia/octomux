import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import type { Express, Request } from 'express';
import request from 'supertest';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { mountCapabilities, mergeInput, resolveCallerFromRequest } from './http.js';
import { CLIENT_CLASS_HEADER } from '@octomux/api-client';
import { defineCapability, resetRegistry } from '../index.js';
import type { Capability, CallerClass } from '../index.js';
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

  // Positive identification of the two non-agent classes, via the header
  // @octomux/api-client sets. Without this the dashboard's own calls resolve
  // to 'agent' and the gate applies to the UI.
  it.each<[string, Record<string, unknown>, CallerClass]>([
    ['ui header', { [CLIENT_CLASS_HEADER.toLowerCase()]: 'ui' }, 'ui'],
    ['cli header', { [CLIENT_CLASS_HEADER.toLowerCase()]: 'cli' }, 'human'],
    ['unrecognised header value', { [CLIENT_CLASS_HEADER.toLowerCase()]: 'nonsense' }, 'agent'],
    ['no header', {}, 'agent'],
  ])('resolves %s to %s', (_label, headers, expected) => {
    expect(resolveCallerFromRequest({ headers, query: {} } as unknown as Request)).toBe(expected);
  });

  // An agent token must win: a compromised or copy-pasted client header must
  // never let agent traffic present itself as the dashboard.
  it('prefers the agent token over a ui client header', () => {
    const task = insertTestTask();
    insertAgent(db, { task_id: task.id, hook_token: 'tok-valid' });
    const req = {
      headers: {
        authorization: 'Bearer tok-valid',
        [CLIENT_CLASS_HEADER.toLowerCase()]: 'ui',
      },
      query: {},
    } as unknown as Request;
    expect(resolveCallerFromRequest(req)).toBe('agent');
  });
});

describe('mountCapabilities — auth: bearer-hook-token', () => {
  // Proves the generic mechanism (independent of any real capability):
  // mountCapabilities must apply requireBearerHookToken BEFORE the handler
  // for any capability declaring `http.auth: 'bearer-hook-token'`, so a
  // request that never proves it holds a live agent token never reaches
  // caller resolution or the handler at all — the exact regression a
  // capability's `callers: ['agent']` combined with resolveCaller's
  // fail-closed default would otherwise silently permit (see the comments in
  // ./http.ts's resolveCallerFor and mountCapabilities).
  it.each<[string, string | undefined, number]>([
    ['no Authorization header at all', undefined, 401],
    ['a token that does not match any live agent', 'Bearer tok-wrong', 401],
    ['the correct, live agent token', 'Bearer tok-valid', 200],
  ])('%s -> %d', async (_label, authHeader, expectedStatus) => {
    const task = insertTestTask();
    insertAgent(db, { task_id: task.id, hook_token: 'tok-valid' });
    defineCapability(
      cap({
        id: 'thing.bearer',
        http: { method: 'get', path: '/api/bearer-thing', auth: 'bearer-hook-token' },
        callers: ['agent'],
      }),
    );
    const app = appWithRegistry();
    let req = request(app).get('/api/bearer-thing');
    if (authHeader) req = req.set('Authorization', authHeader);
    const res = await req;
    expect(res.status).toBe(expectedStatus);
  });

  // Requirement 3 (resolveCaller precision): once the bearer gate has passed,
  // the caller must resolve to 'agent' from the verified token alone — never
  // re-derived from (and therefore never overridable by) a spoofable header
  // like the UI client-class header.
  it('resolves caller to agent from the verified token, ignoring a spoofed UI client-class header', async () => {
    const task = insertTestTask();
    insertAgent(db, { task_id: task.id, hook_token: 'tok-valid' });
    defineCapability(
      cap({
        id: 'thing.bearer.whoami',
        http: { method: 'get', path: '/api/bearer-whoami', auth: 'bearer-hook-token' },
        callers: ['agent'],
        handler: (_input, ctx) => ({ caller: ctx.caller }),
      }),
    );
    const app = appWithRegistry();
    const res = await request(app)
      .get('/api/bearer-whoami')
      .set('Authorization', 'Bearer tok-valid')
      .set(CLIENT_CLASS_HEADER, 'ui');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ caller: 'agent' });
  });
});

describe('mountCapabilities — success status codes', () => {
  // Behaviour preservation: the routes these capabilities replace answer 201 on
  // create and 204 on delete. Defaulting everything to 200 would silently
  // change the contract for existing clients.
  it.each<[string, number | undefined, number, unknown]>([
    ['defaults to 200 with a body', undefined, 200, { ok: true }],
    ['honours 201 with a body', 201, 201, { ok: true }],
    ['honours 204 and sends no body', 204, 204, {}],
  ])('%s', async (_label, status, expectedStatus, expectedBody) => {
    defineCapability(
      cap({
        http: status
          ? { method: 'post', path: '/api/things', status }
          : { method: 'post', path: '/api/things' },
        input: z.object({}),
        handler: () => ({ ok: true }),
      }),
    );

    const app = express();
    app.use(express.json());
    const router = express.Router();
    mountCapabilities(router);
    app.use(router);
    app.use(errorMiddleware);

    const res = await request(app).post('/api/things').send({});
    expect(res.status).toBe(expectedStatus);
    expect(res.body).toEqual(expectedBody);
  });
});
