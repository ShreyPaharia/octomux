/**
 * Behavioural regression guard for THE BOOT-ORDER CONTRACT
 * (plans/2026-08-16-plugin-ecosystem.md): a plugin workflow's `apiRouter`
 * must be registered via `ctx.workflows.register()` (server/plugins/context.ts)
 * BEFORE `createApp()` runs, because `server/api.ts`'s `setupRoutes()` — which
 * `createApp()` calls synchronously — iterates `listWorkflows()` exactly once
 * (server/api.ts:47) and snapshots which workflow routers get mounted at that
 * instant. There is no second window.
 *
 * `server/index.test.ts` used to assert this by grepping index.ts's own
 * source text for statement order, which is both blind (a refactor that
 * preserves order but hoists `createApp()` early still passes) and brittle (a
 * behaviour-preserving rename fails it). This test exercises the real
 * invariant end to end through supertest, with no source-text inspection and
 * no mocks: register a plugin workflow's router, then assert whether it
 * actually answers a request — before `createApp()` it does, after it it
 * 404s forever.
 */
import { describe, it, expect } from '../bun-test.js';
import express from 'express';
import request from 'supertest';
import { createApp } from '../app.js';
import { createPluginContext } from './context.js';

describe('plugin workflow apiRouter mounting order', () => {
  it('registering BEFORE createApp() mounts the router — the contract-compliant order', async () => {
    const router = express.Router();
    router.get('/api/__test_boot_before__', (_req, res) => res.status(200).json({ ok: true }));

    const ctx = createPluginContext('boot-before-plugin');
    ctx.workflows.register({
      kind: 'before',
      displayName: 'Before',
      surfaces: ['feed'],
      apiRouter: router,
    });

    const app = createApp();
    const res = await request(app).get('/api/__test_boot_before__');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('registering AFTER createApp() never mounts the router — the forbidden order', async () => {
    const app = createApp();

    const router = express.Router();
    router.get('/api/__test_boot_after__', (_req, res) => res.status(200).json({ ok: true }));

    const ctx = createPluginContext('boot-after-plugin');
    ctx.workflows.register({
      kind: 'after',
      displayName: 'After',
      surfaces: ['feed'],
      apiRouter: router,
    });

    const res = await request(app).get('/api/__test_boot_after__');

    expect(res.status).toBe(404);
  });
});
