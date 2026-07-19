/**
 * Feeds inbound PR review comments back into a `prod-log-triage` loop's
 * playbook (`.octomux/loop-playbook.md`), so the next scheduled run reads
 * human feedback before repeating the same approach.
 *
 * Human feedback ONLY — this never auto-verifies or affects loop
 * termination (`evaluateTermination` in task-engine/loop/engine.ts stays
 * untouched; the evaluator remains outside the loop).
 *
 * `engine.ts`'s `PLAYBOOK_REL_PATH`/`appendPlaybookEntry` are module-private
 * (not exported) — this file reimplements the same bounded-append shape
 * against the same hardcoded relative path rather than importing them.
 */
import fs from 'fs';
import path from 'path';
import { childLogger } from '../logger.js';
import { fetchPrReviewComments } from '../github-client.js';

const logger = childLogger('comment-feedback');

const PLAYBOOK_REL_PATH = path.join('.octomux', 'loop-playbook.md');
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
}

/**
 * Fetches inbound review comments for a PR and appends a bounded,
 * human-readable entry to the repo's loop playbook — deduped by comment id
 * against a sidecar `.octomux/ingested-comment-ids.json`. Returns the number
 * of comments newly appended (0 if none are new).
 */
export async function ingestReviewComments(input: IngestReviewCommentsInput): Promise<number> {
  const { repoPath, prNumber } = input;
  const comments = await fetchPrReviewComments(repoPath, prNumber);

  const ingestedIds = readIngestedIds(repoPath);
  const newComments = comments.filter((c) => !ingestedIds.has(c.id));
  if (newComments.length === 0) return 0;

  const shown = newComments.slice(0, MAX_COMMENTS_PER_ENTRY);
  const lines = [`## PR review feedback — #${prNumber} (${shown.length} comment(s))`];
  for (const c of shown) {
    const body = c.body.trim().slice(0, MAX_BODY_CHARS).replace(/\n/g, ' ');
    lines.push(`- ${c.path ? `${c.path}: ` : ''}${body}`);
  }

  const dir = path.join(repoPath, '.octomux');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(repoPath, PLAYBOOK_REL_PATH), lines.join('\n') + '\n\n');

  for (const c of newComments) ingestedIds.add(c.id);
  writeIngestedIds(repoPath, ingestedIds);

  logger.info(
    { repo_path: repoPath, pr_number: prNumber, count: newComments.length },
    'ingested PR review comments into loop playbook',
  );

  return newComments.length;
}
