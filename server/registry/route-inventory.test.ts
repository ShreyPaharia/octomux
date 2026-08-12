/**
 * server/registry/route-inventory.test.ts
 *
 * The drift test: every route mounted on the real, fully-built app must be
 * either a capability, a declared exemption, or a route explicitly listed
 * below as still pending migration. A route that's none of the three is a
 * silent gap — someone added a handler and nobody declared it.
 *
 * `server/registry/capabilities/task.ts` is being written concurrently by
 * another agent and may or may not exist when this runs. This test doesn't
 * assume either way: it asserts every *currently* undeclared route is a
 * member of `PENDING_MIGRATION` (subset, not exact-equality), so it passes
 * whether task.ts capabilities have landed yet or not. As capabilities land
 * and cover routes on this list, `PENDING_MIGRATION` should be trimmed to
 * match — down to empty as migration proceeds — but nothing here forces
 * that trim to happen in the same PR that adds the capability.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { listMountedRoutes } from './route-inventory.js';
import { findUndeclaredRoutes, resetRegistry } from './index.js';
import { installCapabilities, resetInstalled } from './mount.js';

function routeKey(r: { method: string; path: string }): string {
  return `${r.method.toUpperCase()} ${r.path}`;
}

// Gated on NODE_ENV=test in server/api.ts, never mounted in production —
// test-only DB-seeding fixture, not part of the surface this test protects.
const TEST_ONLY_ROUTE = 'POST /api/__test__/seed-review';

/**
 * Routes that are neither a capability nor a declared exemption (as of this
 * writing, with zero task.* capabilities registered) — the hand-written
 * surface still waiting on a capability row. Shrinks to empty as migration
 * proceeds; see the file header for why this is a subset check rather than
 * an exact-equality ratchet.
 */
const PENDING_MIGRATION: string[] = [
  'DELETE /api/agents/:id',
  'DELETE /api/chats/:id',
  'DELETE /api/integrations/:id',
  'DELETE /api/kinds/:kind',
  'DELETE /api/learnings/:id',
  'DELETE /api/schedules/:id',
  'DELETE /api/tasks/:id',
  'DELETE /api/tasks/:id/comments/:cid',
  'DELETE /api/tasks/:id/refs/:integration',
  'DELETE /api/tasks/:id/terminals/:terminalId',
  'DELETE /api/tasks/:id/workers/:agentId',
  'DELETE /api/worktrees/:id',
  'GET /api/agent-roles',
  'GET /api/agent-roles/:name',
  'GET /api/agents',
  'GET /api/agents/:id',
  'GET /api/branches',
  'GET /api/browse',
  'GET /api/chats',
  'GET /api/chats/:id',
  'GET /api/default-branch',
  'GET /api/harnesses',
  'GET /api/health',
  'GET /api/hooks/registry',
  'GET /api/hooks/templates',
  'GET /api/integrations',
  'GET /api/integrations/providers',
  'GET /api/kinds',
  'GET /api/learnings',
  'GET /api/learnings/digest',
  'GET /api/loop-groups',
  'GET /api/loop-groups/:id',
  'GET /api/loops',
  'GET /api/loops/:runId',
  'GET /api/orchestrator/conversations',
  'GET /api/orchestrator/conversations/:id',
  'GET /api/orchestrator/conversations/:id/messages',
  'GET /api/orchestrator/conversations/:id/usage',
  'GET /api/pr-extracts',
  'GET /api/pr-extracts/:id',
  'GET /api/preflight/none-mode',
  'GET /api/recent-repos',
  'GET /api/repo-config',
  'GET /api/repo-configs',
  'GET /api/repos/:repoPath/files',
  'GET /api/repos/:repoPath/files/content',
  'GET /api/repos/:repoPath/learnings',
  'GET /api/reviews',
  'GET /api/reviews/:id',
  'GET /api/runs',
  'GET /api/schedules',
  'GET /api/schedules/:id/export',
  'GET /api/schedules/:id/runs',
  'GET /api/schedules/kinds',
  'GET /api/settings',
  'GET /api/setup/status',
  'GET /api/skills',
  'GET /api/skills/:name',
  'GET /api/tasks',
  'GET /api/tasks/:id',
  'GET /api/tasks/:id/branches',
  'GET /api/tasks/:id/comments',
  'GET /api/tasks/:id/commits',
  'GET /api/tasks/:id/diff',
  'GET /api/tasks/:id/hooks',
  'GET /api/tasks/:id/refs',
  'GET /api/tasks/:id/updates',
  'GET /api/tasks/inbox',
  'GET /api/workflows',
  'GET /api/workflows/:kind/runs',
  'GET /api/worktrees',
  'GET /api/worktrees/:id',
  'PATCH /api/agents/:id',
  'PATCH /api/chats/:id',
  'PATCH /api/hooks/registry/:scope/:key',
  'PATCH /api/integrations/:id',
  'PATCH /api/repo-config',
  'PATCH /api/schedules/:id',
  'PATCH /api/settings',
  'PATCH /api/tasks/:id',
  'PATCH /api/tasks/:id/base',
  'PATCH /api/tasks/:id/comments/:cid',
  'PATCH /api/tasks/:id/review-runs/:rid/walkthrough',
  'PATCH /api/tasks/:id/viewed',
  'PATCH /api/workers/:id/task',
  'POST /api/agents',
  'POST /api/agents/:id/session',
  'POST /api/chats',
  'POST /api/hooks/install',
  'POST /api/integrations',
  'POST /api/integrations/:id/test',
  'POST /api/integrations/linear/prefill',
  'POST /api/learnings',
  'POST /api/learnings/:id/supersede',
  'POST /api/loop-groups',
  'POST /api/loop-groups/:id/judge',
  'POST /api/loop-groups/:id/judge/emit',
  'POST /api/loops',
  'POST /api/loops/:runId/emit',
  'POST /api/loops/:runId/stop',
  'POST /api/orchestrator/conversations',
  'POST /api/orchestrator/conversations/:id/global-monitor',
  'POST /api/pr-extracts/:taskId/emit',
  'POST /api/preflight/stash',
  'POST /api/reviews',
  'POST /api/schedules',
  'POST /api/schedules/:id/run',
  'POST /api/schedules/import',
  'POST /api/setup/apply-recommended-defaults',
  'POST /api/setup/install',
  'POST /api/tasks',
  'POST /api/tasks/:id/comments',
  'POST /api/tasks/:id/move',
  'POST /api/tasks/:id/note',
  'POST /api/tasks/:id/publish-review',
  'POST /api/tasks/:id/refs',
  'POST /api/tasks/:id/restore',
  'POST /api/tasks/:id/review-runs',
  'POST /api/tasks/:id/start',
  'POST /api/tasks/:id/summary',
  'POST /api/tasks/:id/terminals',
  'POST /api/tasks/:id/user-terminal',
  'POST /api/tasks/:id/workers',
  'POST /api/tasks/:id/workers/:agentId/message',
  'POST /api/tasks/:taskId/review',
  'POST /api/tasks/delete-done',
  'POST /api/tasks/viewed-all',
  'PUT /api/kinds/:kind',
  'PUT /api/repos/:repoPath/files/content',
];

beforeEach(() => {
  resetRegistry();
  resetInstalled();
});

describe('route inventory drift', () => {
  it('has no duplicate PENDING_MIGRATION entries', () => {
    expect(PENDING_MIGRATION.length).toBe(new Set(PENDING_MIGRATION).size);
  });

  it('accounts for every mounted route as a capability, an exemption, or a listed pending migration', async () => {
    await installCapabilities();
    const app = createApp();
    const mounted = listMountedRoutes(app).filter((r) => routeKey(r) !== TEST_ONLY_ROUTE);

    const undeclared = findUndeclaredRoutes(mounted).map(routeKey);
    const pending = new Set(PENDING_MIGRATION);

    // A route here that ISN'T in PENDING_MIGRATION is exactly the gap this
    // test exists to catch: something new is neither a capability nor a
    // declared exemption. (Not exact-equality against PENDING_MIGRATION —
    // routes covered by capabilities added since this list was last trimmed
    // are expected to disappear from `undeclared`, and that's fine.)
    const unexpected = undeclared.filter((key) => !pending.has(key));
    expect(unexpected).toEqual([]);
  });
});
