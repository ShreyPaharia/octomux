# Harness Abstraction — Step 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a `Harness` interface and place Claude Code behind it as the
only implementation, with a security baseline (per-agent hook tokens,
command-injection validation, localhost bind, CORS denial) and a DB migration
(rename `claude_session_id` → `harness_session_id`, add `harness_id` to
`tasks` and `agents`, add `hook_token` to `agents`, relax
`permission_prompts.session_id` to nullable). Behavior for end users stays
the same except for the documented "Behavior changes in step 1" in the spec
(`spec/harness-abstraction.md`).

**Architecture:** New module `server/harnesses/` exports an explicit typed
registry (`getHarness(id)` / `listHarnesses()`) over a small `Harness`
interface. Claude-specific code from `task-runner.ts`, `chats.ts`,
`hook-settings.ts`, `agents.ts`, and `settings.ts` moves into
`server/harnesses/claude-code.ts`. The interface accommodates step 2's
Cursor harness (harness-issued session ids, script-bridge hooks) without
changes in step 2.

**Tech Stack:** TypeScript, better-sqlite3 (SQLite 3.49+), Express 5,
vitest, pino logger. ESM modules. See `CLAUDE.md` for conventions.

**Spec reference:** `spec/harness-abstraction.md` (the canonical design).

**Working assumptions about the codebase** (verify with the existing code,
do not rely on memory):

- `server/db.ts` already has helpers `addColumn(table, name, ddl, cols)` and
  `rebuildAgentsTable(instance)`. New migrations follow the existing
  idempotent-on-column-presence pattern.
- `server/test-helpers.ts` exports `createTestDb()`, `DEFAULTS`,
  `findExecCall`, `countExecCalls`. Reuse these — do not invent new helpers.
- All server logs go through `childLogger('<module>')`. Never use
  `console.*` inside `server/`.
- Commit message style is Conventional Commits with kebab-case scopes and
  100-char headers. **Never add `Co-Authored-By:` trailers** (user's global
  rule).
- Run `bun run typecheck && bun run test` (or scoped subsets) between
  every task.

---

## File structure (created or modified in step 1)

### New files

| Path                                   | Responsibility                                                       |
| -------------------------------------- | -------------------------------------------------------------------- |
| `server/harnesses/types.ts`            | `Harness` interface, `HarnessLaunchOpts`, `validateAgentName`        |
| `server/harnesses/registry.ts`         | `HARNESSES` map, `getHarness`, `listHarnesses`, `DEFAULT_HARNESS_ID` |
| `server/harnesses/claude-code.ts`      | The Claude Code `Harness` implementation                             |
| `server/harnesses/index.ts`            | Re-exports                                                           |
| `server/harnesses/registry.test.ts`    | Registry behavior tests                                              |
| `server/harnesses/claude-code.test.ts` | Command-string + validation tests for the Claude harness             |
| `server/security.test.ts`              | Host header + CORS + hook-token tests                                |
| `server/hook-base-url.ts`              | Exported `hookBaseUrl()` helper                                      |

### Modified files

| Path                                | Change                                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `server/types.ts`                   | Add `Task.harness_id`, `Agent.harness_id`, `Agent.hook_token`, rename `claude_session_id`       |
| `server/db.ts`                      | Migration: new columns, rename column, drop+create index, relax `permission_prompts.session_id` |
| `server/settings.ts`                | Split into per-harness map, deprecated-key fallback, tighten flag validation, validate env var  |
| `server/hook-settings.ts`           | Body migrates into Claude harness; `installHookSettings` becomes a thin dispatcher              |
| `server/agents.ts`                  | `syncAgents` becomes a thin dispatcher                                                          |
| `server/hooks.ts`                   | Column rename + token verification middleware/check on all routes                               |
| `server/task-runner.ts`             | `createTask`, `addAgent`, `moveAgentToTask` use harness dispatch; rename `sendClaudeCommand`    |
| `server/chats.ts`                   | Use harness dispatch (was missed in earlier drafts)                                             |
| `server/index.ts`                   | Bind `127.0.0.1`; mount Host-header and CORS-deny middleware                                    |
| `server/api.ts`                     | Validate `agent` field at API boundary (create-task, add-agent, create-chat routes)             |
| `server/test-helpers.ts`            | Update `DEFAULTS` and helpers for new columns                                                   |
| `server/task-runner.test.ts`        | Mechanical column renames in assertions                                                         |
| `server/chats.test.ts` (if present) | Same                                                                                            |
| `server/hooks.test.ts`              | Mechanical column rename + add token-required cases                                             |
| `server/db.test.ts`                 | Migration tests (idempotency, non-empty DB, pre-existing non-default value)                     |
| `server/settings.test.ts`           | Legacy migration cases, validateSettings dispatch                                               |
| `CLAUDE.md`                         | Add `server/harnesses/` to Architecture; note forward-only migration                            |

### Files that exist but are NOT modified in step 1

- `src/**/*` (frontend) — no UI changes in step 1.
- `server/skills.ts` — skills are already canonical; both Claude and Cursor read `~/.claude/skills/`.
- E2E tests — no E2E changes; existing tests must continue to pass unchanged.

---

## Task ordering rationale

DB migration and types come first so the rest of the work compiles and tests
can be written against the new shape. Validation helpers come second because
the Claude harness depends on them. The interface + registry come before the
implementation. Then the implementation. Then the call-site replacements.
Then hook token plumbing. Then security middleware. Then a final cleanup
pass.

Run tests after each task. If a task says "tests pass," verify by actually
running them — do not assume.

---

## Task 1: Add validation helpers in `server/harnesses/types.ts`

**Files:**

- Create: `server/harnesses/types.ts`

**Context:** The interface itself depends on `validateAgentName` and an
exported `validateFlagString` (which both the Claude harness and future
harnesses use). Create the file with helpers + interface signatures only.
The Claude impl lands in a later task.

- [ ] **Step 1.1: Write the file skeleton**

```ts
// server/harnesses/types.ts
import type { OctomuxSettings } from '../settings.js';

const AGENT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FLAG_FORBIDDEN_RE = /[`;|&><\n\r]|\$\(/;

/**
 * Validate a custom agent name. Returns the input unchanged if valid;
 * throws with a stable message otherwise. Used at the API boundary AND in
 * harness implementations (defense in depth).
 */
export function validateAgentName(name: string): string {
  if (!AGENT_NAME_RE.test(name)) {
    throw new Error(`Invalid agent name: ${JSON.stringify(name)}. Must match ${AGENT_NAME_RE}`);
  }
  return name;
}

/**
 * Validate a flag string for shell-injection metacharacters. Reuses the
 * existing rules from `server/settings.ts::validateClaudeFlags` and adds
 * `;`, `|`, `&`, `>`, `<`, `\n`, `\r`.
 */
export function validateFlagString(flags: string, fieldName: string): string {
  if (typeof flags !== 'string') {
    throw new Error(`Invalid ${fieldName}: must be a string`);
  }
  const trimmed = flags.trim();
  if (FLAG_FORBIDDEN_RE.test(trimmed)) {
    throw new Error(
      `Invalid ${fieldName}: contains forbidden shell metacharacter (one of \` ; | & > < $( or newline)`,
    );
  }
  const singleQuotes = (trimmed.match(/'/g) ?? []).length;
  const doubleQuotes = (trimmed.match(/"/g) ?? []).length;
  if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) {
    throw new Error(`Invalid ${fieldName}: unbalanced quotes`);
  }
  return trimmed;
}

export interface HarnessLaunchOpts {
  sessionId: string;
  agent?: string | null;
  flags?: string;
}

export interface HarnessResumeOpts {
  sessionId: string;
  flags?: string;
}

export interface Harness {
  readonly id: string;
  readonly displayName: string;
  readonly sessionIdMode: 'orchestrator-assigned' | 'harness-issued';

  newSessionId(): string;
  buildLaunchCommand(opts: HarnessLaunchOpts): string;
  buildResumeCommand(opts: HarnessResumeOpts): string;
  buildContinueCommand(opts: HarnessResumeOpts): string | null;
  installHooks(worktreePath: string, baseUrl: string, hookToken: string): Promise<void>;
  syncAgents(worktreePath: string): Promise<void>;
  resolveFlags(settings: OctomuxSettings): string;
  validateSettings(blob: unknown): Record<string, unknown>;
  validateAgentName(name: string): string;
}
```

- [ ] **Step 1.2: Write tests**

Create `server/harnesses/types.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateAgentName, validateFlagString } from './types.js';

describe('validateAgentName', () => {
  it.each([
    ['orchestrator', 'orchestrator'],
    ['plan-week', 'plan-week'],
    ['Agent_42', 'Agent_42'],
  ])('accepts %s', (input, expected) => {
    expect(validateAgentName(input)).toBe(expected);
  });

  it.each(['', 'has space', 'foo;rm -rf /', '../../../etc', 'a'.repeat(65), '$(whoami)'])(
    'rejects %s',
    (input) => {
      expect(() => validateAgentName(input)).toThrow(/Invalid agent name/);
    },
  );
});

describe('validateFlagString', () => {
  it.each(['', '--verbose', '--model claude-opus-4-7', "--prompt 'hello world'"])(
    'accepts %s',
    (input) => {
      expect(validateFlagString(input, 'flags')).toBe(input.trim());
    },
  );

  it.each([
    '`whoami`',
    '$(whoami)',
    '--verbose; rm -rf /',
    '| cat',
    '&& evil',
    '> /etc/passwd',
    'foo\nbar',
    "--unbalanced 'quote",
  ])('rejects %s', (input) => {
    expect(() => validateFlagString(input, 'flags')).toThrow(/Invalid flags/);
  });
});
```

- [ ] **Step 1.3: Run tests**

```
bun run test -- server/harnesses/types.test.ts
```

Expected: all pass.

- [ ] **Step 1.4: Commit**

```
git add server/harnesses/types.ts server/harnesses/types.test.ts
git commit -m "feat(harnesses): add Harness interface and validation helpers"
```

---

## Task 2: Add `hookBaseUrl()` helper

**Files:**

- Create: `server/hook-base-url.ts`
- Create: `server/hook-base-url.test.ts`

**Context:** `server/hook-settings.ts:122` defines a private `hookPort()`.
Extract it so every harness receives `baseUrl` as a parameter, not via env
peeking. The server binds to `127.0.0.1` (Task 15), so the URL should use
that explicitly rather than `localhost`.

- [ ] **Step 2.1: Write the test first**

```ts
// server/hook-base-url.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { hookBaseUrl } from './hook-base-url.js';

describe('hookBaseUrl', () => {
  const original = { ...process.env };
  beforeEach(() => {
    delete process.env.OCTOMUX_PORT;
    delete process.env.PORT;
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it('defaults to 127.0.0.1:7777', () => {
    expect(hookBaseUrl()).toBe('http://127.0.0.1:7777');
  });

  it('honors OCTOMUX_PORT', () => {
    process.env.OCTOMUX_PORT = '9999';
    expect(hookBaseUrl()).toBe('http://127.0.0.1:9999');
  });

  it('honors PORT when OCTOMUX_PORT is absent', () => {
    process.env.PORT = '8080';
    expect(hookBaseUrl()).toBe('http://127.0.0.1:8080');
  });

  it('OCTOMUX_PORT wins over PORT', () => {
    process.env.OCTOMUX_PORT = '9999';
    process.env.PORT = '8080';
    expect(hookBaseUrl()).toBe('http://127.0.0.1:9999');
  });
});
```

- [ ] **Step 2.2: Run test (should fail — module missing)**

```
bun run test -- server/hook-base-url.test.ts
```

Expected: FAIL with module-not-found.

- [ ] **Step 2.3: Implement**

```ts
// server/hook-base-url.ts
/**
 * Local base URL the server listens on for hook callbacks. Used by
 * harness `installHooks` implementations. Honors `OCTOMUX_PORT` then
 * `PORT`, defaulting to 7777.
 */
export function hookBaseUrl(): string {
  const port = process.env.OCTOMUX_PORT || process.env.PORT || 7777;
  return `http://127.0.0.1:${port}`;
}
```

- [ ] **Step 2.4: Run test (should pass)**

```
bun run test -- server/hook-base-url.test.ts
```

Expected: PASS.

- [ ] **Step 2.5: Commit**

```
git add server/hook-base-url.ts server/hook-base-url.test.ts
git commit -m "feat(server): extract hookBaseUrl helper bound to 127.0.0.1"
```

---

## Task 3: DB migration — add `harness_id` columns and `hook_token`

**Files:**

- Modify: `server/db.ts` (around line 307 where other `addColumn` calls live)
- Modify: `server/db.test.ts`

**Context:** Use the existing `addColumn` helper (idempotent on column
presence). New columns have safe defaults so existing rows backfill.

- [ ] **Step 3.1: Add migration code**

In `server/db.ts`, locate the block around line 307 (after
`addColumn('agents', 'claude_session_id', ...)`). Add the new columns. Note
the existing structure uses `taskCols` set at line 304 and `agentCols` set
at line 306.

Insert after line 309 (after the existing `hook_activity_updated_at` add):

```ts
addColumn('agents', 'harness_id', `harness_id TEXT NOT NULL DEFAULT 'claude-code'`, agentCols);
addColumn('agents', 'hook_token', `hook_token TEXT NOT NULL DEFAULT ''`, agentCols);
```

Locate where `taskCols` is used (around line 435 where `addColumn('tasks', 'agent', ...)` lives). Add:

```ts
addColumn(
  'tasks',
  'harness_id',
  `harness_id TEXT NOT NULL DEFAULT 'claude-code'`,
  taskColsForAgent,
);
```

(Use whichever `taskCols*` set is in scope at that point. If unclear, place
it right after the `agent` column add — it shares the same set lifecycle.)

- [ ] **Step 3.2: Write migration tests in `server/db.test.ts`**

Add to the existing test file:

```ts
describe('harness step-1 migration', () => {
  it('adds harness_id to tasks with default claude-code', () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO tasks (id, title, description, repo_path, status, created_at, updated_at, source)
       VALUES ('t1', 'Test', '', '/tmp/repo', 'draft', datetime('now'), datetime('now'), NULL)`,
    ).run();
    const row = db.prepare(`SELECT harness_id FROM tasks WHERE id = ?`).get('t1') as {
      harness_id: string;
    };
    expect(row.harness_id).toBe('claude-code');
  });

  it('adds harness_id and hook_token to agents with defaults', () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO agents (id, task_id, window_index, label, claude_session_id, agent)
       VALUES ('a1', NULL, 0, 'Agent 1', 'old-session-uuid', NULL)`,
    ).run();
    const row = db.prepare(`SELECT harness_id, hook_token FROM agents WHERE id = ?`).get('a1') as {
      harness_id: string;
      hook_token: string;
    };
    expect(row.harness_id).toBe('claude-code');
    expect(row.hook_token).toBe('');
  });

  it('is idempotent (running migration twice is a no-op)', () => {
    const db = createTestDb();
    // initDb already ran once during createTestDb; re-run it.
    initDb(db);
    initDb(db);
    const cols = db.pragma('table_info(agents)') as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names.filter((n) => n === 'harness_id')).toHaveLength(1);
    expect(names.filter((n) => n === 'hook_token')).toHaveLength(1);
  });

  it('preserves a pre-existing non-default harness_id', () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO tasks (id, title, description, repo_path, status, created_at, updated_at, source, harness_id)
       VALUES ('t2', 'Test', '', '/tmp/repo', 'draft', datetime('now'), datetime('now'), NULL, 'cursor')`,
    ).run();
    initDb(db); // re-run
    const row = db.prepare(`SELECT harness_id FROM tasks WHERE id = ?`).get('t2') as {
      harness_id: string;
    };
    expect(row.harness_id).toBe('cursor');
  });
});
```

- [ ] **Step 3.3: Run tests**

```
bun run test -- server/db.test.ts
```

Expected: PASS.

- [ ] **Step 3.4: Commit**

```
git add server/db.ts server/db.test.ts
git commit -m "feat(db): add harness_id to tasks and agents, hook_token to agents"
```

---

## Task 4: DB migration — rename `claude_session_id` → `harness_session_id`

**Files:**

- Modify: `server/db.ts`
- Modify: `server/db.ts:307` — the existing
  `addColumn('agents', 'claude_session_id', ...)` line
- Modify: `server/db.ts:202` (`rebuildAgentsTable`) — index recreation
- Modify: `server/db.test.ts`

**Context:** `ALTER TABLE ... RENAME COLUMN` is supported on the bundled
SQLite. Gate the rename on column presence so it runs once. Also update the
existing `claude_session_id` references so a future rebuild doesn't
resurrect the old name.

- [ ] **Step 4.1: Add rename migration after the column additions from Task 3**

In `server/db.ts`, after the new `addColumn` lines from Task 3, add:

```ts
// Rename agents.claude_session_id -> agents.harness_session_id (step-1 of
// the harness abstraction). Idempotent: only runs when the old column
// still exists. SQLite 3.25+ supports RENAME COLUMN.
if (agentCols.has('claude_session_id') && !agentCols.has('harness_session_id')) {
  instance.exec(`ALTER TABLE agents RENAME COLUMN claude_session_id TO harness_session_id`);
  instance.exec(`DROP INDEX IF EXISTS idx_agents_claude_session_id`);
  instance.exec(
    `CREATE INDEX IF NOT EXISTS idx_agents_harness_session_id ON agents(harness_session_id)`,
  );
  agentCols.delete('claude_session_id');
  agentCols.add('harness_session_id');
}
```

- [ ] **Step 4.2: Update the `addColumn` line so fresh DBs use the new name**

Change `server/db.ts:307` from:

```ts
addColumn('agents', 'claude_session_id', 'claude_session_id TEXT', agentCols);
```

to:

```ts
// Kept under the old DDL string so older databases also gain the column
// before the rename block below promotes it. New databases get
// harness_session_id directly via SCHEMA (see top of file).
addColumn('agents', 'harness_session_id', 'harness_session_id TEXT', agentCols);
```

Also update the `SCHEMA` constant near the top of the file. Find the
`CREATE TABLE IF NOT EXISTS agents` block (around line 56) and change
`claude_session_id TEXT,` to `harness_session_id TEXT,`. Update the index
at line 96 from `idx_agents_claude_session_id ON agents(claude_session_id)`
to `idx_agents_harness_session_id ON agents(harness_session_id)`.

- [ ] **Step 4.3: Update `rebuildAgentsTable` (line 202)**

In `server/db.ts`, locate `rebuildAgentsTable`. The function at line 174
references `claude_session_id`. Update both the column-list comprehension
and the index recreation at line 246 to use `harness_session_id`. Search
for any other references to `claude_session_id` in the file and update them.

```
grep -n claude_session_id server/db.ts
```

Expected after the edit: no matches.

- [ ] **Step 4.4: Write the rename test**

In `server/db.test.ts`:

```ts
describe('claude_session_id rename', () => {
  it('renames the column on an existing DB with old column', () => {
    // Simulate a pre-rename DB by manually creating the old schema.
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, description TEXT,
        repo_path TEXT, status TEXT, created_at TEXT, updated_at TEXT, source TEXT);
      CREATE TABLE agents (id TEXT PRIMARY KEY, task_id TEXT, window_index INTEGER,
        label TEXT, status TEXT DEFAULT 'running', claude_session_id TEXT,
        hook_activity TEXT NOT NULL DEFAULT 'active', hook_activity_updated_at TEXT,
        agent TEXT, tmux_session TEXT, created_at TEXT);
      CREATE INDEX idx_agents_claude_session_id ON agents(claude_session_id);
    `);
    db.prepare(
      `INSERT INTO agents (id, task_id, window_index, label, claude_session_id)
       VALUES ('a1', NULL, 0, 'Agent 1', 'old-uuid')`,
    ).run();

    initDb(db);

    const cols = db.pragma('table_info(agents)') as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('harness_session_id');
    expect(names).not.toContain('claude_session_id');

    const row = db.prepare(`SELECT harness_session_id FROM agents WHERE id = ?`).get('a1') as {
      harness_session_id: string;
    };
    expect(row.harness_session_id).toBe('old-uuid');

    const indexes = db.pragma('index_list(agents)') as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain('idx_agents_harness_session_id');
    expect(indexes.map((i) => i.name)).not.toContain('idx_agents_claude_session_id');
  });
});
```

(Import `Database` from `better-sqlite3` at the top of the test file if not
already.)

- [ ] **Step 4.5: Run tests**

```
bun run test -- server/db.test.ts
```

Expected: PASS.

- [ ] **Step 4.6: Commit**

```
git add server/db.ts server/db.test.ts
git commit -m "feat(db): rename agents.claude_session_id to harness_session_id"
```

---

## Task 5: DB migration — relax `permission_prompts.session_id` to nullable

**Files:**

- Modify: `server/db.ts`
- Modify: `server/db.test.ts`

**Context:** The current schema has `permission_prompts.session_id TEXT NOT
NULL` (line 104). Step 2 (Cursor, harness-issued sessions) can create a
prompt before the session id is bound, which violates NOT NULL. Relax it
via a table-rebuild (the only safe way to drop a NOT NULL constraint in
SQLite).

- [ ] **Step 5.1: Add the migration block**

After the rename block from Task 4, in `server/db.ts`:

```ts
// Relax permission_prompts.session_id from NOT NULL to nullable.
// Required for step 2 (harness-issued session ids). Idempotent: gated
// on column nullability via PRAGMA.
const ppCols = instance.pragma('table_info(permission_prompts)') as Array<{
  name: string;
  notnull: number;
}>;
const sidCol = ppCols.find((c) => c.name === 'session_id');
if (sidCol && sidCol.notnull === 1) {
  instance
    .transaction(() => {
      instance.exec(`ALTER TABLE permission_prompts RENAME TO permission_prompts_old`);
      instance.exec(`
          CREATE TABLE permission_prompts (
            id TEXT PRIMARY KEY,
            task_id TEXT,
            agent_id TEXT,
            agent_label TEXT NOT NULL,
            session_id TEXT,
            tool_name TEXT NOT NULL,
            tool_input TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            resolved_at TEXT,
            FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
            FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL
          )
        `);
      instance.exec(`INSERT INTO permission_prompts SELECT * FROM permission_prompts_old`);
      instance.exec(`DROP TABLE permission_prompts_old`);
      instance.exec(
        `CREATE INDEX IF NOT EXISTS idx_permission_prompts_task_id ON permission_prompts(task_id)`,
      );
      instance.exec(
        `CREATE INDEX IF NOT EXISTS idx_permission_prompts_status ON permission_prompts(status)`,
      );
      instance.exec(
        `CREATE INDEX IF NOT EXISTS idx_permission_prompts_agent_status ON permission_prompts(agent_id, status)`,
      );
      instance.exec(
        `CREATE INDEX IF NOT EXISTS idx_permission_prompts_agent_status_created ON permission_prompts(agent_id, status, created_at)`,
      );
    })
    .default();
}
```

**IMPORTANT:** Verify the exact column list and FK clauses against the
current `permission_prompts` CREATE TABLE (around line 100 of db.ts). The
list above must match. If the current table has columns or constraints
this plan doesn't show, port them faithfully. Run `grep -n
permission_prompts server/db.ts` to confirm.

Also update the `SCHEMA` constant: change `session_id TEXT NOT NULL` to
`session_id TEXT` so fresh DBs are created with the relaxed shape.

- [ ] **Step 5.2: Write a test**

```ts
it('relaxes permission_prompts.session_id to nullable', () => {
  const db = createTestDb();
  const cols = db.pragma('table_info(permission_prompts)') as Array<{
    name: string;
    notnull: number;
  }>;
  const sid = cols.find((c) => c.name === 'session_id');
  expect(sid?.notnull).toBe(0);
});

it('preserves existing permission_prompts rows across the relax migration', () => {
  // Simulate a pre-migration DB by creating the table with NOT NULL.
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE permission_prompts (
      id TEXT PRIMARY KEY, task_id TEXT, agent_id TEXT,
      agent_label TEXT NOT NULL, session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL, tool_input TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), resolved_at TEXT
    );
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, description TEXT,
      repo_path TEXT, status TEXT, created_at TEXT, updated_at TEXT, source TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY);
  `);
  db.prepare(
    `INSERT INTO permission_prompts (id, task_id, agent_id, agent_label, session_id, tool_name, tool_input)
     VALUES ('p1', NULL, NULL, 'Agent 1', 'sess-1', 'Bash', '{}')`,
  ).run();
  initDb(db);
  const row = db.prepare(`SELECT session_id FROM permission_prompts WHERE id = ?`).get('p1') as {
    session_id: string;
  };
  expect(row.session_id).toBe('sess-1');
});
```

- [ ] **Step 5.3: Run tests**

```
bun run test -- server/db.test.ts
```

Expected: PASS.

- [ ] **Step 5.4: Commit**

```
git add server/db.ts server/db.test.ts
git commit -m "feat(db): relax permission_prompts.session_id to nullable"
```

---

## Task 6: Update `server/types.ts` with new fields

**Files:**

- Modify: `server/types.ts`

**Context:** Strict typescript will fail until the types match the new
columns. Update before touching call sites.

- [ ] **Step 6.1: Edit the Task and Agent interfaces**

In `server/types.ts`:

In the `Task` interface, add at the end (before `created_at`/`updated_at`):

```ts
harness_id: string;
```

In the `Agent` interface, replace:

```ts
claude_session_id: string | null;
```

with:

```ts
harness_id: string;
harness_session_id: string | null;
/** Per-agent token used to authenticate hook callbacks. */
hook_token: string;
```

- [ ] **Step 6.2: Typecheck (will fail at many call sites)**

```
bun run typecheck
```

Expected: many errors referencing `claude_session_id` and missing
`harness_id`. **Do not fix them yet** — subsequent tasks address them
deliberately. The typecheck error list is useful as a checklist.

Save the error list:

```
bun run typecheck 2>&1 | tee /tmp/typecheck-after-task-6.txt
```

- [ ] **Step 6.3: Commit (broken state intentional)**

```
git add server/types.ts
git commit -m "refactor(types): rename claude_session_id, add harness_id and hook_token

Type changes only; call sites updated in subsequent commits."
```

---

## Task 7: Implement `claudeCodeHarness` (commands + new-session-id)

**Files:**

- Create: `server/harnesses/claude-code.ts`
- Create: `server/harnesses/claude-code.test.ts`

**Context:** Port the command-building logic from `task-runner.ts:643,
715, 1149, 1153, 1294, 1297` into a single Harness implementation. The
`installHooks` / `syncAgents` / `resolveFlags` methods will be filled in in
later tasks; for this task, stub them with `throw new Error('not yet
ported')`.

- [ ] **Step 7.1: Write the test**

```ts
// server/harnesses/claude-code.test.ts
import { describe, it, expect } from 'vitest';
import { claudeCodeHarness } from './claude-code.js';

describe('claudeCodeHarness', () => {
  it('has stable id and display name', () => {
    expect(claudeCodeHarness.id).toBe('claude-code');
    expect(claudeCodeHarness.displayName).toBe('Claude Code');
    expect(claudeCodeHarness.sessionIdMode).toBe('orchestrator-assigned');
  });

  it('newSessionId returns a UUID', () => {
    const id = claudeCodeHarness.newSessionId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  describe('buildLaunchCommand', () => {
    it.each([
      [{ sessionId: 's1' }, 'claude --session-id s1'],
      [{ sessionId: 's1', agent: null }, 'claude --session-id s1'],
      [{ sessionId: 's1', agent: 'orchestrator' }, 'claude --agent orchestrator --session-id s1'],
      [{ sessionId: 's1', flags: ' --verbose' }, 'claude --session-id s1 --verbose'],
      [
        { sessionId: 's1', agent: 'planner', flags: ' --verbose' },
        'claude --agent planner --session-id s1 --verbose',
      ],
    ])('builds %j -> %s', (opts, expected) => {
      expect(claudeCodeHarness.buildLaunchCommand(opts)).toBe(expected);
    });

    it('rejects bad agent names', () => {
      expect(() =>
        claudeCodeHarness.buildLaunchCommand({ sessionId: 's1', agent: 'evil; rm' }),
      ).toThrow(/Invalid agent name/);
    });
  });

  describe('buildResumeCommand', () => {
    it.each([
      [{ sessionId: 's1' }, 'claude --resume s1'],
      [{ sessionId: 's1', flags: ' --verbose' }, 'claude --resume s1 --verbose'],
    ])('builds %j -> %s', (opts, expected) => {
      expect(claudeCodeHarness.buildResumeCommand(opts)).toBe(expected);
    });
  });

  describe('buildContinueCommand', () => {
    it('builds with --continue and a fresh session id', () => {
      expect(claudeCodeHarness.buildContinueCommand({ sessionId: 's1' })).toBe(
        'claude --continue --session-id s1',
      );
    });

    it('appends flags', () => {
      expect(claudeCodeHarness.buildContinueCommand({ sessionId: 's1', flags: ' --verbose' })).toBe(
        'claude --continue --session-id s1 --verbose',
      );
    });
  });
});
```

- [ ] **Step 7.2: Run test (should fail — module missing)**

```
bun run test -- server/harnesses/claude-code.test.ts
```

- [ ] **Step 7.3: Implement (commands only; other methods stubbed)**

```ts
// server/harnesses/claude-code.ts
import crypto from 'crypto';
import type { Harness, HarnessLaunchOpts, HarnessResumeOpts } from './types.js';
import { validateAgentName } from './types.js';
import type { OctomuxSettings } from '../settings.js';

export const claudeCodeHarness: Harness = {
  id: 'claude-code',
  displayName: 'Claude Code',
  sessionIdMode: 'orchestrator-assigned',

  newSessionId() {
    return crypto.randomUUID();
  },

  buildLaunchCommand({ sessionId, agent, flags = '' }: HarnessLaunchOpts): string {
    const agentPart = agent ? ` --agent ${validateAgentName(agent)}` : '';
    return `claude${agentPart} --session-id ${sessionId}${flags}`;
  },

  buildResumeCommand({ sessionId, flags = '' }: HarnessResumeOpts): string {
    return `claude --resume ${sessionId}${flags}`;
  },

  buildContinueCommand({ sessionId, flags = '' }: HarnessResumeOpts): string {
    return `claude --continue --session-id ${sessionId}${flags}`;
  },

  async installHooks(_worktreePath: string, _baseUrl: string, _hookToken: string) {
    throw new Error('claudeCodeHarness.installHooks not yet ported');
  },

  async syncAgents(_worktreePath: string) {
    throw new Error('claudeCodeHarness.syncAgents not yet ported');
  },

  resolveFlags(_settings: OctomuxSettings): string {
    throw new Error('claudeCodeHarness.resolveFlags not yet ported');
  },

  validateSettings(_blob: unknown): Record<string, unknown> {
    throw new Error('claudeCodeHarness.validateSettings not yet ported');
  },

  validateAgentName(name: string): string {
    return validateAgentName(name);
  },
};
```

- [ ] **Step 7.4: Run test**

```
bun run test -- server/harnesses/claude-code.test.ts
```

Expected: PASS.

- [ ] **Step 7.5: Commit**

```
git add server/harnesses/claude-code.ts server/harnesses/claude-code.test.ts
git commit -m "feat(harnesses): claude-code launch/resume/continue commands"
```

---

## Task 8: Create the registry

**Files:**

- Create: `server/harnesses/registry.ts`
- Create: `server/harnesses/registry.test.ts`
- Create: `server/harnesses/index.ts`

- [ ] **Step 8.1: Write the test**

```ts
// server/harnesses/registry.test.ts
import { describe, it, expect } from 'vitest';
import { getHarness, listHarnesses, DEFAULT_HARNESS_ID } from './registry.js';

describe('registry', () => {
  it('returns claude-code by id', () => {
    const h = getHarness('claude-code');
    expect(h.id).toBe('claude-code');
  });

  it('returns the default when id is null/undefined', () => {
    expect(getHarness(null).id).toBe(DEFAULT_HARNESS_ID);
    expect(getHarness(undefined).id).toBe(DEFAULT_HARNESS_ID);
  });

  it('throws on unknown id', () => {
    expect(() => getHarness('nonexistent')).toThrow(/Unknown harness/);
  });

  it('lists registered harnesses', () => {
    const ids = listHarnesses().map((h) => h.id);
    expect(ids).toContain('claude-code');
  });
});
```

- [ ] **Step 8.2: Run test (should fail)**

```
bun run test -- server/harnesses/registry.test.ts
```

- [ ] **Step 8.3: Implement**

```ts
// server/harnesses/registry.ts
import { claudeCodeHarness } from './claude-code.js';
import type { Harness } from './types.js';

const HARNESSES = new Map<string, Harness>([[claudeCodeHarness.id, claudeCodeHarness]]);

export const DEFAULT_HARNESS_ID = claudeCodeHarness.id;

export function getHarness(id: string | null | undefined): Harness {
  const key = id ?? DEFAULT_HARNESS_ID;
  const h = HARNESSES.get(key);
  if (!h) throw new Error(`Unknown harness: ${key}`);
  return h;
}

export function listHarnesses(): Harness[] {
  return Array.from(HARNESSES.values());
}
```

```ts
// server/harnesses/index.ts
export * from './types.js';
export * from './registry.js';
export { claudeCodeHarness } from './claude-code.js';
```

- [ ] **Step 8.4: Run test**

Expected: PASS.

- [ ] **Step 8.5: Commit**

```
git add server/harnesses/registry.ts server/harnesses/registry.test.ts server/harnesses/index.ts
git commit -m "feat(harnesses): typed registry with getHarness and listHarnesses"
```

---

## Task 9: Port `installHooks` into the Claude harness (with token)

**Files:**

- Modify: `server/harnesses/claude-code.ts` (replace the stub)
- Modify: `server/hook-settings.ts` (move body out; keep a thin wrapper)
- Add tests in `server/harnesses/claude-code.test.ts`

**Context:** The body of `installHookSettings()` in
`server/hook-settings.ts` moves into the harness. Hook URLs now carry the
per-agent token as a query parameter (`?token=<token>`), so each callback
can be authenticated. The existing `ALLOWED_TOOLS`/`DENIED_TOOLS` and
permissions-merging behavior moves with it.

Claude's HTTP hook config accepts a URL string per event; the simplest
auth carrier is a query param on the URL (a header would be cleaner but
Claude's HTTP hook config does not currently expose request-header
configuration). Verify against Claude Code's hook docs during impl. If
header support is available, prefer header.

- [ ] **Step 9.1: Move the file's exports into the harness**

In `server/harnesses/claude-code.ts`, replace the `installHooks` stub.
Import `path`, `fs` at the top.

```ts
import fs from 'fs';
import path from 'path';

// Hook events for Claude Code — moved from server/hook-settings.ts.
function buildHookEvents(baseUrl: string, token: string) {
  const url = (event: string) => `${baseUrl}/api/hooks/${event}?token=${encodeURIComponent(token)}`;
  return {
    UserPromptSubmit: [{ hooks: [{ type: 'http', url: url('user-prompt-submit'), timeout: 5 }] }],
    PermissionRequest: [{ hooks: [{ type: 'http', url: url('permission-request'), timeout: 5 }] }],
    PostToolUse: [{ hooks: [{ type: 'http', url: url('post-tool-use'), timeout: 5 }] }],
    Stop: [{ hooks: [{ type: 'http', url: url('stop'), timeout: 5 }] }],
  };
}
```

Replace `installHooks` with the ported body:

```ts
async installHooks(worktreePath: string, baseUrl: string, hookToken: string) {
  const { ALLOWED_TOOLS, DENIED_TOOLS } = await import('../hook-settings.js');
  const claudeDir = path.join(worktreePath, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.local.json');
  fs.mkdirSync(claudeDir, { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    existing = JSON.parse(raw);
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      existing = {};
    }
  } catch {
    existing = {};
  }

  const existingHooks =
    typeof existing.hooks === 'object' && existing.hooks !== null && !Array.isArray(existing.hooks)
      ? (existing.hooks as Record<string, unknown>)
      : {};
  const mergedHooks = { ...existingHooks, ...buildHookEvents(baseUrl, hookToken) };

  const existingPerms =
    typeof existing.permissions === 'object' &&
    existing.permissions !== null &&
    !Array.isArray(existing.permissions)
      ? (existing.permissions as Record<string, unknown>)
      : {};
  const existingAllow = Array.isArray(existingPerms.allow) ? (existingPerms.allow as string[]) : [];
  const mergedAllow = [...new Set([...ALLOWED_TOOLS, ...existingAllow])];
  const existingDeny = Array.isArray(existingPerms.deny) ? (existingPerms.deny as string[]) : [];
  const mergedDeny = [...new Set([...DENIED_TOOLS, ...existingDeny])];
  const mergedPermissions = { ...existingPerms, allow: mergedAllow, deny: mergedDeny };

  const merged = { ...existing, permissions: mergedPermissions, hooks: mergedHooks };
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
},
```

- [ ] **Step 9.2: Modify `server/hook-settings.ts`**

`ALLOWED_TOOLS` and `DENIED_TOOLS` arrays stay (they are read by the
harness). Replace `installHookSettings` and `buildHookEvents`, `hookPort`
with a thin dispatcher:

```ts
// server/hook-settings.ts (after the ALLOWED_TOOLS/DENIED_TOOLS arrays)
import { hookBaseUrl } from './hook-base-url.js';
import { getHarness } from './harnesses/index.js';

/**
 * Install hook settings into a worktree. Dispatches to the per-task harness.
 * The legacy signature (single arg) is kept for callers that haven't been
 * updated yet (Claude default + no token); callers should be updated to
 * pass `harnessId` and `hookToken` explicitly.
 */
export async function installHookSettings(
  worktreePath: string,
  harnessId: string = 'claude-code',
  hookToken: string = '',
): Promise<void> {
  await getHarness(harnessId).installHooks(worktreePath, hookBaseUrl(), hookToken);
}
```

Remove the now-unused `buildHookEvents` and `hookPort`. **Do not** remove
`ALLOWED_TOOLS`/`DENIED_TOOLS` — the harness imports them.

- [ ] **Step 9.3: Add a test for the harness method**

```ts
// In server/harnesses/claude-code.test.ts
import os from 'os';
import path from 'path';
import fs from 'fs';

describe('claudeCodeHarness.installHooks', () => {
  it('writes settings.local.json with token in URLs', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-harness-'));
    await claudeCodeHarness.installHooks(tmp, 'http://127.0.0.1:7777', 'tok-abc');
    const written = JSON.parse(
      fs.readFileSync(path.join(tmp, '.claude', 'settings.local.json'), 'utf-8'),
    );
    expect(written.hooks.Stop[0].hooks[0].url).toBe(
      'http://127.0.0.1:7777/api/hooks/stop?token=tok-abc',
    );
    expect(written.permissions.allow).toContain('Read');
  });
});
```

- [ ] **Step 9.4: Run tests**

```
bun run test -- server/harnesses/claude-code.test.ts server/hook-settings.test.ts
```

Existing tests in `server/hook-settings.test.ts` may assert URLs without
token. Update them to expect a token query param, passing an empty token
(`''`) via the wrapper for backward-compatible cases, OR mark the test
"awaits update in task 12" and skip with `it.skip` plus a comment
referencing this plan.

- [ ] **Step 9.5: Commit**

```
git add server/harnesses/claude-code.ts server/harnesses/claude-code.test.ts server/hook-settings.ts server/hook-settings.test.ts
git commit -m "refactor(harnesses): port installHooks to claudeCodeHarness with per-agent token"
```

---

## Task 10: Port `syncAgents` into the Claude harness

**Files:**

- Modify: `server/harnesses/claude-code.ts`
- Modify: `server/agents.ts` (the existing `syncAgents` function stays as a thin dispatcher)

- [ ] **Step 10.1: Replace the stub in `claude-code.ts`**

```ts
async syncAgents(worktreePath: string) {
  const { listAgents, getAgent } = await import('../agents.js');
  const targetDir = path.join(worktreePath, '.claude', 'agents');
  await fs.promises.mkdir(targetDir, { recursive: true });

  const agents = await listAgents();
  for (const def of agents) {
    const agent = await getAgent(def.name);
    await fs.promises.writeFile(
      path.join(targetDir, `${def.name}.md`),
      agent.content,
      'utf-8',
    );
  }
},
```

- [ ] **Step 10.2: Update `server/agents.ts::syncAgents` to delegate**

In `server/agents.ts`, replace the body of `syncAgents`:

```ts
export async function syncAgents(cwd?: string): Promise<void> {
  const { claudeCodeHarness } = await import('./harnesses/claude-code.js');
  await claudeCodeHarness.syncAgents(cwd ?? process.cwd());
}
```

- [ ] **Step 10.3: Run tests**

```
bun run test
```

Existing `agents` tests should pass unchanged.

- [ ] **Step 10.4: Commit**

```
git add server/harnesses/claude-code.ts server/agents.ts
git commit -m "refactor(harnesses): port syncAgents to claudeCodeHarness"
```

---

## Task 11: Port `resolveFlags` + add `validateSettings`

**Files:**

- Modify: `server/harnesses/claude-code.ts`
- Modify: `server/settings.ts`
- Modify: `server/settings.test.ts`

**Context:** `resolveClaudeFlags` (settings.ts:87) is the Claude-specific
flag resolver. Move it into the harness. Also tighten validation
(per the spec security model) — apply `validateFlagString` to both the
settings value AND `OCTOMUX_CLAUDE_FLAGS` env on read.

- [ ] **Step 11.1: Replace `resolveFlags` stub**

In `server/harnesses/claude-code.ts`:

```ts
import { validateFlagString } from './types.js';

// ...
resolveFlags(settings: OctomuxSettings): string {
  const envFlagsRaw = process.env.OCTOMUX_CLAUDE_FLAGS?.trim();
  if (envFlagsRaw) {
    const envFlags = validateFlagString(envFlagsRaw, 'OCTOMUX_CLAUDE_FLAGS');
    return ` ${envFlags}`;
  }

  const sub = (settings.harnesses?.['claude-code'] ?? {}) as {
    flags?: string;
    dangerouslySkipPermissions?: boolean;
  };

  const parts: string[] = [];
  if (sub.dangerouslySkipPermissions) parts.push('--dangerously-skip-permissions');
  if (sub.flags) {
    parts.push(validateFlagString(sub.flags, 'harnesses.claude-code.flags'));
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
},

validateSettings(blob: unknown): Record<string, unknown> {
  if (typeof blob !== 'object' || blob === null || Array.isArray(blob)) {
    throw new Error('Invalid claude-code settings: expected object');
  }
  const obj = blob as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (obj.flags !== undefined) {
    out.flags = validateFlagString(obj.flags as string, 'harnesses.claude-code.flags');
  }
  if (obj.dangerouslySkipPermissions !== undefined) {
    if (typeof obj.dangerouslySkipPermissions !== 'boolean') {
      throw new Error('Invalid claude-code.dangerouslySkipPermissions: expected boolean');
    }
    out.dangerouslySkipPermissions = obj.dangerouslySkipPermissions;
  }
  return out;
},
```

- [ ] **Step 11.2: Update `server/settings.ts` shape**

Replace `OctomuxSettings` interface:

```ts
export interface OctomuxSettings {
  editor: EditorChoice;
  defaultHarnessId: string;
  harnesses: Record<string, Record<string, unknown>>;

  /** @deprecated promoted into harnesses['claude-code'] on next save */
  claudeFlags?: string;
  /** @deprecated */
  dangerouslySkipPermissions?: boolean;
}

export const DEFAULT_SETTINGS: OctomuxSettings = {
  editor: 'nvim',
  defaultHarnessId: 'claude-code',
  harnesses: {},
};
```

Replace `getSettings()`:

```ts
let _deprecatedWarnEmitted = false;

export async function getSettings(): Promise<OctomuxSettings> {
  let parsed: Record<string, unknown>;
  try {
    const raw = await fs.promises.readFile(settingsPath(), 'utf-8');
    parsed = JSON.parse(raw);
  } catch (err: any) {
    if (err.code === 'ENOENT') return { ...DEFAULT_SETTINGS };
    throw err;
  }

  // Promote deprecated top-level keys.
  const harnesses = (parsed.harnesses as Record<string, Record<string, unknown>>) ?? {};
  const cc = { ...(harnesses['claude-code'] ?? {}) };
  let deprecatedSeen = false;
  if (parsed.claudeFlags !== undefined && cc.flags === undefined) {
    cc.flags = parsed.claudeFlags;
    deprecatedSeen = true;
  }
  if (
    parsed.dangerouslySkipPermissions !== undefined &&
    cc.dangerouslySkipPermissions === undefined
  ) {
    cc.dangerouslySkipPermissions = parsed.dangerouslySkipPermissions;
    deprecatedSeen = true;
  }
  const mergedHarnesses = { ...harnesses, 'claude-code': cc };

  // Validate registered harnesses' blobs (drop invalid blob keys with a warn).
  const { listHarnesses } = await import('./harnesses/index.js');
  for (const h of listHarnesses()) {
    if (mergedHarnesses[h.id]) {
      try {
        mergedHarnesses[h.id] = h.validateSettings(mergedHarnesses[h.id]);
      } catch (err) {
        logger.warn(
          { harness: h.id, err: (err as Error).message },
          'invalid harness settings; ignoring blob',
        );
        delete mergedHarnesses[h.id];
      }
    }
  }

  if (deprecatedSeen && !_deprecatedWarnEmitted) {
    logger.warn(
      'settings.json contains deprecated top-level keys (claudeFlags, dangerouslySkipPermissions); they will be removed on next save',
    );
    _deprecatedWarnEmitted = true;
  }

  return {
    editor: (parsed.editor as EditorChoice) ?? DEFAULT_SETTINGS.editor,
    defaultHarnessId: (parsed.defaultHarnessId as string) ?? DEFAULT_SETTINGS.defaultHarnessId,
    harnesses: mergedHarnesses,
  };
}
```

Replace `updateSettings()`:

```ts
export async function updateSettings(patch: Partial<OctomuxSettings>): Promise<OctomuxSettings> {
  if (patch.editor && !VALID_EDITORS.includes(patch.editor)) {
    throw new Error(`Invalid editor: ${patch.editor}. Must be one of: ${VALID_EDITORS.join(', ')}`);
  }

  const current = await getSettings();
  const mergedHarnesses = { ...current.harnesses };
  if (patch.harnesses) {
    const { listHarnesses } = await import('./harnesses/index.js');
    const registered = new Set(listHarnesses().map((h) => h.id));
    for (const [id, blob] of Object.entries(patch.harnesses)) {
      if (registered.has(id)) {
        const { getHarness } = await import('./harnesses/index.js');
        mergedHarnesses[id] = getHarness(id).validateSettings(blob);
      } else {
        // Unknown harness blob — preserve verbatim, do not validate.
        mergedHarnesses[id] = blob;
      }
    }
  }

  const merged: OctomuxSettings = {
    editor: patch.editor ?? current.editor,
    defaultHarnessId: patch.defaultHarnessId ?? current.defaultHarnessId,
    harnesses: mergedHarnesses,
  };

  const filePath = settingsPath();
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}
```

Remove `resolveClaudeFlags` (callers will use `harness.resolveFlags()`).
Remove `validateClaudeFlags` (replaced by harness `validateSettings`).

- [ ] **Step 11.3: Update `server/settings.test.ts`**

Replace tests that asserted the old shape. Add:

```ts
it('promotes legacy claudeFlags into harnesses["claude-code"]', async () => {
  await fs.promises.writeFile(
    settingsPath(),
    JSON.stringify({ claudeFlags: '--verbose', dangerouslySkipPermissions: true }, null, 2),
  );
  const s = await getSettings();
  expect(s.harnesses['claude-code']).toEqual({
    flags: '--verbose',
    dangerouslySkipPermissions: true,
  });
});

it('preserves unknown harness blobs verbatim', async () => {
  await fs.promises.writeFile(
    settingsPath(),
    JSON.stringify({ harnesses: { cursor: { flags: '--model x' } } }, null, 2),
  );
  const s = await getSettings();
  expect(s.harnesses.cursor).toEqual({ flags: '--model x' });
});

it('updateSettings strips deprecated top-level keys on save', async () => {
  await fs.promises.writeFile(
    settingsPath(),
    JSON.stringify({ claudeFlags: '--verbose' }, null, 2),
  );
  await updateSettings({ editor: 'vscode' });
  const written = JSON.parse(await fs.promises.readFile(settingsPath(), 'utf-8'));
  expect(written.claudeFlags).toBeUndefined();
  expect(written.harnesses['claude-code'].flags).toBe('--verbose');
});
```

- [ ] **Step 11.4: Run tests**

```
bun run test -- server/settings.test.ts server/harnesses/claude-code.test.ts
```

- [ ] **Step 11.5: Commit**

```
git add server/harnesses/claude-code.ts server/settings.ts server/settings.test.ts
git commit -m "refactor(settings): split into per-harness map, migrate legacy keys lazily"
```

---

## Task 12: Update hook routes to require token

**Files:**

- Modify: `server/hooks.ts`
- Modify: `server/hooks.test.ts`

**Context:** Add token verification on each `/api/hooks/*` route. The token
arrives as a query parameter (matching the URL format from Task 9). Rename
the column referenced in the lookup query.

- [ ] **Step 12.1: Add a verification helper**

In `server/hooks.ts`, near the existing `findAgentBySessionId`:

```ts
import { Request, Response, NextFunction } from 'express';
import { getDb } from './db.js';

/**
 * Verifies the `?token=...` query param against the agent's `hook_token`
 * column. Looks up the agent first by `harness_session_id` (or `agent_id`
 * in body, depending on the route — see per-route usage). Responds 401 on
 * any mismatch.
 */
export function requireHookToken(getAgentId: (req: Request) => Promise<string | null>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const provided = (req.query.token ?? '') as string;
    if (!provided) {
      logger.warn({ path: req.path, ip: req.ip }, 'hook request missing token');
      return res.status(401).send();
    }
    const agentId = await getAgentId(req);
    if (!agentId) {
      logger.warn({ path: req.path, ip: req.ip }, 'hook request: agent not found');
      return res.status(401).send();
    }
    const row = getDb().prepare(`SELECT hook_token FROM agents WHERE id = ?`).get(agentId) as
      | { hook_token: string }
      | undefined;
    if (!row || row.hook_token === '' || row.hook_token !== provided) {
      logger.warn({ path: req.path, ip: req.ip, agent_id: agentId }, 'hook token mismatch');
      return res.status(401).send();
    }
    next();
  };
}
```

- [ ] **Step 12.2: Apply `requireHookToken` middleware to each route**

For each existing hook route, the agent id is resolvable from the
session id in the request body. Refactor by extracting the agent lookup
and using it for both auth and the existing handler logic. Pattern:

```ts
router.post(
  '/stop',
  requireHookToken(async (req) => {
    const { session_id } = req.body ?? {};
    const agent = getDb()
      .prepare(`SELECT id FROM agents WHERE harness_session_id = ? AND status != 'stopped'`)
      .get(session_id) as { id: string } | undefined;
    return agent?.id ?? null;
  }),
  async (req, res) => {
    // existing body, using `harness_session_id` instead of `claude_session_id`
  },
);
```

Repeat for each of `user-prompt-submit`, `permission-request`, `post-tool-use`, `stop`.

Update every SQL query in `hooks.ts` that references `claude_session_id` →
`harness_session_id`. Run `grep -n claude_session_id server/hooks.ts` and
fix all matches.

- [ ] **Step 12.3: Update `server/hooks.test.ts`**

For each test that posts to a hook route, add a `?token=...` query param.
Set up the agent row with `hook_token = 'tok-1'`. Add new tests:

```ts
it('rejects requests without token (401)', async () => {
  const res = await request(app).post('/api/hooks/stop').send({ session_id: 'sess-1' });
  expect(res.status).toBe(401);
});

it('rejects requests with wrong token (401)', async () => {
  // ... insert agent with hook_token='tok-1', session_id='sess-1'
  const res = await request(app).post('/api/hooks/stop?token=wrong').send({ session_id: 'sess-1' });
  expect(res.status).toBe(401);
});

it('accepts requests with correct token', async () => {
  const res = await request(app).post('/api/hooks/stop?token=tok-1').send({ session_id: 'sess-1' });
  expect(res.status).toBe(200);
});
```

- [ ] **Step 12.4: Run tests**

```
bun run test -- server/hooks.test.ts
```

- [ ] **Step 12.5: Commit**

```
git add server/hooks.ts server/hooks.test.ts
git commit -m "feat(hooks): require per-agent hook token on /api/hooks/* routes"
```

---

## Task 13: Server hardening — bind 127.0.0.1, Host header, CORS deny

**Files:**

- Modify: `server/index.ts`
- Modify: `server/app.ts`
- Create: `server/security.test.ts`

**Context:** Bind explicitly to `127.0.0.1`. Reject any request whose
`Host:` header isn't `127.0.0.1` or `localhost`. Add a CORS-deny
middleware specifically for `/api/hooks/*`.

- [ ] **Step 13.1: Update `server/index.ts`**

Find `server.listen(PORT, ...)`. Replace with:

```ts
server.listen(PORT, '127.0.0.1', () => {
  logger.info({ port: PORT }, 'octomux listening on 127.0.0.1');
});
```

(Match the existing log style; the spec doesn't dictate exact text.)

- [ ] **Step 13.2: Add Host-header and CORS-deny middleware**

In `server/app.ts`, inside `createApp()`, before any routes are mounted:

```ts
// Host-header check (DNS-rebinding defense).
app.use((req, res, next) => {
  const host = (req.headers.host ?? '').split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') {
    logger.warn({ host, ip: req.ip, path: req.path }, 'rejected: bad host header');
    return res.status(403).send();
  }
  next();
});

// CORS deny on /api/hooks/*. Any cross-origin request is rejected.
app.use('/api/hooks', (req, res, next) => {
  if (req.headers.origin) {
    logger.warn(
      { origin: req.headers.origin, path: req.path },
      'rejected: cross-origin hook request',
    );
    return res.status(403).send();
  }
  next();
});
```

- [ ] **Step 13.3: Write tests**

```ts
// server/security.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { createTestDb } from './test-helpers.js';

let app: ReturnType<typeof createApp>;
beforeEach(() => {
  createTestDb();
  app = createApp();
});

describe('security middleware', () => {
  it('rejects requests with non-localhost Host header', async () => {
    const res = await request(app).get('/api/tasks').set('Host', 'evil.example.com');
    expect(res.status).toBe(403);
  });

  it('allows requests with Host: 127.0.0.1', async () => {
    const res = await request(app).get('/api/tasks').set('Host', '127.0.0.1');
    expect(res.status).toBe(200);
  });

  it('rejects /api/hooks/* with Origin header', async () => {
    const res = await request(app)
      .post('/api/hooks/stop?token=tok-1')
      .set('Origin', 'http://evil.example.com')
      .send({ session_id: 'sess-1' });
    expect(res.status).toBe(403);
  });

  it('allows /api/hooks/* without Origin header', async () => {
    const res = await request(app)
      .post('/api/hooks/stop?token=missing')
      .send({ session_id: 'sess-1' });
    // 401 because no valid agent, but NOT 403 — proves CORS check passed.
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 13.4: Run tests**

```
bun run test -- server/security.test.ts
```

- [ ] **Step 13.5: Commit**

```
git add server/index.ts server/app.ts server/security.test.ts
git commit -m "feat(server): bind 127.0.0.1, host-header check, CORS deny on hook routes"
```

---

## Task 14: `task-runner.ts::createTask` — use harness dispatch

**Files:**

- Modify: `server/task-runner.ts` (around line 629-657)
- Modify: `server/task-runner.test.ts`

**Context:** Replace the inline Claude command construction in
`createTask` with calls into the harness. Mint the hook token. Pass it to
`harness.installHooks`. The existing log lines stay; only field name
renames (claude_session_id → harness_session_id).

- [ ] **Step 14.1: Replace `getClaudeFlags` at the top of `task-runner.ts`**

Delete the existing `getClaudeFlags()` function (lines 40-42). Add at the
top:

```ts
import { getHarness, claudeCodeHarness } from './harnesses/index.js';
import { hookBaseUrl } from './hook-base-url.js';
import crypto from 'crypto';
```

(Remove imports that become unused: `resolveClaudeFlags`.)

Replace `sendClaudeCommand` with `sendHarnessCommand` (rename the function;
all its internals stay the same). Also rename every internal reference.

- [ ] **Step 14.2: Rewrite the `createTask` agent-launch block**

In `createTask` (around lines 629-657), replace:

```ts
const agentId = nanoid(12);
const claudeSessionId = crypto.randomUUID();
const agentName = task.agent ?? null;
db.prepare(
  'INSERT INTO agents (id, task_id, window_index, label, claude_session_id, agent) VALUES (?, ?, ?, ?, ?, ?)',
).run(agentId, id, windowIndex, 'Agent 1', claudeSessionId, agentName);

if (agentName) await syncAgents(setup.worktreePath);

const flags = await getClaudeFlags();
const agentFlag = agentName ? ` --agent ${agentName}` : '';
await sendClaudeCommand({
  target: `${session}:${windowIndex}`,
  baseCmd: `claude${agentFlag} --session-id ${claudeSessionId}${flags}`,
  prompt: task.initial_prompt,
  worktreePath: setup.worktreePath,
  agentId,
});
```

with:

```ts
const harness = getHarness(task.harness_id);
const agentId = nanoid(12);
const agentName = task.agent ?? null;
const hookToken = crypto.randomBytes(32).toString('hex');
const flags = harness.resolveFlags(await getSettings());

let sessionIdForDb: string | null;
let sessionIdForLaunch: string;
if (harness.sessionIdMode === 'orchestrator-assigned') {
  const id = harness.newSessionId();
  sessionIdForDb = id;
  sessionIdForLaunch = id;
} else {
  sessionIdForDb = null;
  sessionIdForLaunch = harness.newSessionId();
}

db.prepare(
  `INSERT INTO agents
     (id, task_id, window_index, label, harness_id, harness_session_id, hook_token, agent)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(agentId, id, windowIndex, 'Agent 1', harness.id, sessionIdForDb, hookToken, agentName);

await harness.syncAgents(setup.worktreePath);
await harness.installHooks(setup.worktreePath, hookBaseUrl(), hookToken);

const baseCmd = harness.buildLaunchCommand({
  sessionId: sessionIdForLaunch,
  agent: agentName,
  flags,
});
await sendHarnessCommand({
  target: `${session}:${windowIndex}`,
  baseCmd,
  prompt: task.initial_prompt,
  worktreePath: setup.worktreePath,
  agentId,
});
```

Also note: the existing `installHookSettings(setup.installHooksAt)` call
earlier in `createTask` becomes redundant — the harness's `installHooks`
now handles it. Verify and remove that earlier call OR adjust the order so
hooks are installed exactly once.

Update the `logger.info({ ..., claude_session_id: claudeSessionId, ... })`
call to use `harness_session_id: sessionIdForDb` and add `harness:
harness.id`.

- [ ] **Step 14.3: Update `server/task-runner.test.ts`**

Tests that assert exact `claude --session-id ...` strings should continue
to pass because the Claude harness produces the same command. Tests that
read `claude_session_id` from DB rows must rename to `harness_session_id`.

Run:

```
grep -n claude_session_id server/task-runner.test.ts
```

Fix every match. Also rename test helper invocations if they took
`claude_session_id` arguments.

- [ ] **Step 14.4: Run tests**

```
bun run test -- server/task-runner.test.ts
```

- [ ] **Step 14.5: Commit**

```
git add server/task-runner.ts server/task-runner.test.ts
git commit -m "refactor(task-runner): use harness dispatch in createTask"
```

---

## Task 15: `task-runner.ts::addAgent` — harness dispatch

**Files:**

- Modify: `server/task-runner.ts` (around line 677-762)

- [ ] **Step 15.1: Rewrite `addAgent` agent-launch block**

Apply the same pattern as Task 14 to `addAgent`. The agent inherits
`task.harness_id` (passed via the `task` argument). Mint a fresh
`hook_token` per agent. Replace the inline `claude --agent ...` command
with `harness.buildLaunchCommand(...)`. Update the INSERT to include
`harness_id` and `hook_token`.

```ts
const harness = getHarness(task.harness_id);
const agentId = nanoid(12);
const hookToken = crypto.randomBytes(32).toString('hex');
const flags = harness.resolveFlags(await getSettings());
const resolvedAgent = agentName ?? null;

let sessionIdForDb: string | null;
let sessionIdForLaunch: string;
if (harness.sessionIdMode === 'orchestrator-assigned') {
  const id = harness.newSessionId();
  sessionIdForDb = id;
  sessionIdForLaunch = id;
} else {
  sessionIdForDb = null;
  sessionIdForLaunch = harness.newSessionId();
}

db.prepare(
  `INSERT INTO agents
     (id, task_id, window_index, label, harness_id, harness_session_id, hook_token, agent)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(agentId, task.id, windowIndex, label, harness.id, sessionIdForDb, hookToken, resolvedAgent);

if (resolvedAgent) await harness.syncAgents(task.worktree!);
await harness.installHooks(task.worktree!, hookBaseUrl(), hookToken);

const baseCmd = harness.buildLaunchCommand({
  sessionId: sessionIdForLaunch,
  agent: resolvedAgent,
  flags,
});
```

Update the returned `Agent` object literal to include the new fields:

```ts
return {
  id: agentId,
  task_id: task.id,
  // ...
  harness_id: harness.id,
  harness_session_id: sessionIdForDb,
  hook_token: hookToken,
  agent: resolvedAgent,
  // ...
};
```

- [ ] **Step 15.2: Run tests**

```
bun run test -- server/task-runner.test.ts
```

- [ ] **Step 15.3: Commit**

```
git add server/task-runner.ts
git commit -m "refactor(task-runner): use harness dispatch in addAgent"
```

---

## Task 16: `task-runner.ts::moveAgentToTask` — harness dispatch

**Files:**

- Modify: `server/task-runner.ts` (around lines 1140-1170 and 1280-1302)

**Context:** Two paths use `--resume` / `--continue` / `--session-id`.
Replace them with the harness's `buildResumeCommand`/`buildContinueCommand`/
`buildLaunchCommand` with the null-fallback logic from the spec's data-flow
snippet.

- [ ] **Step 16.1: Find and rewrite both occurrences**

Search:

```
grep -n "claude --resume\|claude --continue\|claude --session-id" server/task-runner.ts
```

For each:

```ts
let baseCmd: string;
if (agent.harness_session_id) {
  baseCmd = harness.buildResumeCommand({
    sessionId: agent.harness_session_id,
    flags,
  });
} else {
  const newId = harness.newSessionId();
  const continueCmd = harness.buildContinueCommand({ sessionId: newId, flags });
  if (continueCmd !== null) {
    baseCmd = continueCmd;
  } else {
    baseCmd = harness.buildLaunchCommand({ sessionId: newId, flags });
    logger.warn(
      { agent_id: agent.id, harness: harness.id },
      'continue unsupported, launching fresh',
    );
  }
  if (harness.sessionIdMode === 'orchestrator-assigned') {
    db.prepare(`UPDATE agents SET harness_session_id = ? WHERE id = ?`).run(newId, agent.id);
  }
}

await sendHarnessCommand({ target, baseCmd });
```

`harness` is resolved from `agent.harness_id` (load the agent row that
includes the column, or pass `harness_id` alongside).

- [ ] **Step 16.2: Run tests**

```
bun run test -- server/task-runner.test.ts
```

- [ ] **Step 16.3: Commit**

```
git add server/task-runner.ts
git commit -m "refactor(task-runner): use harness dispatch in moveAgentToTask"
```

---

## Task 17: `chats.ts` — harness dispatch + token

**Files:**

- Modify: `server/chats.ts` (around line 48-90)

**Context:** Standalone chats (no `task_id`) follow the same pattern as
agents. They use the default harness (`claudeCodeHarness`) since the
create-chat API has no harness picker yet (step 2b adds it).

- [ ] **Step 17.1: Rewrite the `createChat` body**

Replace the inline `claude ...` command construction with harness dispatch
analogous to Task 14:

```ts
const harness = getHarness(/* eventually request.harnessId */ null); // null = default
const agentId = nanoid(12);
const hookToken = crypto.randomBytes(32).toString('hex');
const flags = harness.resolveFlags(await getSettings());

let sessionIdForDb: string | null;
let sessionIdForLaunch: string;
if (harness.sessionIdMode === 'orchestrator-assigned') {
  const id = harness.newSessionId();
  sessionIdForDb = id;
  sessionIdForLaunch = id;
} else {
  sessionIdForDb = null;
  sessionIdForLaunch = harness.newSessionId();
}

db.prepare(
  `INSERT INTO agents
     (id, task_id, window_index, label, status, harness_id, harness_session_id,
      hook_token, tmux_session, agent)
   VALUES (?, NULL, 0, ?, 'running', ?, ?, ?, ?, ?)`,
).run(id, label, harness.id, sessionIdForDb, hookToken, session, agent);

if (agent) await harness.syncAgents(cwd);
await harness.installHooks(cwd, hookBaseUrl(), hookToken);

const baseCmd = harness.buildLaunchCommand({
  sessionId: sessionIdForLaunch,
  agent,
  flags,
});
```

Then the existing `sendKeys` / prompt-file write continues from here using
`baseCmd`. Rename file-local references from `claudeSessionId` to whatever
name reads naturally given `sessionIdForLaunch`.

- [ ] **Step 17.2: Run tests**

```
bun run test
```

- [ ] **Step 17.3: Commit**

```
git add server/chats.ts
git commit -m "refactor(chats): use harness dispatch in createChat"
```

---

## Task 18: Validate `agent` at the API boundary

**Files:**

- Modify: `server/api.ts` (lines 596, 821, 1697 — wherever request bodies extract `agent`)

**Context:** Defense in depth: validate agent names at the HTTP boundary
even though the harness's command builder also validates.

- [ ] **Step 18.1: Run a grep to find sites**

```
grep -n "body.agent\b\|body\.agent " server/api.ts
```

For each site that reads `agent` from the request body, wrap in
`validateAgentName`:

```ts
import { validateAgentName } from './harnesses/types.js';

// ...inside a handler:
const agent = body.agent ? validateAgentName(body.agent) : null;
```

Surface validation errors as HTTP 400 with the error message.

- [ ] **Step 18.2: Add an API test**

In `server/api.test.ts`:

```ts
it('rejects task creation with invalid agent name', async () => {
  const res = await request(app)
    .post('/api/tasks')
    .send({ title: 'T', description: 'D', agent: 'foo; rm -rf /' });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/Invalid agent name/);
});
```

- [ ] **Step 18.3: Run tests**

```
bun run test -- server/api.test.ts
```

- [ ] **Step 18.4: Commit**

```
git add server/api.ts server/api.test.ts
git commit -m "feat(api): validate agent names at request boundary"
```

---

## Task 19: Tighten prompt-file write — `O_EXCL` + `0o600`

**Files:**

- Modify: `server/task-runner.ts` (around line 113-116)

**Context:** The prompt-file write in `sendHarnessCommand` should fail if
the target already exists and create with owner-only permissions.

- [ ] **Step 19.1: Change the write**

Find the existing write:

```ts
fs.writeFileSync(promptFile, args.prompt);
```

Change to:

```ts
fs.writeFileSync(promptFile, args.prompt, { mode: 0o600, flag: 'wx' });
```

- [ ] **Step 19.2: Run tests**

```
bun run test -- server/task-runner.test.ts
```

If any test fails due to the new flag (e.g. setup leaves stale prompt
files between cases), unlink them in `beforeEach` or accept the test
adjustment.

- [ ] **Step 19.3: Commit**

```
git add server/task-runner.ts
git commit -m "fix(task-runner): write prompt files with O_EXCL and 0o600"
```

---

## Task 20: Backfill `hook_token` on read for pre-step-1 agents

**Files:**

- Modify: `server/api.ts` (task GET handler, agent GET handler) OR
  `server/task-runner.ts` (a centralized agent-load helper) — pick the
  smallest blast radius

**Context:** Existing agents in users' DBs after upgrade have
`hook_token = ''` (the DEFAULT). Their worktrees still contain hooks.json
URLs without tokens. First time the user opens a task/chat that owns these
agents, the system must mint a token, write it to DB, and re-run
`harness.installHooks` to refresh the worktree config. Skip closed tasks
to avoid spurious worktree writes.

- [ ] **Step 20.1: Implement a helper**

Add to `server/task-runner.ts` (or a fresh `server/hook-token.ts`):

```ts
import crypto from 'crypto';
import { getDb } from './db.js';
import { getHarness } from './harnesses/index.js';
import { hookBaseUrl } from './hook-base-url.js';
import type { Agent } from './types.js';
import { childLogger } from './logger.js';

const logger = childLogger('hook-token');

/**
 * Backfills `hook_token` for an agent that was created before step 1.
 * If the agent already has a token or its task is closed, no-ops.
 * Returns the agent's current (possibly newly minted) hook_token.
 */
export async function ensureHookToken(agent: Agent, worktreePath: string | null): Promise<string> {
  if (agent.hook_token && agent.hook_token !== '') return agent.hook_token;

  if (agent.task_id) {
    const task = getDb().prepare(`SELECT status FROM tasks WHERE id = ?`).get(agent.task_id) as
      | { status: string }
      | undefined;
    if (!task || task.status === 'closed') return '';
  }

  const token = crypto.randomBytes(32).toString('hex');
  getDb().prepare(`UPDATE agents SET hook_token = ? WHERE id = ?`).run(token, agent.id);

  if (worktreePath) {
    try {
      await getHarness(agent.harness_id).installHooks(worktreePath, hookBaseUrl(), token);
    } catch (err) {
      logger.warn({ agent_id: agent.id, err }, 'failed to refresh hook config on backfill');
    }
  }

  return token;
}
```

- [ ] **Step 20.2: Call it from `getTask` (or wherever an agent is fetched and might be re-hooked)**

Find the place where the `Task.agents` array is hydrated for GET
`/api/tasks/:id`. For each agent in the list whose `hook_token === ''`,
call `ensureHookToken(agent, task.worktree)` and replace the in-memory
`agent.hook_token` with the returned value before serialising.

- [ ] **Step 20.3: Test**

```ts
// server/hook-token.test.ts (new)
import { describe, it, expect } from 'vitest';
import { createTestDb } from './test-helpers.js';
import { ensureHookToken } from './task-runner.js'; // or hook-token.ts
import { getDb } from './db.js';

describe('ensureHookToken', () => {
  it('mints a token for an agent with empty hook_token', async () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO tasks (id, title, description, repo_path, status, created_at, updated_at, source, harness_id) VALUES ('t1','T','','/tmp','running',datetime('now'),datetime('now'),NULL,'claude-code')`,
    ).run();
    db.prepare(
      `INSERT INTO agents (id, task_id, window_index, label, harness_id, harness_session_id, hook_token, agent) VALUES ('a1','t1',0,'Agent 1','claude-code','sess-1','',NULL)`,
    ).run();
    const agent = db.prepare(`SELECT * FROM agents WHERE id = 'a1'`).get() as any;
    const token = await ensureHookToken(agent, null);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const row = db.prepare(`SELECT hook_token FROM agents WHERE id = 'a1'`).get() as {
      hook_token: string;
    };
    expect(row.hook_token).toBe(token);
  });

  it('returns existing token unchanged', async () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO tasks (id, title, description, repo_path, status, created_at, updated_at, source, harness_id) VALUES ('t1','T','','/tmp','running',datetime('now'),datetime('now'),NULL,'claude-code')`,
    ).run();
    db.prepare(
      `INSERT INTO agents (id, task_id, window_index, label, harness_id, harness_session_id, hook_token, agent) VALUES ('a2','t1',0,'Agent 1','claude-code','sess-1','tok-existing',NULL)`,
    ).run();
    const agent = db.prepare(`SELECT * FROM agents WHERE id = 'a2'`).get() as any;
    const token = await ensureHookToken(agent, null);
    expect(token).toBe('tok-existing');
  });

  it('skips closed tasks', async () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO tasks (id, title, description, repo_path, status, created_at, updated_at, source, harness_id) VALUES ('t1','T','','/tmp','closed',datetime('now'),datetime('now'),NULL,'claude-code')`,
    ).run();
    db.prepare(
      `INSERT INTO agents (id, task_id, window_index, label, harness_id, harness_session_id, hook_token, agent) VALUES ('a3','t1',0,'Agent 1','claude-code','sess-1','',NULL)`,
    ).run();
    const agent = db.prepare(`SELECT * FROM agents WHERE id = 'a3'`).get() as any;
    const token = await ensureHookToken(agent, null);
    expect(token).toBe('');
  });
});
```

- [ ] **Step 20.4: Run tests**

```
bun run test -- server/hook-token.test.ts server/api.test.ts
```

- [ ] **Step 20.5: Commit**

```
git add server/task-runner.ts server/hook-token.test.ts server/api.ts
git commit -m "feat(hooks): backfill hook_token for pre-step-1 agents on read"
```

---

## Task 21: Final cleanup — typecheck, full test, CLAUDE.md

**Files:**

- Modify: `CLAUDE.md` (Architecture section)
- Final verification

- [ ] **Step 21.1: Run full typecheck**

```
bun run typecheck
```

Expected: no errors. If anything remains, hunt down and fix.

- [ ] **Step 21.2: Run full test suite**

```
bun run test
```

Expected: all green.

- [ ] **Step 21.3: Run linter**

```
bun run lint
```

Fix any new warnings (the new `server/harnesses/` files should be clean).

- [ ] **Step 21.4: Manual smoke test**

```
bun run dev
```

- Open the dashboard.
- Create a new task in a repo with the default Claude agent. Verify it
  launches.
- Verify the worktree's `.claude/settings.local.json` contains hook URLs
  with `?token=<random>` query params.
- Verify a hook fires and the agent's badges update.
- Open the settings page. If you previously had `claudeFlags` set, it
  should still apply (read back via `claude --help` works) and on next
  save the file shape changes.

- [ ] **Step 21.5: Update `CLAUDE.md`**

In the Architecture section, add the new module:

```
- `server/harnesses/` — pluggable harness implementations (Claude Code today;
  Cursor in a later step). Each `Harness` exports `id`, `displayName`,
  `sessionIdMode`, command builders, `installHooks`, `syncAgents`,
  `resolveFlags`, `validateSettings`.
```

In a new "Gotchas" bullet (or near the existing migration notes):

```
- DB migrations are forward-only. Back up `~/.octomux/octomux.sqlite` (prod)
  or `./data/octomux.sqlite` (dev) before upgrading across the
  harness-abstraction migration.
```

- [ ] **Step 21.6: Final commit**

```
git add CLAUDE.md
git commit -m "docs(claude): note harness module and forward-only migration"
```

---

## Self-review checklist

After all tasks complete, walk through the spec one more time:

- [ ] **Spec coverage:** Every "Step 1" requirement in
      `spec/harness-abstraction.md` has a corresponding task above.
- [ ] **Behavior changes match the spec.** Settings file rewrite, log
      field renames, new error class, input validation, hook endpoint
      hardening — all visible.
- [ ] **No remaining references to `claude_session_id`** anywhere
      (`grep -rn claude_session_id server/ src/ cli/ e2e/`).
- [ ] **No remaining references to `getClaudeFlags` / `resolveClaudeFlags` /
      `validateClaudeFlags`** anywhere.
- [ ] **Tests run green with `bun run test`** and typecheck with `bun run
typecheck`.
- [ ] **CLAUDE.md updated** with the new module and the migration note.

If anything is missing, add a task above and run it. Don't ship a partial
step 1.
