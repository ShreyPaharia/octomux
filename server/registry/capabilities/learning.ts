/**
 * server/registry/capabilities/learning.ts
 *
 * Handlers for the two `learning` capabilities that migrated cleanly off
 * `server/routes/learnings.ts` — see
 * `packages/capabilities/src/capabilities/learning.ts`'s module doc for why
 * the other four learnings routes did NOT move here (bearer-token auth the
 * registry cannot express).
 *
 * Design doc: spec/surface-consolidation-and-centaur.md §5.1–5.3
 */

import { z } from 'zod';
import {
  LEARNING_CAPABILITY_META,
  learningListInputSchema,
  learningDeleteInputSchema,
} from '@octomux/capabilities';
import type { CapabilityMeta } from '@octomux/capabilities';
import { defineCapability } from '../index.js';
import { listForRead, deleteLearning } from '../../repositories/agent-learnings.js';
import { REVIEW_LANE, REVIEW_LIST_LIMIT } from '../../routes/learnings.js';

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
}
