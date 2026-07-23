/**
 * Feeds inbound PR review comments back into `agent_learnings`, so the next
 * scheduled run of a `prod-log-triage` loop reads human feedback (via the
 * normal `seedLearnings` path) before repeating the same approach.
 *
 * Human feedback ONLY — this never auto-verifies or affects loop
 * termination (`evaluateTermination` in task-engine/loop/engine.ts stays
 * untouched; the evaluator remains outside the loop).
 */
import fs from 'fs';
import path from 'path';
import { childLogger } from '../logger.js';
import { fetchPrReviewComments } from '../github-client.js';
import { addLearning, laneFor, SHARED_LANE } from '../repositories/agent-learnings.js';

const logger = childLogger('comment-feedback');

const INGESTED_IDS_REL_PATH = path.join('.octomux', 'ingested-comment-ids.json');
const MAX_COMMENTS_PER_ENTRY = 20;
const MAX_BODY_CHARS = 500;

function readIngestedIds(repoPath: string): Set<string> {
  try {
    const raw = fs.readFileSync(path.join(repoPath, INGESTED_IDS_REL_PATH), 'utf-8');
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function writeIngestedIds(repoPath: string, ids: Set<string>): void {
  const dir = path.join(repoPath, '.octomux');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(repoPath, INGESTED_IDS_REL_PATH), JSON.stringify([...ids]));
}

export interface IngestReviewCommentsInput {
  repoPath: string;
  prNumber: number;
  /** The task the PR belongs to — when given, learnings land in its lane (schedule or loop) instead of the shared lane. */
  task?: { id: string; schedule_id?: string | null };
}

/**
 * Fetches inbound review comments for a PR and records a bounded
 * `agent_learnings` row — deduped by comment id against a sidecar
 * `.octomux/ingested-comment-ids.json`. Returns the number of comments newly
 * ingested (0 if none are new).
 */
export async function ingestReviewComments(input: IngestReviewCommentsInput): Promise<number> {
  const { repoPath, prNumber, task } = input;
  const comments = await fetchPrReviewComments(repoPath, prNumber);

  const ingestedIds = readIngestedIds(repoPath);
  const newComments = comments.filter((c) => !ingestedIds.has(c.id));
  if (newComments.length === 0) return 0;

  const shown = newComments.slice(0, MAX_COMMENTS_PER_ENTRY);
  const lesson = shown
    .map(
      (c) =>
        `${c.path ? `${c.path}: ` : ''}${c.body.trim().slice(0, MAX_BODY_CHARS).replace(/\n/g, ' ')}`,
    )
    .join(' | ');
  const paths = [...new Set(shown.map((c) => c.path).filter((p): p is string => Boolean(p)))];

  addLearning({
    repo_path: repoPath,
    lane: task ? laneFor(task) : SHARED_LANE,
    trigger: `PR #${prNumber} review feedback`,
    lesson,
    evidence: paths.length > 0 ? paths.join(', ') : `PR #${prNumber}`,
  });

  for (const c of newComments) ingestedIds.add(c.id);
  writeIngestedIds(repoPath, ingestedIds);

  logger.info(
    { repo_path: repoPath, pr_number: prNumber, count: newComments.length },
    'ingested PR review comments into agent_learnings',
  );

  return newComments.length;
}
