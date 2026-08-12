/**
 * server/registry/projections/http.ts
 *
 * HTTP projection generator. Mounts every capability carrying an `http`
 * projection onto an Express router — the REST surface described in
 * docs/superpowers/specs/2026-08-12-surface-consolidation-and-centaur-design.md §5.1.
 */

import type { Router, Request, Response } from 'express';
import { authorize, listHttpCapabilities, resolveCaller } from '../index.js';
import type { Capability, CallerClass } from '../index.js';
import { CLIENT_CLASS_HEADER } from '@octomux/api-client';
import { checkAgentTokenExists } from '../../repositories/workers.js';
import { ServiceError } from '../../services/errors.js';
import { childLogger } from '../../logger.js';

const logger = childLogger('registry/projections/http');

/**
 * Resolve the caller class for an inbound HTTP request.
 *
 * `isAgentToken` mirrors the two agent-token signals already in use elsewhere
 * (`requireBearerHookToken` in server/routes/hook-auth.ts checks an
 * `Authorization: Bearer <token>` header; `requireHookToken` in
 * server/hooks.ts checks a `?token=` query param) — both resolve through the
 * same `checkAgentTokenExists` lookup, so a request is treated as an agent if
 * either carries a token that checks out.
 *
 * ponytail: `isDashboard` / `isInteractiveCli` have no signal at this layer —
 * this generic router has no session-cookie or CLI-user-agent check wired up
 * yet, unlike the two hand-written auth helpers above which only ever see
 * agent traffic. Leaving both unset relies on `resolveCaller`'s fail-closed
 * default (unrecognised → 'agent'), which is safe (an extra approval prompt
 * for real UI/CLI traffic) rather than permissive. Wire a real signal here
 * when a capability route needs to tell a human apart from an agent over
 * plain HTTP.
 */
export function resolveCallerFromRequest(req: Request): CallerClass {
  const bearerMatch = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
  const token = bearerMatch?.[1] ?? queryToken;
  const isAgentToken = Boolean(token && checkAgentTokenExists(token));

  // Positive identification for the two non-agent classes. Without this every
  // request falls through to the fail-closed `agent` default, which would gate
  // the dashboard's own calls — safe, but useless. Set by `createRequestCore`
  // in `@octomux/api-client`, which both the SPA and the CLI go through.
  const clientClass = req.headers[CLIENT_CLASS_HEADER.toLowerCase()];
  const client = Array.isArray(clientClass) ? clientClass[0] : clientClass;

  return resolveCaller({
    isAgentToken,
    isDashboard: client === 'ui',
    isInteractiveCli: client === 'cli',
  });
}

/**
 * Merge the request's sources of input into one object for zod validation.
 * Precedence, highest to lowest: `req.body` > `req.params` > `req.query`.
 * Route params are more specific than the query string, and the body is the
 * caller's explicit payload, so each later spread only fills gaps the more
 * specific source left open.
 */
export function mergeInput(req: Request): Record<string, unknown> {
  return {
    ...(req.query as Record<string, unknown>),
    ...(req.params as Record<string, unknown>),
    ...((req.body as Record<string, unknown> | undefined) ?? {}),
  };
}

function handlerFor(cap: Capability) {
  return async (req: Request, res: Response): Promise<void> => {
    const caller = resolveCallerFromRequest(req);
    const decision = authorize(cap, caller);
    if (!decision.allowed) {
      logger.warn({ capability: cap.id, caller, reason: decision.reason }, 'capability denied');
      throw new ServiceError(decision.reason, 403, { error: decision.reason });
    }

    const parsed = cap.input.safeParse(mergeInput(req));
    if (!parsed.success) {
      logger.warn(
        { capability: cap.id, caller, issues: parsed.error.issues },
        'capability input validation failed',
      );
      throw new ServiceError('Validation failed', 400, {
        error: 'validation_failed',
        issues: parsed.error.issues,
      });
    }

    const result = await cap.handler(parsed.data, { caller });
    res.json(result);
  };
}

/** Register every HTTP-projected capability on `router` at its declared route. */
export function mountCapabilities(router: Router): void {
  for (const cap of listHttpCapabilities()) {
    const { method, path } = cap.http!;
    logger.debug({ capability: cap.id, method, path }, 'mounting capability');
    router[method](path, handlerFor(cap));
  }
}
