/**
 * server/registry/exemptions.ts
 *
 * Declares every route that genuinely cannot become a capability row —
 * streaming responses, Express wildcard paths, non-JSON bodies, and the
 * harness webhook protocols whose request/response envelopes are dictated
 * by Claude Code / Cursor, not by us.
 *
 * "Genuinely cannot" is the bar: a route only belongs here if forcing it
 * into `{ input: z.ZodType, handler }` would mean inventing a fake
 * abstraction around it. Anything else belongs in
 * `server/registry/route-inventory.test.ts`'s `PENDING_MIGRATION` list
 * instead — a route waiting on a capability, not one exempt from ever
 * having one.
 *
 * Design doc: spec/surface-consolidation-and-centaur.md
 */

import { exemptRoute } from './index.js';

/**
 * Register every route exemption. Called once by
 * `installCapabilities()` (server/registry/mount.ts); safe to call more
 * than once within a single process only because that caller guards on its
 * own `installed` flag — `exemptRoute` itself has no duplicate guard, so a
 * second direct call here would double the list.
 */
export function registerRouteExemptions(): void {
  // ─── Wildcard paths ───────────────────────────────────────────────────────
  //
  // Express 5's `*path` captures an arbitrary number of trailing segments as
  // an array (`req.params.path`). A capability's `input` is a single Zod
  // shape describing named fields, not an open-ended filesystem path
  // fragment — there's no faithful schema to write here that isn't just
  // `z.string()` with the URL-vs-body distinction papered over.

  exemptRoute({
    method: 'get',
    path: '/api/tasks/:id/diff/*path',
    reason: 'wildcard-path',
    justification:
      'The trailing *path segment is an arbitrary repo-relative file path (any depth, any ' +
      'characters valid in a git tree entry) used to fetch a single file’s diff. It is a ' +
      'URL-routing concern, not a capability input field.',
  });

  exemptRoute({
    method: 'post',
    path: '/api/tasks/:id/files/*path/reviewed',
    reason: 'wildcard-path',
    justification:
      'Same *path wildcard as the diff route above, here marking a specific file reviewed. The ' +
      'file identity lives in the URL path, not in a request body a capability schema could ' +
      'validate.',
  });

  exemptRoute({
    method: 'delete',
    path: '/api/tasks/:id/files/*path/reviewed',
    reason: 'wildcard-path',
    justification:
      'Unmarks a file as reviewed — same *path wildcard as the POST variant immediately above.',
  });

  // ─── Binary / non-JSON bodies ─────────────────────────────────────────────

  exemptRoute({
    method: 'get',
    path: '/api/orchestrator/artifact',
    reason: 'binary',
    justification:
      'Response Content-Type depends on the artifact’s file extension (parsed JSON body for ' +
      '.json, text/html for .html, text/markdown for .md) and carries an ETag header the client ' +
      'uses for conditional writes. There is no single JSON result shape to declare.',
  });

  exemptRoute({
    method: 'put',
    path: '/api/orchestrator/artifact',
    reason: 'binary',
    justification:
      'Request body is the raw artifact content in whatever Content-Type the client sent ' +
      '(application/json is re-serialised, anything else written verbatim), gated by an ' +
      'If-Match/ETag conditional-write protocol (428/412/409 responses). Not a fixed-shape ' +
      'JSON command.',
  });

  exemptRoute({
    method: 'get',
    path: '/login',
    reason: 'binary',
    justification:
      'Serves a static HTML login page for remote-mode tailnet auth — not an /api/* JSON ' +
      'endpoint and has no CLI/MCP analogue.',
  });

  exemptRoute({
    method: 'post',
    path: '/login',
    reason: 'binary',
    justification:
      'Accepts an application/x-www-form-urlencoded browser form POST (not JSON), and responds ' +
      'with a 302 redirect + Set-Cookie header rather than a JSON result. The transport IS the ' +
      'browser’s form-submit/cookie mechanism.',
  });

  exemptRoute({
    method: 'post',
    path: '/logout',
    reason: 'binary',
    justification:
      'Clears the session cookie and responds with a 302 redirect — same non-JSON ' +
      'request/response shape as POST /login, and equally not meaningful over CLI/MCP.',
  });

  // ─── Harness webhooks ──────────────────────────────────────────────────────
  //
  // server/hooks.ts, mounted at /api/hooks. Inbound callbacks from the
  // Claude Code / Cursor harness process, authenticated by a per-agent
  // hook_token (query string) rather than caller identity, and required to
  // reply with the exact envelope the harness expects — not something a
  // capability's uniform JSON-result contract can express.
  //
  // 5 of the 8 share one envelope: requireHookToken → resolve session →
  // do the work → empty 200. The other 3 diverge:
  //   - session-start:      inline token check (no requireHookToken), 401 on
  //                         failure, replies `{}` (Cursor's sessionStart
  //                         handler expects a JSON body, not empty 200).
  //   - pre-tool-use:       replies in Claude Code's `hookSpecificOutput`
  //                         allow/deny envelope, not a generic result.
  //   - orchestrator-action: an RPC dispatch (structured `action` + `input`),
  //                         not a lifecycle notification — closer to a
  //                         side-channel command bus than a "hook".

  const HOOK_JUSTIFICATION_COMMON =
    'requireHookToken → resolve agent by harness session id → side effect → empty 200. ' +
    'Authenticated by a per-agent hook_token query param, not caller identity, and the harness ' +
    '(Claude Code / Cursor) dictates both the request shape and that a 200 is all it expects back.';

  exemptRoute({
    method: 'post',
    path: '/api/hooks/user-prompt-submit',
    reason: 'harness-webhook',
    justification: HOOK_JUSTIFICATION_COMMON,
  });

  exemptRoute({
    method: 'post',
    path: '/api/hooks/permission-request',
    reason: 'harness-webhook',
    justification: HOOK_JUSTIFICATION_COMMON,
  });

  exemptRoute({
    method: 'post',
    path: '/api/hooks/post-tool-use',
    reason: 'harness-webhook',
    justification: HOOK_JUSTIFICATION_COMMON,
  });

  exemptRoute({
    method: 'post',
    path: '/api/hooks/stop',
    reason: 'harness-webhook',
    justification: HOOK_JUSTIFICATION_COMMON,
  });

  exemptRoute({
    method: 'post',
    path: '/api/hooks/phase-complete',
    reason: 'harness-webhook',
    justification: HOOK_JUSTIFICATION_COMMON,
  });

  exemptRoute({
    method: 'post',
    path: '/api/hooks/session-start',
    reason: 'harness-webhook',
    justification:
      'Diverges from the other 7 hook routes: checks the ?token= query param inline (no ' +
      'requireHookToken middleware), returns 401 on a missing/invalid token or unmatched agent, ' +
      'and on success replies `200 {}` rather than empty — Cursor’s sessionStart hook ' +
      'expects a JSON body. Binds a harness-issued conversation id to an agent row before any ' +
      'harness_session_id is known.',
  });

  exemptRoute({
    method: 'post',
    path: '/api/hooks/pre-tool-use',
    reason: 'harness-webhook',
    justification:
      'Diverges from the common envelope in its response: always 200, body is Claude Code’s ' +
      '`{ hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason? } }` ' +
      'allow/deny shape, dictated by the harness’s PreToolUse hook contract, not by us.',
  });

  exemptRoute({
    method: 'post',
    path: '/api/hooks/orchestrator-action',
    reason: 'harness-webhook',
    justification:
      'Not a lifecycle notification like the other 7 — it’s an RPC dispatch for the ' +
      'conductor’s MCP write tools (structured `{ action, input }`, results in ' +
      '`{ ok, result | error }`). Grouped with the hooks here because it shares their ' +
      'hook_token auth and mount point, but it’s a command bus, not a webhook envelope; ' +
      'callable today because SHR-142 needed a same-process write path, not because it belongs ' +
      'in this file long-term.',
  });

  exemptRoute({
    method: 'post',
    path: '/api/hooks/gate-card',
    reason: 'harness-webhook',
    justification:
      'Same shape as /api/hooks/orchestrator-action immediately above: an RPC dispatch from the ' +
      'conductor’s MCP subprocess (server/orchestrator/mcp/gate.ts’s onGatedInvoke), not a ' +
      'lifecycle notification. Creates a pending action_cards row and pushes it over the main ' +
      'process’s live WebSocket clients — something the stdio subprocess cannot do itself. ' +
      'Shares the same hook_token auth and mount point as the other 8 hook routes.',
  });
}
