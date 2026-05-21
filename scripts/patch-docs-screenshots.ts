/**
 * Post-start patches for README screenshots (after initDb resolves stale permission prompts).
 */
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath =
  process.env.OCTOMUX_DB_PATH ??
  path.join(__dirname, '..', 'data', 'docs-demo', 'tasks.db');

const DEMO_DETAIL_WORKTREE = path.join(
  __dirname,
  '..',
  'demo-fixtures',
  'acme-platform',
  '.worktrees',
  'demo-detail',
);
const DEMO_TMUX = 'octomux-agent-demo-detail';
const DEMO_CLAUDE_WELCOME = path.join(__dirname, 'demo-claude-welcome.sh');

function primeDemoClaudeTmux(): void {
  try {
    execSync(`tmux kill-session -t ${DEMO_TMUX}`, { stdio: 'ignore' });
  } catch {
    // not running
  }
  execSync(
    `tmux new-session -d -s ${DEMO_TMUX} -c ${JSON.stringify(DEMO_DETAIL_WORKTREE)} ${JSON.stringify(DEMO_CLAUDE_WELCOME)}`,
  );
  execSync(`tmux set-option -t ${DEMO_TMUX} status off`);
}

const db = new Database(dbPath);

const prompts = db
  .prepare(
    `UPDATE permission_prompts
     SET status = 'pending', resolved_at = NULL
     WHERE id IN ('pp-demo-oauth', 'pp-demo-page')`,
  )
  .run();

// Clear any recovery error from a prior run; task-detail tests promote to running + tmux.
db.prepare(
  `UPDATE tasks
   SET runtime_state = 'idle', error = NULL, tmux_session = NULL, updated_at = datetime('now')
   WHERE id = 'demo-detail'`,
).run();

db.close();

primeDemoClaudeTmux();

// Promote demo-detail for agent + diff screenshots (alive tmux → no recovery error).
const db2 = new Database(dbPath);
db2.prepare(
  `UPDATE tasks
   SET runtime_state = 'running', error = NULL, tmux_session = ?, updated_at = datetime('now')
   WHERE id = 'demo-detail'`,
).run(DEMO_TMUX);
db2.prepare(
  `INSERT OR REPLACE INTO integrations (id, kind, name, config_json, enabled, created_at, updated_at)
   VALUES (
     'demo-jira',
     'jira',
     'Acme Jira',
     ?,
     1,
     datetime('now'),
     datetime('now')
   )`,
).run(
  JSON.stringify({
    baseUrl: 'https://acme.atlassian.net',
    email: 'ops@acme.io',
    apiToken: 'demo-token-not-real',
  }),
);

db2.close();

console.log(`Reopened ${prompts.changes} inbox permission prompts`);
console.log(`Prepared demo-detail for screenshots (tmux: ${DEMO_TMUX})`);
