import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { octomuxRoot } from './octomux-root.js';
import type { IncomingMessage } from 'http';
import type { Request, Response, NextFunction } from 'express';
import { childLogger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = childLogger('remote-auth');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** The interface octomux binds to. Default loopback-only (unchanged behavior). */
export function getBindHost(): string {
  return process.env.OCTOMUX_BIND || '127.0.0.1';
}

/** Remote mode is on when bound to a non-loopback interface. */
export function isRemoteMode(): boolean {
  return !LOOPBACK_HOSTS.has(getBindHost());
}

/** True when a socket's remoteAddress is the local machine. */
export function isLoopbackAddress(addr: string | undefined): boolean {
  return addr !== undefined && LOOPBACK_ADDRS.has(addr);
}

/** Directory mirrors server/db.ts: ~/.octomux/data (prod) or ./data (dev). */
function dataDir(): string {
  return process.env.NODE_ENV === 'production'
    ? path.join(octomuxRoot(), 'data')
    : path.join(__dirname, '..', 'data');
}

export function tokenFilePath(): string {
  return path.join(dataDir(), 'remote-token');
}

/**
 * Resolve the shared remote token. Precedence:
 *   1. OCTOMUX_REMOTE_TOKEN env var
 *   2. existing token file
 *   3. freshly generated 32-byte hex token, persisted at mode 0600
 */
export function ensureToken(): string {
  const fromEnv = process.env.OCTOMUX_REMOTE_TOKEN;
  if (fromEnv && fromEnv !== '') return fromEnv;

  const file = tokenFilePath();
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();

  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token, { mode: 0o600 });
  logger.info({ tokenFile: file }, 'generated new remote-access token');
  return token;
}

export const COOKIE_NAME = 'octomux_session';

/** Constant-time compare of two strings (hashes first to avoid length leaks/throws). */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Derive the session cookie value from the token. The cookie never contains the
 * raw token; only a holder of the token at login time could have obtained it.
 */
export function sessionCookieValue(token: string): string {
  return crypto.createHmac('sha256', token).update('octomux-session-v1').digest('hex');
}

/** True if `provided` equals the real token (constant-time). */
export function validToken(provided: string, token: string): boolean {
  return provided.length > 0 && safeEqual(provided, token);
}

/** True if a presented cookie value matches the derived session value. */
export function validSessionCookie(value: string | undefined, token: string): boolean {
  return value !== undefined && value.length > 0 && safeEqual(value, sessionCookieValue(token));
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

// Harness hook callbacks always originate from loopback (hookBaseUrl() → http://127.0.0.1:<port>)
// so they are already allowed by the isLoopback check above. Listing '/api/hooks' here would
// additionally exempt admin routes like POST /api/hooks/install and GET /api/hooks/registry
// from authentication in remote mode — so it must NOT appear here.
const EXEMPT_PREFIXES = ['/login', '/logout'];

export type AuthDecision = 'allow' | 'redirect' | 'unauthorized';

export function authorizeRequest(input: {
  remoteMode: boolean;
  isLoopback: boolean;
  path: string;
  cookieHeader: string | undefined;
  token: string;
}): AuthDecision {
  const { remoteMode, isLoopback, path: p, cookieHeader, token } = input;
  if (!remoteMode) return 'allow';
  if (isLoopback) return 'allow';
  if (EXEMPT_PREFIXES.some((pre) => p === pre || p.startsWith(pre + '/'))) return 'allow';

  const cookie = parseCookies(cookieHeader)[COOKIE_NAME];
  if (validSessionCookie(cookie, token)) return 'allow';

  return p.startsWith('/api/') ? 'unauthorized' : 'redirect';
}

export function authorizeUpgrade(input: {
  remoteMode: boolean;
  isLoopback: boolean;
  cookieHeader: string | undefined;
  token: string;
}): boolean {
  const { remoteMode, isLoopback, cookieHeader, token } = input;
  if (!remoteMode) return true;
  if (isLoopback) return true;
  return validSessionCookie(parseCookies(cookieHeader)[COOKIE_NAME], token);
}

/** Express middleware: enforce the auth decision. No-op when remote mode is off. */
export function remoteAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const remoteMode = isRemoteMode();
  const decision = authorizeRequest({
    remoteMode,
    isLoopback: isLoopbackAddress(req.socket.remoteAddress),
    path: req.path,
    cookieHeader: req.headers.cookie,
    token: remoteMode ? ensureToken() : '',
  });
  if (decision === 'allow') return next();
  if (decision === 'unauthorized') {
    logger.warn({ ip: req.ip, path: req.path }, 'remote-auth: rejected request');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  res.redirect('/login');
}

/** Wrapper around authorizeUpgrade that reads from a raw IncomingMessage. */
export function isUpgradeAuthorized(req: IncomingMessage): boolean {
  const remoteMode = isRemoteMode();
  const ok = authorizeUpgrade({
    remoteMode,
    isLoopback: isLoopbackAddress(req.socket.remoteAddress),
    cookieHeader: req.headers.cookie,
    token: remoteMode ? ensureToken() : '',
  });
  if (!ok)
    logger.warn({ url: req.url, addr: req.socket.remoteAddress }, 'remote-auth: rejected upgrade');
  return ok;
}

const LOGIN_PAGE = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>octomux login</title>
<body style="font-family:system-ui;max-width:24rem;margin:4rem auto;padding:0 1rem">
<h1>🐙 octomux</h1>
<form method="post" action="/login">
<label>Access token<br><input name="token" type="password" autofocus style="width:100%;padding:.5rem;margin:.5rem 0"></label>
<button type="submit" style="padding:.5rem 1rem">Sign in</button>
</form></body>`;

/** Register /login and /logout. Call BEFORE remoteAuthMiddleware so they stay reachable. */
export function registerAuthRoutes(app: import('express').Express): void {
  app.get('/login', (_req, res) => {
    res.type('html').send(LOGIN_PAGE);
  });
  app.post('/login', (req, res) => {
    // requires express.urlencoded() to be registered in app.ts (the login form posts urlencoded)
    if (!isRemoteMode()) {
      res.redirect('/');
      return;
    }
    const provided = (req.body?.token ?? '') as string;
    const token = ensureToken();
    if (!validToken(provided, token)) {
      res.status(401).type('html').send(LOGIN_PAGE);
      return;
    }
    const value = sessionCookieValue(token);
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`,
    );
    res.redirect('/');
  });
  app.post('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.redirect('/login');
  });
}
