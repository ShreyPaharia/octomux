import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
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
    ? path.join(os.homedir(), '.octomux', 'data')
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
