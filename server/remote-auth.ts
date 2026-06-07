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
