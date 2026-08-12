/**
 * server/registry/capabilities/learning.ts
 *
 * Handlers for all six `learning` capabilities, including the four that were
 * previously blocked from migrating by bearer-token auth the registry could
 * not express (`learning.add`, `learning.recall`, `learning.supersede`,
 * `learning.digest`) — see `packages/capabilities/src/capabilities/learning.ts`'s
 * module doc for the auth mechanism (`http.auth: 'bearer-hook-token'`) and
 * `server/registry/projections/http.ts` for where it's enforced.
 *
 * The four bearer-gated handlers below are deliberately byte-for-byte copies
 * of the manual validation `server/routes/learnings.ts` used to do inline —
 * same `typeof` checks, same error messages, same status codes — because
 * `@octomux/capabilities`'s input schemas for them are intentionally loose
 * (see that package's module doc) and defer the actual checking here.
 *
 * Design doc: spec/surface-consolidation-and-centaur.md §5.1–5.3
 */

import { z } from 'zod';
import {
  LEARNING_CAPABILITY_META,
  learningListInputSchema,
  learningDeleteInputSchema,
  learningAddInputSchema,
  learningRecallInputSchema,
  learningSupersedeInputSchema,
  learningDigestInputSchema,
} from '@octomux/capabilities';
import type { CapabilityMeta } from '@octomux/capabilities';
import { defineCapability } from '../index.js';
import {
  listForRead,
  deleteLearning,
  addLearning,
  getLearning,
  laneFor,
  listBenefit,
  listForDigest,
  supersedeLearning,
  SHARED_LANE,
} from '../../repositories/agent-learnings.js';
import { lintLearning } from '../../repositories/learn-lint.js';
import { getTask } from '../../repositories/tasks.js';
import { revParseHead } from '../../task-engine/git.js';
import { badRequest, notFound, ServiceError } from '../../services/errors.js';
import { recallLearnings, REVIEW_LANE, REVIEW_LIST_LIMIT } from '../../routes/learnings.js';
import { childLogger } from '../../logger.js';

const logger = childLogger('registry/capabilities/learning');

// ─── learning.list ────────────────────────────────────────────────────────────
//
// Mirrors GET /api/repos/:repoPath/learnings exactly, including the
// double-decode (see routes/learnings.ts for why) and the response shape the
// frontend's LearningsPanel consumes.

function listLearningsHandler(input: z.infer<typeof learningListInputSchema>) {
  const repoPath = decodeURIComponent(input.repoPath);
  const rows = listForRead(repoPath, REVIEW_LANE, { limit: REVIEW_LIST_LIMIT });
  return rows.map((r) => ({
    id: r.id,
    repo_path: r.repo_path,
    why: r.lesson,
    created_from_comment_id: r.evidence === REVIEW_LANE ? null : r.evidence,
    usage_count: r.usage_count,
    last_used_at: r.last_used_at,
    created_at: r.created_at,
  }));
}

// ─── learning.delete ──────────────────────────────────────────────────────────

function deleteLearningHandler(input: z.infer<typeof learningDeleteInputSchema>) {
  deleteLearning(input.id);
  return { id: input.id };
}

// ─── learning.add ─────────────────────────────────────────────────────────────
//
// Mirrors POST /api/learnings exactly: same field checks/messages (400), same
// task lookup (404), same lint gate (422 with the original message), same
// lane resolution via laneFor(task), same 201 body (`row ?? { deduped: true }`).

async function addLearningHandler(input: z.infer<typeof learningAddInputSchema>) {
  const b = input as {
    taskId?: unknown;
    trigger?: unknown;
    lesson?: unknown;
    evidence?: unknown;
    private?: unknown;
  };
  if (typeof b.taskId !== 'string' || !b.taskId) throw badRequest('taskId is required');
  if (typeof b.trigger !== 'string' || !b.trigger.trim()) throw badRequest('trigger is required');
  if (typeof b.lesson !== 'string' || !b.lesson.trim()) throw badRequest('lesson is required');
  if (typeof b.evidence !== 'string' || !b.evidence.trim()) {
    throw badRequest('evidence is required');
  }

  const task = getTask(b.taskId);
  if (!task) throw notFound('Task not found');

  const lint = lintLearning(b.lesson);
  if (!lint.ok) {
    logger.warn({ task_id: task.id, reason: lint.reason }, 'learning rejected by lint');
    // Matches the original route's res.status(422).json({ error: ... }) —
    // ServiceError with no custom body falls back to { error: message }.
    throw new ServiceError(`learning rejected: ${lint.reason}`, 422);
  }

  const commit = task.worktree ? await revParseHead(task.worktree).catch(() => null) : null;
  const lane = b.private === true ? laneFor(task) : SHARED_LANE;
  const row = addLearning({
    repo_path: task.repo_path,
    lane,
    trigger: b.trigger.trim(),
    lesson: b.lesson.trim(),
    evidence: b.evidence.trim(),
    source_run_id: task.id,
    source_commit: commit,
  });
  logger.info({ task_id: task.id, lane, deduped: row === null }, 'learning recorded');
  return row ?? { deduped: true };
}

// ─── learning.recall ──────────────────────────────────────────────────────────
//
// Mirrors GET /api/learnings exactly, via the same shared `recallLearnings`
// helper the search_learnings MCP tool also calls (routes/learnings.ts).

function recallLearningsHandler(input: z.infer<typeof learningRecallInputSchema>) {
  const q = input as { taskId?: unknown; query?: unknown };
  if (typeof q.taskId !== 'string' || !q.taskId) throw badRequest('taskId is required');
  if (typeof q.query !== 'string' || !q.query.trim()) throw badRequest('query is required');

  const rows = recallLearnings({ taskId: q.taskId, query: q.query });
  logger.info({ task_id: q.taskId, count: rows.length }, 'learnings recalled');
  return rows;
}

// ─── learning.supersede ───────────────────────────────────────────────────────
//
// Mirrors POST /api/learnings/:id/supersede exactly, including the
// repo-isolation check: a task may only supersede learnings in its own repo.

function supersedeLearningHandler(input: z.infer<typeof learningSupersedeInputSchema>) {
  const { id } = input;
  const b = input as { taskId?: unknown; reason?: unknown };
  if (typeof b.taskId !== 'string' || !b.taskId) throw badRequest('taskId is required');
  if (typeof b.reason !== 'string' || !b.reason.trim()) throw badRequest('reason is required');

  const learning = getLearning(id);
  if (!learning) throw notFound('Learning not found');

  const task = getTask(b.taskId);
  if (!task) throw notFound('Task not found');

  if (learning.repo_path !== task.repo_path) {
    throw new ServiceError('learning belongs to a different repo', 403);
  }

  supersedeLearning(id, b.reason.trim());
  logger.info(
    { task_id: task.id, learning_id: id, reason: b.reason.trim() },
    'learning superseded',
  );
  return getLearning(id);
}

// ─── learning.digest ──────────────────────────────────────────────────────────
//
// Mirrors GET /api/learnings/digest exactly.

const DEFAULT_DIGEST_SINCE_DAYS = 7;

function digestLearningsHandler(input: z.infer<typeof learningDigestInputSchema>) {
  const q = input as { repo?: unknown; sinceDays?: unknown };
  if (typeof q.repo !== 'string' || !q.repo) throw badRequest('repo is required');

  // sinceDays always arrives as a query-string value (string) or absent —
  // the cast only satisfies TS on the loose `unknown` field, same runtime
  // shape the original `req.query as Record<string, string>` typing assumed.
  const sinceDays = q.sinceDays ? Number(q.sinceDays as string) : DEFAULT_DIGEST_SINCE_DAYS;
  if (!Number.isFinite(sinceDays) || sinceDays <= 0) throw badRequest('sinceDays must be > 0');

  const sinceIso = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ');
  const { additions, unused, superseded } = listForDigest(q.repo, sinceIso);
  const benefit = listBenefit(q.repo);
  logger.info(
    {
      repo_path: q.repo,
      sinceDays,
      additions: additions.length,
      unused: unused.length,
      superseded: superseded.length,
    },
    'learnings digest computed',
  );
  return { additions, unused, superseded, benefit };
}

// ─── Registration ─────────────────────────────────────────────────────────────

function findMeta<TInput>(id: string, _schema: z.ZodType<TInput>): CapabilityMeta<TInput> {
  const meta = LEARNING_CAPABILITY_META.find((m) => m.id === id);
  if (!meta) throw new Error(`registry: missing capability metadata for '${id}'`);
  return meta as CapabilityMeta<TInput>;
}

export function registerLearningCapabilities(): void {
  defineCapability({
    ...findMeta('learning.list', learningListInputSchema),
    handler: listLearningsHandler,
  });

  defineCapability({
    ...findMeta('learning.delete', learningDeleteInputSchema),
    handler: deleteLearningHandler,
  });

  defineCapability({
    ...findMeta('learning.add', learningAddInputSchema),
    handler: addLearningHandler,
  });

  defineCapability({
    ...findMeta('learning.recall', learningRecallInputSchema),
    handler: recallLearningsHandler,
  });

  defineCapability({
    ...findMeta('learning.supersede', learningSupersedeInputSchema),
    handler: supersedeLearningHandler,
  });

  defineCapability({
    ...findMeta('learning.digest', learningDigestInputSchema),
    handler: digestLearningsHandler,
  });
}
