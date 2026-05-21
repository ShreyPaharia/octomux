/**
 * Seeds a fictional task database for README / marketing screenshots.
 * No real repo paths or project names — safe to commit screenshots generated from this data.
 *
 * Usage:
 *   tsx scripts/seed-docs-demo.ts
 *   OCTOMUX_DB_PATH=./data/docs-demo/tasks.db tsx scripts/seed-docs-demo.ts
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { initDb } from '../server/db.js';
import { insertTask, insertAgent, insertPermissionPrompt } from '../server/test-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', 'demo-fixtures', 'acme-platform');
const WORKTREE_ROOT = path.join(REPO, '.worktrees');
const NOW = new Date().toISOString().replace('T', ' ').slice(0, 19);

const defaultDbPath = path.join(__dirname, '..', 'data', 'docs-demo', 'tasks.db');
const dbPath = process.env.OCTOMUX_DB_PATH ?? defaultDbPath;

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

fs.mkdirSync(REPO, { recursive: true });
// Minimal git repo so recovery checks pass (no real history needed for screenshots).
const gitDir = path.join(REPO, '.git');
if (!fs.existsSync(gitDir)) {
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'refs', 'heads', 'main'), 'a1b2c3d4e5f6789012345678901234567890abcd\n');
}

const db = new Database(dbPath);
initDb(db);

function wtPath(slug: string): string {
  const p = path.join(WORKTREE_ROOT, slug);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function seedTask(
  id: string,
  title: string,
  opts: {
    description?: string;
    runtime_state?: 'idle' | 'running' | 'error';
    workflow_status?: string;
    branch?: string;
    pr_url?: string;
    pr_number?: number;
    last_viewed_at?: string | null;
    current_summary?: string;
    base_sha?: string;
  } = {},
) {
  insertTask(db, {
    id,
    title,
    description: opts.description ?? title,
    repo_path: REPO,
    worktree: wtPath(id),
    branch: opts.branch ?? `agents/${id}`,
    base_branch: 'main',
    base_sha: opts.base_sha ?? 'a1b2c3d4e5f6789012345678901234567890abcd',
    runtime_state: opts.runtime_state ?? 'idle',
    workflow_status: (opts.workflow_status as never) ?? 'backlog',
    pr_url: opts.pr_url ?? null,
    pr_number: opts.pr_number ?? null,
    last_viewed_at: opts.last_viewed_at ?? null,
    current_summary: opts.current_summary ?? null,
    created_at: NOW,
    updated_at: NOW,
  });
}

// ── Inbox: awaiting reply (pending permission prompts) ─────────────────────

seedTask('demo-oauth', 'Add OAuth2 login flow', {
  description: 'Google + GitHub providers, session cookies, CSRF protection',
  runtime_state: 'idle',
  workflow_status: 'in_progress',
  current_summary: 'Wiring callback routes and token refresh',
});
const oauthAgent = insertAgent(db, {
  id: 'demo-oauth-agent',
  task_id: 'demo-oauth',
  label: 'Agent 1',
  status: 'waiting',
  harness_session_id: 'demo-session-oauth',
  hook_token: 'demo-token-oauth',
});
insertPermissionPrompt(db, {
  id: 'pp-demo-oauth',
  task_id: 'demo-oauth',
  agent_id: oauthAgent.id,
  tool_name: 'Bash',
  tool_input: '{"command":"npm run test:auth"}',
});

seedTask('demo-pagination', 'Fix pagination on orders API', {
  description: 'Cursor-based paging for /v2/orders with stable sort keys',
  runtime_state: 'idle',
  workflow_status: 'in_progress',
});
const pageAgent = insertAgent(db, {
  id: 'demo-page-agent',
  task_id: 'demo-pagination',
  label: 'Agent 1',
  status: 'waiting',
  harness_session_id: 'demo-session-page',
  hook_token: 'demo-token-page',
});
insertPermissionPrompt(db, {
  id: 'pp-demo-page',
  task_id: 'demo-pagination',
  agent_id: pageAgent.id,
  tool_name: 'Write',
  tool_input: '{"file_path":"src/api/orders.ts"}',
});

// ── Inbox: activity (idle, unseen) ─────────────────────────────────────────

seedTask('demo-rate-limit', 'Ship rate limiting middleware', {
  runtime_state: 'idle',
  workflow_status: 'done',
  current_summary: 'Merged sliding-window limiter with Redis backend',
});
seedTask('demo-redis-migrate', 'Migrate auth tokens to Redis', {
  runtime_state: 'idle',
  workflow_status: 'archived',
});

// ── Command center board columns ───────────────────────────────────────────

seedTask('demo-backlog', 'Add webhook retry queue', {
  workflow_status: 'backlog',
  runtime_state: 'idle',
});
seedTask('demo-planned', 'Refactor billing module', {
  workflow_status: 'planned',
  runtime_state: 'idle',
});
seedTask('demo-progress', 'Implement audit log export', {
  workflow_status: 'in_progress',
  runtime_state: 'idle',
  current_summary: 'CSV + S3 upload path in progress',
});
seedTask('demo-review', 'Harden session cookie settings', {
  workflow_status: 'human_review',
  runtime_state: 'idle',
  pr_url: 'https://github.com/acme-corp/platform/pull/412',
  pr_number: 412,
});
seedTask('demo-pr-col', 'Upgrade Node 22 in CI', {
  workflow_status: 'pr',
  runtime_state: 'idle',
  pr_url: 'https://github.com/acme-corp/platform/pull/408',
  pr_number: 408,
});
seedTask('demo-done', 'Document public API rate limits', {
  workflow_status: 'done',
  runtime_state: 'idle',
});

// ── Extra running sessions (sidebar + activity meta) ───────────────────────

seedTask('demo-running-a', 'Cache product catalog responses', {
  runtime_state: 'idle',
  workflow_status: 'in_progress',
});
seedTask('demo-running-b', 'Add Stripe webhook signatures', {
  workflow_status: 'in_progress',
  runtime_state: 'idle',
});

// ── Task detail hero (human review + agents) ───────────────────────────────

seedTask('demo-detail', 'Add team invite flow', {
  description: 'Email invites, role picker, audit trail for workspace admins',
  workflow_status: 'human_review',
  runtime_state: 'idle',
  tmux_session: null,
  initial_prompt: 'Implement workspace team invites with email flow and role picker.',
  branch: 'agents/team-invite-flow',
  pr_url: 'https://github.com/acme-corp/platform/pull/415',
  pr_number: 415,
  current_summary: 'Ready for review — 6 files changed',
});
insertAgent(db, {
  id: 'demo-detail-a1',
  task_id: 'demo-detail',
  window_index: 0,
  label: 'Agent 1',
  status: 'idle',
  harness_session_id: 'demo-detail-s1',
  hook_token: 'demo-detail-t1',
});
insertAgent(db, {
  id: 'demo-detail-a2',
  task_id: 'demo-detail',
  window_index: 1,
  label: 'Agent 2',
  status: 'running',
  harness_session_id: 'demo-detail-s2',
  hook_token: 'demo-detail-t2',
});

const count = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
db.close();
console.log(`Seeded docs demo database (${count} tasks)`);
console.log(dbPath);
