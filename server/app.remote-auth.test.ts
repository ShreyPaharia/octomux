import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { sessionCookieValue, COOKIE_NAME } from './remote-auth.js';

describe('app remote-auth integration', () => {
  afterEach(() => {
    delete process.env.OCTOMUX_BIND;
    delete process.env.OCTOMUX_REMOTE_TOKEN;
    delete process.env.OCTOMUX_ALLOWED_HOSTS;
  });

  it('remote mode off: /login still serves and api is open (loopback)', async () => {
    const app = createApp();
    const login = await request(app).get('/login');
    expect(login.status).toBe(200);
  });

  it('login with correct token sets the session cookie', async () => {
    process.env.OCTOMUX_BIND = '0.0.0.0';
    process.env.OCTOMUX_REMOTE_TOKEN = 'tok';
    const app = createApp();
    const res = await request(app).post('/login').type('form').send({ token: 'tok' });
    expect(res.status).toBe(302);
    expect(res.headers['set-cookie'][0]).toContain(`${COOKIE_NAME}=${sessionCookieValue('tok')}`);
    expect(res.headers['set-cookie'][0]).toContain('HttpOnly');
  });

  it('login with wrong token returns 401 and sets no cookie', async () => {
    process.env.OCTOMUX_BIND = '0.0.0.0';
    process.env.OCTOMUX_REMOTE_TOKEN = 'tok';
    const app = createApp();
    const res = await request(app).post('/login').type('form').send({ token: 'nope' });
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('extended host allowlist accepts a configured tailscale host', async () => {
    process.env.OCTOMUX_BIND = '0.0.0.0';
    process.env.OCTOMUX_ALLOWED_HOSTS = 'mybox.tailnet.ts.net';
    process.env.OCTOMUX_REMOTE_TOKEN = 'tok';
    const app = createApp();
    const res = await request(app).get('/login').set('Host', 'mybox.tailnet.ts.net');
    expect(res.status).toBe(200);
  });

  it('disallowed host is rejected with 403', async () => {
    process.env.OCTOMUX_BIND = '0.0.0.0';
    process.env.OCTOMUX_REMOTE_TOKEN = 'tok';
    const app = createApp();
    const res = await request(app).get('/login').set('Host', 'evil.example.com');
    expect(res.status).toBe(403);
  });
});
