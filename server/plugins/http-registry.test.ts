/**
 * `server/plugins/http-registry.ts` — the plugin route table.
 *
 * Mounts `createPluginParentRouter()` directly (not the full `createApp()`)
 * at `/api/p`, matching how `server/api.ts` mounts it.
 */
import express from 'express';
import { describe, it, expect, beforeEach, afterEach } from '../bun-test.js';

const { default: request } = await import('supertest');
const {
  registerPluginRoute,
  unregisterPluginRoutes,
  listPluginRoutes,
  createPluginParentRouter,
  resetPluginRoutes,
  freezeCoreHttpRoutes,
  RESERVED_ROUTE_PLUGIN_IDS,
} = await import('./http-registry.js');
const { errorMiddleware } = await import('../error-middleware.js');
const { badRequest } = await import('../services/errors.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/p', createPluginParentRouter());
  app.use(errorMiddleware);
  return app;
}

describe('http-registry', () => {
  beforeEach(() => {
    resetPluginRoutes();
  });

  afterEach(() => {
    resetPluginRoutes();
  });

  it('serves a registered GET route with params populated', async () => {
    registerPluginRoute('coverage-bot', 'GET', '/coverage/:task', (req, res) => {
      res.status(200).json({ task: req.params.task, query: req.query });
    });

    const app = makeApp();
    const res = await request(app).get('/api/p/coverage-bot/coverage/task-1?foo=bar');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ task: 'task-1', query: { foo: 'bar' } });
  });

  it('serves a registered POST route with the JSON body', async () => {
    registerPluginRoute('coverage-bot', 'POST', '/coverage', (req, res) => {
      res.status(201).json({ received: req.body });
    });

    const app = makeApp();
    const res = await request(app).post('/api/p/coverage-bot/coverage').send({ pct: 92 });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ received: { pct: 92 } });
  });

  it('supports an async handler', async () => {
    registerPluginRoute('async-plugin', 'GET', '/slow', async (req, res) => {
      await Promise.resolve();
      res.status(200).json({ ok: true });
    });

    const app = makeApp();
    const res = await request(app).get('/api/p/async-plugin/slow');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('404s a path with no matching row', async () => {
    registerPluginRoute('coverage-bot', 'GET', '/coverage/:task', (_req, res) => {
      res.status(200).json({});
    });

    const app = makeApp();
    const res = await request(app).get('/api/p/coverage-bot/no-such-path');

    expect(res.status).toBe(404);
  });

  it('404s an unknown plugin id', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/p/no-such-plugin/anything');

    expect(res.status).toBe(404);
  });

  it('404s the right method mismatch (GET registered, POST requested)', async () => {
    registerPluginRoute('coverage-bot', 'GET', '/coverage', (_req, res) => {
      res.status(200).json({});
    });

    const app = makeApp();
    const res = await request(app).post('/api/p/coverage-bot/coverage');

    expect(res.status).toBe(404);
  });

  it('throws on a duplicate METHOD+path registration for the same plugin', () => {
    registerPluginRoute('coverage-bot', 'GET', '/coverage', () => {});
    expect(() => registerPluginRoute('coverage-bot', 'GET', '/coverage', () => {})).toThrow();
  });

  it('allows the same METHOD+path across two different plugins', () => {
    registerPluginRoute('plugin-a', 'GET', '/thing', () => {});
    expect(() => registerPluginRoute('plugin-b', 'GET', '/thing', () => {})).not.toThrow();
  });

  it('routes a thrown ServiceError through the shared error middleware', async () => {
    registerPluginRoute('coverage-bot', 'GET', '/boom', () => {
      throw badRequest('nope');
    });

    const app = makeApp();
    const res = await request(app).get('/api/p/coverage-bot/boom');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'nope' });
  });

  it('routes a rejected async handler through the shared error middleware', async () => {
    registerPluginRoute('coverage-bot', 'GET', '/boom-async', async () => {
      throw new Error('async boom');
    });

    const app = makeApp();
    const res = await request(app).get('/api/p/coverage-bot/boom-async');

    expect(res.status).toBe(500);
  });

  it('unregisterPluginRoutes drops every route for that plugin and 404s afterward', async () => {
    registerPluginRoute('coverage-bot', 'GET', '/coverage', (_req, res) => {
      res.status(200).json({ ok: true });
    });

    unregisterPluginRoutes('coverage-bot');

    const app = makeApp();
    const res = await request(app).get('/api/p/coverage-bot/coverage');
    expect(res.status).toBe(404);
  });

  it('unregisterPluginRoutes is a no-op for a plugin that registered nothing', () => {
    expect(() => unregisterPluginRoutes('never-registered')).not.toThrow();
  });

  it('listPluginRoutes reports "METHOD /path" entries in registration order', () => {
    registerPluginRoute('plugin-a', 'GET', '/one', () => {});
    registerPluginRoute('plugin-a', 'POST', '/two', () => {});
    registerPluginRoute('plugin-b', 'GET', '/one', () => {});

    expect(listPluginRoutes('plugin-a')).toEqual(['GET /one', 'POST /two']);
    expect(listPluginRoutes('plugin-b')).toEqual(['GET /one']);
  });

  it('listPluginRoutes returns empty for a plugin that registered nothing', () => {
    expect(listPluginRoutes('never-registered')).toEqual([]);
  });

  it('listPluginRoutes is empty for a plugin after its routes are unregistered', () => {
    registerPluginRoute('plugin-a', 'GET', '/one', () => {});
    unregisterPluginRoutes('plugin-a');

    expect(listPluginRoutes('plugin-a')).toEqual([]);
  });

  // Review finding on SHR-253: decodeURIComponent throws URIError on a
  // malformed percent-sequence, synchronously inside the router middleware and
  // outside the Promise wrapper around the handler. Unguarded, any client could
  // turn a 404 into a 500 plus an error-level log line for free.
  it('404s a malformed percent-sequence in a param instead of 500ing', async () => {
    registerPluginRoute('plugin-a', 'GET', '/coverage/:task', (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const res = await request(makeApp()).get('/api/p/plugin-a/coverage/%ZZ');

    expect(res.status).toBe(404);
  });

  // First match wins with no specificity ranking, unlike express's own router.
  // Pinned so the ordering rule cannot change silently under plugin authors.
  it('dispatches in registration order, so a param route shadows a later literal', async () => {
    registerPluginRoute('plugin-a', 'GET', '/coverage/:task', (_req, res) => {
      res.status(200).json({ matched: 'param' });
    });
    registerPluginRoute('plugin-a', 'GET', '/coverage/latest', (_req, res) => {
      res.status(200).json({ matched: 'literal' });
    });

    const res = await request(makeApp()).get('/api/p/plugin-a/coverage/latest');

    expect(res.body).toEqual({ matched: 'param' });
  });

  it('resetPluginRoutes clears the whole table', () => {
    registerPluginRoute('plugin-a', 'GET', '/one', () => {});
    registerPluginRoute('plugin-b', 'GET', '/two', () => {});

    resetPluginRoutes();

    expect(listPluginRoutes('plugin-a')).toEqual([]);
    expect(listPluginRoutes('plugin-b')).toEqual([]);
  });

  // Finding 2: a plugin manifest claiming a reserved id (e.g. `pr-extract`)
  // must not be able to add its own routes into core's bucket, and must not
  // be able to take core's routes down on unmount.
  describe('reserved route plugin ids', () => {
    const reservedId = RESERVED_ROUTE_PLUGIN_IDS[0];

    it('a plugin cannot claim a reserved id once frozen', () => {
      registerPluginRoute(reservedId, 'GET', '/core-route', () => {});
      freezeCoreHttpRoutes();

      registerPluginRoute(reservedId, 'GET', '/attacker-route', () => {});

      expect(listPluginRoutes(reservedId)).toEqual(['GET /core-route']);
    });

    it("a reserved id's routes survive an unregister attempt", async () => {
      registerPluginRoute(reservedId, 'GET', '/core-route', (_req, res) => {
        res.status(200).json({ ok: true });
      });
      freezeCoreHttpRoutes();

      unregisterPluginRoutes(reservedId);

      expect(listPluginRoutes(reservedId)).toEqual(['GET /core-route']);
      const res = await request(makeApp()).get(`/api/p/${reservedId}/core-route`);
      expect(res.status).toBe(200);
    });
  });
});
