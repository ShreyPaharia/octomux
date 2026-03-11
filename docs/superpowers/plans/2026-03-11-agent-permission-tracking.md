# Agent Permission Prompt Tracking — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track Claude Code agent permission prompts via HTTP hooks and display them inline on task cards with real-time agent activity status.

**Architecture:** Three HTTP hook endpoints receive events from Claude Code agents running in tmux. Events are stored in SQLite and served via the existing `/api/tasks` response. Frontend task cards show pending prompts and agent activity indicators. A derived task status (working/needs_attention/done) replaces the generic "running" badge.

**Tech Stack:** Express 5, better-sqlite3, React 19, Tailwind CSS 4, shadcn/ui, vitest, supertest

**Spec:** `docs/superpowers/specs/2026-03-11-agent-permission-tracking-design.md`

---

## File Structure

### New files
- `server/hooks.ts` — Hook route handlers (permission-request, post-tool-use, stop)
- `server/hooks.test.ts` — Hook endpoint tests
- `server/hook-settings.ts` — Generate/merge `.claude/settings.local.json` for worktrees
- `server/hook-settings.test.ts` — Hook settings generation tests
- `src/components/PermissionPromptRow.tsx` — Single permission prompt display row
- `src/components/AgentActivityDot.tsx` — Colored dot for agent hook_activity state

### Modified files
- `server/types.ts` — Add HookActivity, PermissionPrompt, DerivedTaskStatus types
- `server/db.ts` — Add permission_prompts table, hook_activity column, startup cleanup
- `server/api.ts` — Mount hook routes, update GET /api/tasks to include prompts + derived_status
- `server/task-runner.ts` — Install hooks in startTask(), resolve prompts in closeTask()/stopAgent(), fix resumeTask() session ID
- `server/test-helpers.ts` — Add DEFAULTS.permissionPrompt, insertPermissionPrompt(), PERMISSION_PROMPTS_TABLE_COLUMNS
- `src/components/TaskCard.tsx` — Show pending prompts, agent activity, derived status
- `src/components/StatusBadge.tsx` — Support derived_status values
- `src/components/AgentTabs.tsx` — Show hook_activity dot on agent tabs

---

## Chunk 1: Data Model + Types

### Task 1: Types

**Files:**
- Modify: `server/types.ts`

- [ ] **Step 1: Add HookActivity, PermissionPrompt, and DerivedTaskStatus types**

Add after the existing `AgentStatus` type (line 2):

```typescript
export type HookActivity = 'active' | 'idle' | 'waiting';
export type DerivedTaskStatus = 'working' | 'needs_attention' | 'done';
```

Add after the `Agent` interface (after line 32):

```typescript
export interface PermissionPrompt {
  id: string;
  task_id: string;
  agent_id: string | null;
  agent_label: string;
  session_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  status: 'pending' | 'resolved';
  created_at: string;
  resolved_at: string | null;
}
```

Add `hook_activity` and `hook_activity_updated_at` to the `Agent` interface:

```typescript
hook_activity: HookActivity;
hook_activity_updated_at: string | null;
```

Add `pending_prompts` and `derived_status` to the `Task` interface:

```typescript
pending_prompts?: PermissionPrompt[];
derived_status?: DerivedTaskStatus | null;
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: Errors in files that construct Agent/Task objects without the new fields (this is expected — we'll fix in later tasks).

- [ ] **Step 3: Commit**

```bash
git add server/types.ts
git commit -m "feat(types): add HookActivity, PermissionPrompt, DerivedTaskStatus types"
```

### Task 2: Database Schema + Migrations

**Files:**
- Modify: `server/db.ts`

- [ ] **Step 1: Add permission_prompts table to SCHEMA constant**

After the agents table definition (around line 37), add:

```sql
CREATE TABLE IF NOT EXISTS permission_prompts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT,
  session_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_permission_prompts_task_id ON permission_prompts(task_id);
CREATE INDEX IF NOT EXISTS idx_permission_prompts_status ON permission_prompts(status);
CREATE INDEX IF NOT EXISTS idx_permission_prompts_agent_status ON permission_prompts(agent_id, status);
```

- [ ] **Step 2: Add hook_activity migration in initDb()**

After the existing agent column migrations (around line 77), add:

```typescript
const agentCols2 = instance.pragma('table_info(agents)') as Array<{ name: string }>;
const agentColNames2 = agentCols2.map((c) => c.name);
if (!agentColNames2.includes('hook_activity')) {
  instance.exec("ALTER TABLE agents ADD COLUMN hook_activity TEXT NOT NULL DEFAULT 'active'");
  instance.exec('ALTER TABLE agents ADD COLUMN hook_activity_updated_at TEXT');
}
```

- [ ] **Step 3: Add startup cleanup for stale prompts**

After the migrations, add:

```typescript
instance.exec(
  `UPDATE permission_prompts SET status = 'resolved', resolved_at = datetime('now') WHERE status = 'pending'`
);
```

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (or same errors from Task 1 — no new errors).

- [ ] **Step 5: Commit**

```bash
git add server/db.ts
git commit -m "feat(db): add permission_prompts table and hook_activity column"
```

### Task 3: Test Helpers

**Files:**
- Modify: `server/test-helpers.ts`

- [ ] **Step 1: Add DEFAULTS.permissionPrompt fixture**

After `DEFAULTS.agent` (around line 56), add:

```typescript
permissionPrompt: {
  id: 'pp_test123456',
  task_id: 'task_test1234',
  agent_id: 'agent_test123',
  session_id: 'session-uuid-test',
  tool_name: 'Bash',
  tool_input: '{"command":"npm test"}',
  status: 'pending' as const,
  created_at: new Date().toISOString(),
  resolved_at: null,
},
```

- [ ] **Step 2: Update insertAgent() to include hook_activity column**

The existing `insertAgent()` INSERT statement (line 111) does not include `hook_activity`. Update it to:

```typescript
db.prepare(
  'INSERT INTO agents (id, task_id, window_index, label, status, claude_session_id, hook_activity) VALUES (?, ?, ?, ?, ?, ?, ?)',
).run(
  agent.id,
  agent.task_id,
  agent.window_index,
  agent.label,
  agent.status,
  agent.claude_session_id,
  agent.hook_activity || 'active',
);
```

- [ ] **Step 3: Add insertPermissionPrompt() helper**

After `insertAgent()` (around line 122), add. Note: follows existing pattern of `db` as first param:

```typescript
export function insertPermissionPrompt(
  db: Database.Database,
  overrides: Partial<typeof DEFAULTS.permissionPrompt> = {},
) {
  const pp = { ...DEFAULTS.permissionPrompt, ...overrides };
  db.prepare(
    `INSERT INTO permission_prompts (id, task_id, agent_id, session_id, tool_name, tool_input, status, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    pp.id,
    pp.task_id,
    pp.agent_id,
    pp.session_id,
    pp.tool_name,
    pp.tool_input,
    pp.status,
    pp.created_at,
    pp.resolved_at,
  );
  return pp;
}
```

- [ ] **Step 4: Add getPermissionPrompts() helper**

```typescript
export function getPermissionPrompts(db: Database.Database, taskId: string) {
  return db
    .prepare('SELECT * FROM permission_prompts WHERE task_id = ? ORDER BY created_at ASC')
    .all(taskId) as Array<Record<string, unknown>>;
}
```

- [ ] **Step 5: Add PERMISSION_PROMPTS_TABLE_COLUMNS constant**

After `AGENTS_TABLE_COLUMNS` (around line 211), add:

```typescript
export const PERMISSION_PROMPTS_TABLE_COLUMNS = [
  'id',
  'task_id',
  'agent_id',
  'session_id',
  'tool_name',
  'tool_input',
  'status',
  'created_at',
  'resolved_at',
];
```

- [ ] **Step 6: Update AGENTS_TABLE_COLUMNS**

Add `'hook_activity'` and `'hook_activity_updated_at'` to the existing `AGENTS_TABLE_COLUMNS` array.

- [ ] **Step 7: Commit**

```bash
git add server/test-helpers.ts
git commit -m "feat(test): add permission prompt fixtures and helpers"
```

### Task 4: DB Migration Tests

**Files:**
- Modify: `server/db.test.ts`

- [ ] **Step 1: Add tests for new table and columns**

Add test cases to the existing db test file:

```typescript
describe('permission_prompts table', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('creates permission_prompts table with correct columns', () => {
    const cols = db
      .pragma('table_info(permission_prompts)')
      .map((c: { name: string }) => c.name);
    expect(cols).toEqual(PERMISSION_PROMPTS_TABLE_COLUMNS);
  });

  it('adds hook_activity column to agents table', () => {
    const cols = db
      .pragma('table_info(agents)')
      .map((c: { name: string }) => c.name);
    expect(cols).toContain('hook_activity');
    expect(cols).toContain('hook_activity_updated_at');
  });

  it('resolves stale pending prompts on startup', () => {
    insertTask(db, { id: 't1', status: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1' });
    insertPermissionPrompt(db, { id: 'pp1', task_id: 't1', agent_id: 'a1', status: 'pending' });

    // Re-init simulates restart
    initDb(db);

    const prompts = getPermissionPrompts(db, 't1');
    expect(prompts[0].status).toBe('resolved');
    expect(prompts[0].resolved_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun run test server/db.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/db.test.ts
git commit -m "test(db): add permission_prompts table and hook_activity migration tests"
```

---

## Chunk 2: Hook Endpoints

### Task 5: Hook Route Handlers

**Files:**
- Create: `server/hooks.ts`

- [ ] **Step 1: Write the hook handlers module**

```typescript
import { Router } from 'express';
import { nanoid } from 'nanoid';
import { getDb } from './db.js';

const router = Router();

function findAgentBySessionId(sessionId: string) {
  return getDb()
    .prepare(
      `SELECT a.id, a.task_id FROM agents a
       WHERE a.claude_session_id = ? AND a.status != 'stopped'
       LIMIT 1`,
    )
    .get(sessionId) as { id: string; task_id: string } | undefined;
}

// POST /api/hooks/permission-request
router.post('/permission-request', (req, res) => {
  const { session_id, tool_name, tool_input } = req.body;
  if (!session_id || !tool_name) {
    res.status(200).send();
    return;
  }

  const agent = findAgentBySessionId(session_id);
  if (!agent) {
    res.status(200).send();
    return;
  }

  const txn = getDb().transaction(() => {
    getDb()
      .prepare(
        `INSERT INTO permission_prompts (id, task_id, agent_id, session_id, tool_name, tool_input, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`,
      )
      .run(nanoid(12), agent.task_id, agent.id, session_id, tool_name, JSON.stringify(tool_input || {}));

    getDb()
      .prepare(
        `UPDATE agents SET hook_activity = 'waiting', hook_activity_updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(agent.id);
  });
  txn();

  res.status(200).send();
});

// POST /api/hooks/post-tool-use
router.post('/post-tool-use', (req, res) => {
  const { session_id } = req.body;
  if (!session_id) {
    res.status(200).send();
    return;
  }

  const agent = findAgentBySessionId(session_id);
  if (!agent) {
    res.status(200).send();
    return;
  }

  const txn = getDb().transaction(() => {
    // Resolve oldest pending prompt (FIFO)
    getDb()
      .prepare(
        `UPDATE permission_prompts SET status = 'resolved', resolved_at = datetime('now')
         WHERE id = (
           SELECT id FROM permission_prompts
           WHERE agent_id = ? AND status = 'pending'
           ORDER BY created_at ASC LIMIT 1
         )`,
      )
      .run(agent.id);

    getDb()
      .prepare(
        `UPDATE agents SET hook_activity = 'active', hook_activity_updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(agent.id);
  });
  txn();

  res.status(200).send();
});

// POST /api/hooks/stop
router.post('/stop', (req, res) => {
  const { session_id } = req.body;
  if (!session_id) {
    res.status(200).send();
    return;
  }

  const agent = findAgentBySessionId(session_id);
  if (!agent) {
    res.status(200).send();
    return;
  }

  const txn = getDb().transaction(() => {
    // Resolve ALL pending prompts for this agent
    getDb()
      .prepare(
        `UPDATE permission_prompts SET status = 'resolved', resolved_at = datetime('now')
         WHERE agent_id = ? AND status = 'pending'`,
      )
      .run(agent.id);

    getDb()
      .prepare(
        `UPDATE agents SET hook_activity = 'idle', hook_activity_updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(agent.id);
  });
  txn();

  res.status(200).send();
});

export { router as hookRoutes };
```

- [ ] **Step 2: Mount hooks router in api.ts**

In `server/api.ts`, import and mount the router. After the existing route setup (around line 65), add:

```typescript
import { hookRoutes } from './hooks.js';
```

Inside `setupRoutes()`, add:

```typescript
app.use('/api/hooks', hookRoutes);
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/hooks.ts server/api.ts
git commit -m "feat(hooks): add permission-request, post-tool-use, and stop HTTP hook endpoints"
```

### Task 6: Hook Endpoint Tests

**Files:**
- Create: `server/hooks.test.ts`

- [ ] **Step 1: Write hook endpoint tests**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createTestDb, insertTask, insertAgent, insertPermissionPrompt, getPermissionPrompts, DEFAULTS } from './test-helpers.js';
import { createApp } from './app.js';

describe('Hook endpoints', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
    insertTask(db, { id: 't1', status: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1', claude_session_id: 'sess-123' });
  });

  describe('POST /api/hooks/permission-request', () => {
    it('creates pending permission prompt and sets agent to waiting', async () => {
      await request(app)
        .post('/api/hooks/permission-request')
        .send({
          session_id: 'sess-123',
          hook_event_name: 'PermissionRequest',
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf dist' },
        })
        .expect(200);

      const prompts = getPermissionPrompts(db, 't1');
      expect(prompts).toHaveLength(1);
      expect(prompts[0].tool_name).toBe('Bash');
      expect(prompts[0].status).toBe('pending');
      expect(prompts[0].agent_id).toBe('a1');

      const agent = db.prepare('SELECT hook_activity FROM agents WHERE id = ?').get('a1') as { hook_activity: string };
      expect(agent.hook_activity).toBe('waiting');
    });

    it('ignores unknown session_id', async () => {
      await request(app)
        .post('/api/hooks/permission-request')
        .send({ session_id: 'unknown', tool_name: 'Bash', tool_input: {} })
        .expect(200);

      const prompts = getPermissionPrompts(db, 't1');
      expect(prompts).toHaveLength(0);
    });

    it('ignores request with missing fields', async () => {
      await request(app)
        .post('/api/hooks/permission-request')
        .send({})
        .expect(200);
    });
  });

  describe('POST /api/hooks/post-tool-use', () => {
    it('resolves oldest pending prompt and sets agent to active', async () => {
      insertPermissionPrompt(db, { id: 'pp1', task_id: 't1', agent_id: 'a1', session_id: 'sess-123', created_at: '2026-01-01T00:00:00Z' });
      insertPermissionPrompt(db, { id: 'pp2', task_id: 't1', agent_id: 'a1', session_id: 'sess-123', created_at: '2026-01-01T00:01:00Z' });

      await request(app)
        .post('/api/hooks/post-tool-use')
        .send({ session_id: 'sess-123', tool_name: 'Bash', tool_input: {} })
        .expect(200);

      const prompts = getPermissionPrompts(db, 't1');
      const pp1 = prompts.find((p) => p.id === 'pp1');
      const pp2 = prompts.find((p) => p.id === 'pp2');
      expect(pp1?.status).toBe('resolved');
      expect(pp2?.status).toBe('pending');

      const agent = db.prepare('SELECT hook_activity FROM agents WHERE id = ?').get('a1') as { hook_activity: string };
      expect(agent.hook_activity).toBe('active');
    });

    it('no-ops when no pending prompts exist', async () => {
      await request(app)
        .post('/api/hooks/post-tool-use')
        .send({ session_id: 'sess-123', tool_name: 'Bash', tool_input: {} })
        .expect(200);

      const agent = db.prepare('SELECT hook_activity FROM agents WHERE id = ?').get('a1') as { hook_activity: string };
      expect(agent.hook_activity).toBe('active');
    });
  });

  describe('POST /api/hooks/stop', () => {
    it('resolves all pending prompts and sets agent to idle', async () => {
      insertPermissionPrompt(db, { id: 'pp1', task_id: 't1', agent_id: 'a1', session_id: 'sess-123' });
      insertPermissionPrompt(db, { id: 'pp2', task_id: 't1', agent_id: 'a1', session_id: 'sess-123' });

      await request(app)
        .post('/api/hooks/stop')
        .send({ session_id: 'sess-123', stop_hook_active: false })
        .expect(200);

      const prompts = getPermissionPrompts(db, 't1');
      expect(prompts.every((p) => p.status === 'resolved')).toBe(true);

      const agent = db.prepare('SELECT hook_activity FROM agents WHERE id = ?').get('a1') as { hook_activity: string };
      expect(agent.hook_activity).toBe('idle');
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun run test server/hooks.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/hooks.test.ts
git commit -m "test(hooks): add hook endpoint tests for permission tracking"
```

---

## Chunk 3: Hook Installation + Task Runner Integration

### Task 7: Hook Settings Generator

**Files:**
- Create: `server/hook-settings.ts`

- [ ] **Step 1: Write the hook settings module**

```typescript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const OCTOMUX_HOOKS = {
  PermissionRequest: [
    {
      hooks: [
        {
          type: 'http',
          url: 'http://localhost:7777/api/hooks/permission-request',
          timeout: 5,
        },
      ],
    },
  ],
  PostToolUse: [
    {
      hooks: [
        {
          type: 'http',
          url: 'http://localhost:7777/api/hooks/post-tool-use',
          timeout: 5,
        },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        {
          type: 'http',
          url: 'http://localhost:7777/api/hooks/stop',
          timeout: 5,
        },
      ],
    },
  ],
};

export function installHookSettings(worktreePath: string): void {
  const claudeDir = join(worktreePath, '.claude');
  const settingsPath = join(claudeDir, 'settings.local.json');

  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      // Corrupted file — overwrite
    }
  }

  // Merge hooks: append our matcher groups to each event array
  const existingHooks = (existing.hooks || {}) as Record<string, unknown[]>;
  const mergedHooks = { ...existingHooks };

  for (const [event, matcherGroups] of Object.entries(OCTOMUX_HOOKS)) {
    const existingGroups = mergedHooks[event] || [];
    mergedHooks[event] = [...existingGroups, ...matcherGroups];
  }

  const merged = { ...existing, hooks: mergedHooks };

  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
}
```

- [ ] **Step 2: Commit**

```bash
git add server/hook-settings.ts
git commit -m "feat(hooks): add hook settings generator for worktrees"
```

### Task 8: Hook Settings Tests

**Files:**
- Create: `server/hook-settings.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { installHookSettings } from './hook-settings.js';

describe('installHookSettings', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'octomux-hooks-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates .claude/settings.local.json with hook config', () => {
    installHookSettings(tmpDir);

    const settings = JSON.parse(readFileSync(join(tmpDir, '.claude', 'settings.local.json'), 'utf-8'));
    expect(settings.hooks.PermissionRequest).toHaveLength(1);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.PermissionRequest[0].hooks[0].type).toBe('http');
  });

  it('merges with existing settings', () => {
    const claudeDir = join(tmpDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'settings.local.json'),
      JSON.stringify({ existingKey: true, hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }),
    );

    installHookSettings(tmpDir);

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.local.json'), 'utf-8'));
    expect(settings.existingKey).toBe(true);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PermissionRequest).toHaveLength(1);
  });

  it('handles corrupted existing file', () => {
    const claudeDir = join(tmpDir, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.local.json'), 'not json');

    installHookSettings(tmpDir);

    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.local.json'), 'utf-8'));
    expect(settings.hooks.PermissionRequest).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun run test server/hook-settings.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/hook-settings.test.ts
git commit -m "test(hooks): add hook settings generator tests"
```

### Task 9: Integrate Hooks into Task Runner

**Files:**
- Modify: `server/task-runner.ts`

- [ ] **Step 1: Install hooks in startTask()**

Import at top:

```typescript
import { installHookSettings } from './hook-settings.js';
```

In `startTask()`, after the existing `.claude/settings.local.json` copy (around line 96), add:

```typescript
installHookSettings(worktreePath);
```

This runs after the copy so it merges with any existing settings from the source repo.

- [ ] **Step 2: Resolve prompts in closeTask()**

In `closeTask()` (around line 187), BEFORE the existing agent status update, add:

```typescript
getDb()
  .prepare(
    `UPDATE permission_prompts SET status = 'resolved', resolved_at = datetime('now')
     WHERE task_id = ? AND status = 'pending'`,
  )
  .run(task.id);
```

- [ ] **Step 3: Resolve prompts in stopAgent()**

In `stopAgent()` (around line 226), BEFORE the agent status update, add:

```typescript
getDb()
  .prepare(
    `UPDATE permission_prompts SET status = 'resolved', resolved_at = datetime('now')
     WHERE agent_id = ? AND status = 'pending'`,
  )
  .run(agent.id);
```

- [ ] **Step 4: Fix resumeTask() session ID for --continue agents**

In `resumeTask()`, replace the `--continue` else branch (lines 302-304):

Before:
```typescript
const claudeCmd = agent.claude_session_id
  ? `claude --resume ${agent.claude_session_id}`
  : 'claude --continue';
```

After:
```typescript
let claudeCmd: string;
if (agent.claude_session_id) {
  claudeCmd = `claude --resume ${agent.claude_session_id}`;
} else {
  const newSessionId = crypto.randomUUID();
  claudeCmd = `claude --continue --session-id ${newSessionId}`;
  db.prepare('UPDATE agents SET claude_session_id = ? WHERE id = ?').run(newSessionId, agent.id);
}
```

Add `import crypto from 'crypto';` at the top if not already present (or use `crypto.randomUUID()` which is available in Node 19+).

- [ ] **Step 5: Install hooks in resumeTask()**

In `resumeTask()`, after verifying the worktree exists (around line 269), add:

```typescript
installHookSettings(task.worktree!);
```

This ensures worktrees created before this feature was deployed get hook settings on resume.

- [ ] **Step 6: Update addAgent() return to include hook_activity**

In `addAgent()` (around line 175), update the returned Agent object to include:

```typescript
hook_activity: 'active' as const,
hook_activity_updated_at: null,
```

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add server/task-runner.ts
git commit -m "feat(task-runner): install hooks in worktrees, resolve prompts on close/stop"
```

### Task 10: Task Runner Integration Tests

**Files:**
- Modify: `server/task-runner.test.ts`

- [ ] **Step 1: Add tests for hook installation and prompt resolution**

Add to existing test suite:

Note: task-runner tests already have a `db` variable from `createTestDb()` in `beforeEach`.
Use the existing test setup pattern (mock execFile, fs, etc.) from the test file.

```typescript
describe('hook integration', () => {
  it('startTask installs hook settings in worktree', async () => {
    // ... existing startTask test setup with mocked fs
    await startTask(task);
    // Verify writeFileSync was called with path containing '.claude/settings.local.json'
    // and content containing 'permission-request'
    const writeCall = vi.mocked(fs.writeFileSync).mock.calls.find(
      (call) => String(call[0]).includes('settings.local.json'),
    );
    expect(writeCall).toBeDefined();
    expect(String(writeCall![1])).toContain('permission-request');
  });

  it('closeTask resolves all pending permission prompts', async () => {
    insertPermissionPrompt(db, { id: 'pp1', task_id: task.id, agent_id: 'a1', status: 'pending' });
    insertPermissionPrompt(db, { id: 'pp2', task_id: task.id, agent_id: 'a1', status: 'pending' });

    await closeTask(task);

    const prompts = getPermissionPrompts(db, task.id);
    expect(prompts.every((p) => p.status === 'resolved')).toBe(true);
  });

  it('stopAgent resolves pending prompts for that agent only', async () => {
    insertAgent(db, { id: 'a2', task_id: task.id, window_index: 1 });
    insertPermissionPrompt(db, { id: 'pp1', task_id: task.id, agent_id: 'a1', status: 'pending' });
    insertPermissionPrompt(db, { id: 'pp2', task_id: task.id, agent_id: 'a2', status: 'pending' });

    await stopAgent(task, { id: 'a1', window_index: 0 } as Agent);

    const prompts = getPermissionPrompts(db, task.id);
    const pp1 = prompts.find((p) => p.id === 'pp1');
    const pp2 = prompts.find((p) => p.id === 'pp2');
    expect(pp1?.status).toBe('resolved');
    expect(pp2?.status).toBe('pending');
  });

  it('resumeTask generates session ID for --continue agents', async () => {
    // Insert agent without claude_session_id to trigger --continue path
    insertAgent(db, { id: 'a_noclaude', task_id: task.id, claude_session_id: null });

    await resumeTask({ ...task, status: 'closed' });

    const agent = db.prepare('SELECT claude_session_id FROM agents WHERE id = ?').get('a_noclaude') as { claude_session_id: string };
    expect(agent.claude_session_id).toBeTruthy();
    expect(agent.claude_session_id).toMatch(/^[0-9a-f-]{36}$/); // UUID format
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun run test server/task-runner.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/task-runner.test.ts
git commit -m "test(task-runner): add hook installation and prompt resolution tests"
```

---

## Chunk 4: API Response Updates

### Task 11: Update GET /api/tasks to Include Prompts + Derived Status

**Files:**
- Modify: `server/api.ts`

- [ ] **Step 1: Add derivedStatus helper function**

At the top of `api.ts` (after imports), add:

```typescript
import type { DerivedTaskStatus, HookActivity, PermissionPrompt, Task } from './types.js';

function derivedStatus(task: { status: string; agents: Array<{ status: string; hook_activity: string }> }): DerivedTaskStatus | null {
  if (task.status !== 'running') return null;
  const activities = task.agents
    .filter((a) => a.status !== 'stopped')
    .map((a) => a.hook_activity);
  if (activities.length === 0) return 'done';
  if (activities.includes('active')) return 'working';
  if (activities.includes('waiting')) return 'needs_attention';
  return 'done';
}
```

- [ ] **Step 2: Update GET /api/tasks handler**

In the tasks list handler (around line 175), after fetching agents per task, add:

```typescript
const pendingPrompts = getDb()
  .prepare(
    `SELECT pp.id, pp.agent_id, a.label as agent_label, pp.tool_name, pp.tool_input, pp.created_at
     FROM permission_prompts pp
     LEFT JOIN agents a ON pp.agent_id = a.id
     WHERE pp.task_id = ? AND pp.status = 'pending'
     ORDER BY pp.created_at ASC`,
  )
  .all(task.id) as Array<Record<string, unknown>>;
```

Parse `tool_input` from JSON string and add both `pending_prompts` and `derived_status` to the response:

```typescript
const parsedPrompts = pendingPrompts.map((pp) => ({
  ...pp,
  tool_input: JSON.parse((pp.tool_input as string) || '{}'),
}));

return {
  ...task,
  agents,
  pending_prompts: parsedPrompts,
  derived_status: derivedStatus({ status: task.status, agents }),
};
```

- [ ] **Step 3: Apply same changes to GET /api/tasks/:id handler**

Same pattern for the single task endpoint (around line 199).

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/api.ts
git commit -m "feat(api): add pending_prompts and derived_status to task responses"
```

### Task 12: API Response Tests

**Files:**
- Modify: `server/api.test.ts`

- [ ] **Step 1: Add tests for pending_prompts in task responses**

Note: api.test.ts already has a `db` variable from `createTestDb()` in `beforeEach`.

```typescript
describe('GET /api/tasks with permission prompts', () => {
  it('includes pending_prompts in task response', async () => {
    insertTask(db, { id: 't1', status: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1', claude_session_id: 'sess-1' });
    insertPermissionPrompt(db, {
      id: 'pp1',
      task_id: 't1',
      agent_id: 'a1',
      tool_name: 'Bash',
      tool_input: '{"command":"npm test"}',
    });

    const res = await request(app).get('/api/tasks').expect(200);
    const task = res.body[0];
    expect(task.pending_prompts).toHaveLength(1);
    expect(task.pending_prompts[0].tool_name).toBe('Bash');
    expect(task.pending_prompts[0].tool_input).toEqual({ command: 'npm test' });
    expect(task.pending_prompts[0].agent_label).toBe(DEFAULTS.agent.label);
  });

  it('does not include resolved prompts', async () => {
    insertTask(db, { id: 't1', status: 'running' });
    insertAgent(db, { id: 'a1', task_id: 't1' });
    insertPermissionPrompt(db, { id: 'pp1', task_id: 't1', agent_id: 'a1', status: 'resolved' });

    const res = await request(app).get('/api/tasks').expect(200);
    expect(res.body[0].pending_prompts).toHaveLength(0);
  });

  it.each([
    { activities: ['active'], expected: 'working' },
    { activities: ['waiting'], expected: 'needs_attention' },
    { activities: ['idle'], expected: 'done' },
    { activities: ['active', 'waiting'], expected: 'working' },
    { activities: ['idle', 'idle'], expected: 'done' },
  ])('derived_status is $expected when activities are $activities', async ({ activities, expected }) => {
    insertTask(db, { id: 't1', status: 'running' });
    activities.forEach((activity, i) => {
      insertAgent(db, {
        id: `a${i}`,
        task_id: 't1',
        window_index: i,
        hook_activity: activity,
      });
    });

    const res = await request(app).get('/api/tasks').expect(200);
    expect(res.body[0].derived_status).toBe(expected);
  });

  it('derived_status is null for non-running tasks', async () => {
    insertTask(db, { id: 't1', status: 'closed' });

    const res = await request(app).get('/api/tasks').expect(200);
    expect(res.body[0].derived_status).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `bun run test server/api.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add server/api.test.ts
git commit -m "test(api): add permission prompt and derived status response tests"
```

---

## Chunk 5: Frontend

### Task 13: AgentActivityDot Component

**Files:**
- Create: `src/components/AgentActivityDot.tsx`

- [ ] **Step 1: Create the component**

```tsx
import type { HookActivity } from '../../server/types';

const ACTIVITY_STYLES: Record<HookActivity, { dot: string; label: string }> = {
  active: { dot: 'bg-green-500', label: 'active' },
  idle: { dot: 'bg-zinc-400', label: 'idle' },
  waiting: { dot: 'bg-amber-500', label: 'waiting' },
};

export function AgentActivityDot({ activity }: { activity: HookActivity }) {
  const style = ACTIVITY_STYLES[activity] || ACTIVITY_STYLES.active;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-zinc-400">
      <span
        className={`inline-block h-2 w-2 rounded-full ${style.dot} ${activity === 'active' ? 'animate-pulse' : ''}`}
      />
      {style.label}
    </span>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/AgentActivityDot.tsx
git commit -m "feat(ui): add AgentActivityDot component"
```

### Task 14: PermissionPromptRow Component

**Files:**
- Create: `src/components/PermissionPromptRow.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useNavigate } from 'react-router';
import type { PermissionPrompt } from '../../server/types';

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function abbreviateInput(toolInput: Record<string, unknown>): string {
  const command = toolInput.command || toolInput.file_path || toolInput.pattern || '';
  const str = String(command);
  return str.length > 40 ? str.slice(0, 37) + '...' : str;
}

export function PermissionPromptRow({
  prompt,
  taskId,
}: {
  prompt: PermissionPrompt;
  taskId: string;
}) {
  const navigate = useNavigate();

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigate(`/tasks/${taskId}?agent=${prompt.agent_id}`);
  };

  return (
    <button
      onClick={handleClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-amber-400 hover:bg-amber-500/10"
    >
      <span className="text-amber-500">⚠</span>
      <span className="text-zinc-400">{prompt.agent_label}</span>
      <span className="font-medium">
        {prompt.tool_name} {abbreviateInput(prompt.tool_input)}
      </span>
      <span className="ml-auto text-zinc-500">{timeAgo(prompt.created_at)}</span>
    </button>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/PermissionPromptRow.tsx
git commit -m "feat(ui): add PermissionPromptRow component"
```

### Task 15: Update StatusBadge for Derived Status

**Files:**
- Modify: `src/components/StatusBadge.tsx`

- [ ] **Step 1: Add derived status styles**

Update the styles map to include `DerivedTaskStatus` values. The component should accept either a `TaskStatus` or `DerivedTaskStatus`:

Add new entries to the styles object:

```typescript
working: { bg: 'bg-green-500/20 text-green-400', dot: true },
needs_attention: { bg: 'bg-amber-500/20 text-amber-400', dot: true },
done: { bg: 'bg-blue-500/20 text-blue-400', dot: false },
```

Update the component props to accept `status: string` and display `needs_attention` as "needs attention" (replace underscore with space).

- [ ] **Step 2: Commit**

```bash
git add src/components/StatusBadge.tsx
git commit -m "feat(ui): add derived status styles to StatusBadge"
```

### Task 16: Update TaskCard with Prompts + Activity + Derived Status

**Files:**
- Modify: `src/components/TaskCard.tsx`

- [ ] **Step 1: Import new components**

```typescript
import { AgentActivityDot } from './AgentActivityDot';
import { PermissionPromptRow } from './PermissionPromptRow';
```

- [ ] **Step 2: Show derived status in badge**

Replace the status badge logic: when `task.derived_status` is not null, show it instead of `task.status`:

```tsx
<StatusBadge status={task.derived_status || task.status} />
```

- [ ] **Step 3: Add agent activity row**

After the existing task metadata (repo, branch), add an agent activity summary when the task has agents:

```tsx
{task.agents && task.agents.length > 0 && task.status === 'running' && (
  <div className="flex flex-wrap gap-3 text-xs">
    {task.agents
      .filter((a) => a.status !== 'stopped')
      .map((a) => (
        <span key={a.id} className="inline-flex items-center gap-1">
          <AgentActivityDot activity={a.hook_activity} />
          <span className="text-zinc-500">{a.label}</span>
        </span>
      ))}
  </div>
)}
```

- [ ] **Step 4: Add pending prompts section**

After the agent activity row, show pending prompts:

```tsx
{task.pending_prompts && task.pending_prompts.length > 0 && (
  <div className="mt-1 space-y-0.5">
    {task.pending_prompts.map((pp) => (
      <PermissionPromptRow key={pp.id} prompt={pp} taskId={task.id} />
    ))}
  </div>
)}
```

- [ ] **Step 5: Commit**

```bash
git add src/components/TaskCard.tsx
git commit -m "feat(ui): show agent activity, permission prompts, and derived status on task cards"
```

### Task 17: Update AgentTabs with Activity Dots

**Files:**
- Modify: `src/components/AgentTabs.tsx`

- [ ] **Step 1: Add activity indicator to agent tabs**

Import `AgentActivityDot` and add it next to each agent label in the tab:

```tsx
<AgentActivityDot activity={agent.hook_activity} />
```

Replace the existing green pulse dot (which was hardcoded for "running" status) with the `AgentActivityDot` which reflects the actual hook_activity state.

- [ ] **Step 2: Commit**

```bash
git add src/components/AgentTabs.tsx
git commit -m "feat(ui): show hook_activity on agent tabs"
```

### Task 18: Handle ?agent= Query Param in TaskDetail

**Files:**
- Modify: `src/pages/TaskDetail.tsx`

- [ ] **Step 1: Read agent query param and auto-select tab**

Add `useSearchParams` from react-router:

```typescript
import { useParams, useNavigate, useSearchParams } from 'react-router';
```

In the component, read the `agent` param and use it to set the active window:

```typescript
const [searchParams] = useSearchParams();
const agentParam = searchParams.get('agent');
```

In the useEffect that initializes activeWindow (around line 23), if `agentParam` is set, find the matching agent and set its window_index as active:

```typescript
useEffect(() => {
  if (agentParam && task?.agents) {
    const agent = task.agents.find((a) => a.id === agentParam);
    if (agent) {
      setActiveWindow(agent.window_index);
      return;
    }
  }
  // ... existing fallback logic
}, [task?.agents, agentParam]);
```

- [ ] **Step 2: Commit**

```bash
git add src/pages/TaskDetail.tsx
git commit -m "feat(ui): auto-select agent tab from ?agent= query param"
```

---

## Chunk 6: Final Verification

### Task 19: Lint, Format, Typecheck

- [ ] **Step 1: Run lint**

Run: `bun run lint:fix`

- [ ] **Step 2: Run format**

Run: `bun run format`

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS with no errors

- [ ] **Step 4: Fix any issues and commit**

```bash
git add -A
git commit -m "style: fix lint and formatting"
```

### Task 20: Run Full Test Suite

- [ ] **Step 1: Run all tests**

Run: `bun run test`
Expected: All tests PASS

- [ ] **Step 2: Fix any failures and commit**

If there are failures in existing tests due to the new `hook_activity` column or `pending_prompts` field, update the affected test assertions.

- [ ] **Step 3: Final commit if fixes needed**

```bash
git add -A
git commit -m "fix: update existing tests for permission tracking changes"
```
