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
import { requireBearerHookToken } from '../../routes/hook-auth.js';
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

/**
 * Resolve the caller for a capability's request, taking the route's own
 * auth (if any) into account.
 *
 * For a capability declaring `auth: 'bearer-hook-token'`, this runs only
 * after `mountCapabilities`'s `requireBearerHookToken` middleware has 401'd
 * every request without a live agent hook token — so reaching here at all is
 * proof of a verified token, and the caller is hard-set to `'agent'`.
 *
 * BE PRECISE ABOUT WHAT THIS LINE DOES AND DOES NOT PROTECT. It is a
 * shortcut, not the security boundary. Deleting it changes NO observable
 * behaviour today, and a mutation test confirms that: `resolveCaller`
 * (server/registry/index.ts) checks `isAgentToken` BEFORE `isDashboard`, so
 * `resolveCallerFromRequest` already returns `'agent'` for any request
 * carrying a valid token, spoofed `X-Client-Class: ui` header or not.
 *
 * The two things that actually enforce the boundary are:
 *  1. the `requireBearerHookToken` middleware, which rejects bad tokens; and
 *  2. `resolveCaller`'s ordering, which makes the token signal outrank the
 *     client-class header.
 * If either is ever changed, THIS LINE WILL NOT SAVE YOU — and conversely,
 * do not delete either one on the belief that this line covers it.
 *
 * What it does buy: it skips re-running the same `checkAgentTokenExists` DB
 * lookup the middleware just did, and it states the intent locally so the
 * verdict cannot drift if `resolveCallerFromRequest` grows new signals.
 */
function resolveCallerFor(cap: Capability, req: Request): CallerClass {
  if (cap.http?.auth === 'bearer-hook-token') return 'agent';
  return resolveCallerFromRequest(req);
}

function handlerFor(cap: Capability) {
  return async (req: Request, res: Response): Promise<void> => {
    const caller = resolveCallerFor(cap, req);
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

    const status = cap.http?.status ?? 200;
    // 204 means "no content" — sending a body would violate the status.
    if (status === 204) {
      res.status(204).send();
      return;
    }
    res.status(status).json(result);
  };
}

/** Register every HTTP-projected capability on `router` at its declared route. */
export function mountCapabilities(router: Router): void {
  for (const cap of listHttpCapabilities()) {
    const { method, path, auth } = cap.http!;
    logger.debug({ capability: cap.id, method, path, auth }, 'mounting capability');
    // requireBearerHookToken (server/routes/hook-auth.ts) is the SAME
    // middleware the hand-written bearer-gated routes use — reused, not
    // reimplemented, so token comparison lives in exactly one place. It runs
    // BEFORE handlerFor, so a missing/invalid token 401s before caller
    // resolution or the handler ever run. See resolveCallerFor's doc comment
    // above for how this interacts with caller resolution.
    if (auth === 'bearer-hook-token') {
      router[method](path, requireBearerHookToken, handlerFor(cap));
    } else {
      router[method](path, handlerFor(cap));
    }
  }
}
