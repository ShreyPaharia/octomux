import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { createTestDb } from './test-helpers.js';
import type { Express } from 'express';

let app: Express;
beforeEach(() => {
  createTestDb();
  app = createApp();
});

describe('security middleware', () => {
  it('rejects requests with non-localhost Host header', async () => {
    const res = await request(app).get('/api/tasks').set('Host', 'evil.example.com');
    expect(res.status).toBe(403);
  });

  it('allows requests with Host: 127.0.0.1', async () => {
    const res = await request(app).get('/api/tasks').set('Host', '127.0.0.1');
    expect(res.status).toBe(200);
  });

  it('allows requests with Host: localhost', async () => {
    const res = await request(app).get('/api/tasks').set('Host', 'localhost');
    expect(res.status).toBe(200);
  });

  it('rejects /api/hooks/* with Origin header', async () => {
    const res = await request(app)
      .post('/api/hooks/stop?token=tok-1')
      .set('Host', '127.0.0.1')
      .set('Origin', 'http://evil.example.com')
      .send({ session_id: 'sess-1' });
    expect(res.status).toBe(403);
  });

  it('allows /api/hooks/* without Origin header', async () => {
    const res = await request(app)
      .post('/api/hooks/stop?token=missing')
      .set('Host', '127.0.0.1')
      .send({ session_id: 'sess-1' });
    // 401 because no valid agent, but NOT 403 — proves CORS check passed.
    expect(res.status).toBe(401);
  });
});
