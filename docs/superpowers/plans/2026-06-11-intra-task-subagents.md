# Intra-Task Sub-Agents: Skeleton Prompts + Completion Notifications

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow an orchestrator agent to spawn sub-agents in the same task (same worktree, separate tmux windows) with per-role system prompts loaded from skeleton files, and receive a notification message when each sub-agent finishes.

**Architecture:** Extend `add-agent` with two new fields: `skeleton` (loads `<repo>/.octomux/agents/<name>.md` and prepends to the prompt) and `notify_agent_id` (stored on the `agents` row; the poller watches for dead tmux windows within living sessions and sends a completion message to the referenced agent). The skeleton content is prepended in the server-side `addAgent()` function — no harness changes needed. Agent-window death detection runs as `pollAgentWindows()`, called from inside the existing `pollStatuses()` loop.

**Tech Stack:** TypeScript, better-sqlite3, tmux, vitest, commander

---

## File Map

| File                                 | Change                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `server/types.ts`                    | Add `notify_agent_id` to `Agent`; add `skeleton`, `notify_agent_id`, `label` to `AddAgentRequest`                                     |
| `server/db.ts`                       | `addColumn('agents', 'notify_agent_id', ...)`                                                                                         |
| `server/task-runner.ts`              | `addAgent()` accepts `opts.skeleton` + `opts.notifyAgentId` + `opts.label`; load skeleton, prepend to prompt; store `notify_agent_id` |
| `server/api.ts`                      | Forward `skeleton`, `notify_agent_id`, `label` from body to `addAgent()`                                                              |
| `server/poller.ts`                   | Add `pollAgentWindows()` — detect dead windows, notify referenced agent                                                               |
| `server/test-helpers.ts`             | Add `notify_agent_id: null` to `DEFAULTS.agent` + `insertAgent`                                                                       |
| `server/poller.test.ts`              | New test: dead agent window triggers notify to orchestrator                                                                           |
| `server/task-runner.test.ts`         | New tests: skeleton prepended to prompt; notify_agent_id stored                                                                       |
| `cli/src/commands/add-agent.ts`      | Add `--skeleton`, `--notify-agent` flags                                                                                              |
| `cli/src/commands/add-agent.test.ts` | Test new flags passed through                                                                                                         |
| `cli/src/client.ts`                  | Add `skeleton?`, `notify_agent_id?`, `label?` to `addAgent()` signature                                                               |

---

## Task 1: DB migration — `agents.notify_agent_id`

**Files:**

- Modify: `server/db.ts`
- Modify: `server/test-helpers.ts`

- [ ] **Step 1: Write the failing test**

In `server/db.test.ts` (or wherever schema columns are tested), add:

```typescript
it('agents table has notify_agent_id column', () => {
  const db = createTestDb();
  const cols = db.prepare('PRAGMA table_info(agents)').all() as { name: string }[];
  expect(cols.map((c) => c.name)).toContain('notify_agent_id');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/shreypaharia/Documents/Projects/Ostium/octomux-agents
bun run test server/db.test.ts
```

Expected: FAIL — `notify_agent_id` not in column list.

- [ ] **Step 3: Add migration in `server/db.ts`**

Find the block that calls `addColumn` for the agents table (around line 477). Add after the last `addColumn` for agents in that block — find where `agentCols2` is used and append:

```typescript
// After the existing agentCols2 block:
const agentCols3 = new Set(
  (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map((r) => r.name),
);
addColumn('agents', 'notify_agent_id', 'notify_agent_id TEXT', agentCols3);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun run test server/db.test.ts
```

Expected: PASS

- [ ] **Step 5: Update `server/test-helpers.ts`**

In `DEFAULTS.agent`, add `notify_agent_id: null as string | null`.

In `AGENTS_TABLE_COLUMNS`, add `'notify_agent_id'`.

In `insertAgent`, update the INSERT:

```typescript
db.prepare(
  'INSERT INTO agents (id, task_id, window_index, label, status, harness_session_id, hook_activity, hook_token, notify_agent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
).run(
  agent.id,
  agent.task_id,
  agent.window_index,
  agent.label,
  agent.status,
  (agent as any).harness_session_id ?? null,
  (agent as any).hook_activity || 'active',
  (agent as any).hook_token ?? '',
  (agent as any).notify_agent_id ?? null,
);
```

- [ ] **Step 6: Commit**

```bash
git add server/db.ts server/test-helpers.ts
git commit -m "feat(agents): add notify_agent_id column for intra-task completion notify"
```

---

## Task 2: Types — extend `Agent` and `AddAgentRequest`

**Files:**

- Modify: `server/types.ts`
- Modify: `cli/src/client.ts`

- [ ] **Step 1: Update `server/types.ts`**

In the `Agent` interface (around line 112), add after `window_index`:

```typescript
notify_agent_id: string | null;
```

In `AddAgentRequest` (line 199), expand to:

```typescript
export interface AddAgentRequest {
  prompt?: string;
  agent?: string;
  label?: string;
  model?: string;
  skeleton?: string;
  notify_agent_id?: string | null;
}
```

- [ ] **Step 2: Update `cli/src/client.ts`**

In `OctomuxClient.addAgent` signature (around line 119), update `data?` type:

```typescript
addAgent(
  taskId: string,
  data?: {
    prompt?: string;
    agent?: string;
    label?: string;
    model?: string;
    skeleton?: string;
    notify_agent_id?: string | null;
  },
): Promise<Agent>;
```

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```

Expected: same pre-existing errors, no new ones.

- [ ] **Step 4: Commit**

```bash
git add server/types.ts cli/src/client.ts
git commit -m "feat(agents): extend AddAgentRequest with skeleton + notify_agent_id"
```

---

## Task 3: `addAgent()` — skeleton loading + notify_agent_id storage

**Files:**

- Modify: `server/task-runner.ts`
- Modify: `server/api.ts`
- Test: `server/task-runner.test.ts`

- [ ] **Step 1: Write failing tests**

In `server/task-runner.test.ts`, find the `addAgent` test block and add:

```typescript
describe('addAgent skeleton', () => {
  it('prepends skeleton content to the prompt when skeleton is provided', async () => {
    // arrange: write a skeleton file in the test worktree
    const skeletonDir = path.join(testWorktreePath, '.octomux', 'agents');
    fs.mkdirSync(skeletonDir, { recursive: true });
    fs.writeFileSync(path.join(skeletonDir, 'researcher.md'), '# Researcher\nYou research things.');

    // act
    await addAgent(task, { prompt: 'Go find X', skeleton: 'researcher' });

    // assert: the prompt sent to the tmux window contains the skeleton content
    const sentPrompts = getSentPrompts(); // helper that collects sendMessageToAgent calls
    expect(sentPrompts[0]).toContain('# Researcher');
    expect(sentPrompts[0]).toContain('Go find X');
  });

  it('throws when skeleton file does not exist', async () => {
    await expect(addAgent(task, { prompt: 'Go', skeleton: 'nonexistent' })).rejects.toThrow(
      'skeleton not found: nonexistent',
    );
  });

  it('stores notify_agent_id on the agent row', async () => {
    await addAgent(task, { prompt: 'Go', notify_agent_id: 'parent-agent-01' });
    const agent = db
      .prepare(
        'SELECT notify_agent_id FROM agents WHERE task_id = ? ORDER BY window_index DESC LIMIT 1',
      )
      .get(task.id) as { notify_agent_id: string | null };
    expect(agent.notify_agent_id).toBe('parent-agent-01');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun run test server/task-runner.test.ts
```

Expected: FAIL — `addAgent` doesn't accept object opts yet.

- [ ] **Step 3: Update `addAgent` signature in `server/task-runner.ts`**

Change the signature from:

```typescript
export async function addAgent(
  task: Task,
  prompt?: string,
  agentName?: string | null,
): Promise<Agent>;
```

To:

```typescript
export interface AddAgentOpts {
  prompt?: string;
  agent?: string | null;
  label?: string;
  model?: string | null;
  skeleton?: string;
  notify_agent_id?: string | null;
}

export async function addAgent(task: Task, opts: AddAgentOpts = {}): Promise<Agent>;
```

- [ ] **Step 4: Update usages inside `addAgent`**

Replace references to `prompt` and `agentName` params with `opts.prompt`, `opts.agent`:

```typescript
const resolvedAgent = opts.agent ?? null;
```

For the label, replace the hardcoded `Agent N` logic with:

```typescript
const label = opts.label ?? `Agent ${activeAgents.length + 1}`;
```

For skeleton loading (add after `const resolvedAgent` line):

```typescript
let resolvedPrompt = opts.prompt;
if (opts.skeleton) {
  const skeletonPath = path.join(task.repo_path!, '.octomux', 'agents', `${opts.skeleton}.md`);
  if (!fs.existsSync(skeletonPath)) {
    throw new Error(`skeleton not found: ${opts.skeleton} (expected at ${skeletonPath})`);
  }
  const skeletonContent = fs.readFileSync(skeletonPath, 'utf-8');
  resolvedPrompt = opts.prompt ? `${skeletonContent}\n\n# Task\n\n${opts.prompt}` : skeletonContent;
}
```

For model, update `buildLaunchCommand` call:

```typescript
model: opts.model ?? (task as any).model ?? null,
```

For storing `notify_agent_id` in the INSERT:

```typescript
db.prepare(
  `INSERT INTO agents
     (id, task_id, window_index, label, harness_id, harness_session_id, hook_token, agent, notify_agent_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  agentId,
  task.id,
  windowIndex,
  label,
  harness.id,
  sessionIdForDb,
  hookToken,
  resolvedAgent,
  opts.notify_agent_id ?? null,
);
```

Replace `prompt` with `resolvedPrompt` in the `sendHarnessCommand` call:

```typescript
await sendHarnessCommand({
  target: addTarget,
  baseCmd,
  prompt: resolvedPrompt,
  worktreePath: task.worktree!,
  agentId,
});
```

- [ ] **Step 5: Fix all call sites of `addAgent` in the codebase**

Find all calls (in `api.ts` and anywhere else):

```bash
grep -n "addAgent(" /Users/shreypaharia/Documents/Projects/Ostium/octomux-agents/server/api.ts
grep -rn "addAgent(" /Users/shreypaharia/Documents/Projects/Ostium/octomux-agents/server/
```

In `server/api.ts` around line 1032, update to pass the full body object:

```typescript
const agent = await addAgent(task, {
  prompt: body.prompt,
  agent: body.agent,
  label: body.label,
  model: body.model,
  skeleton: body.skeleton,
  notify_agent_id: body.notify_agent_id,
});
```

Any other call sites that used the old `(task, prompt, agentName)` positional form must be updated to use `{ prompt, agent: agentName }`.

- [ ] **Step 6: Run tests to verify they pass**

```bash
bun run test server/task-runner.test.ts
```

Expected: PASS

- [ ] **Step 7: Run full suite**

```bash
bun run test
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add server/task-runner.ts server/api.ts
git commit -m "feat(agents): skeleton loading + notify_agent_id in addAgent"
```

---

## Task 4: Poller — detect dead agent windows + notify orchestrator

**Files:**

- Modify: `server/poller.ts`
- Test: `server/poller.test.ts`

- [ ] **Step 1: Write the failing test**

In `server/poller.test.ts`, add a new describe block:

```typescript
describe('pollAgentWindows', () => {
  it('sends completion message to notify_agent when worker window dies', async () => {
    createTestDb();
    // orchestrator task + agent (the one to be notified)
    const orchTask = insertTestTask({
      id: 'orch-task-01',
      tmux_session: 'octomux-agent-orch-task-01',
      runtime_state: 'running',
    });
    const orchAgent = insertAgent(getDb(), {
      id: 'orch-agent-01',
      task_id: 'orch-task-01',
      window_index: 1,
      status: 'running',
    });

    // worker agent with notify_agent_id pointing to orchestrator
    insertTestTask({
      id: 'worker-task-01',
      tmux_session: 'octomux-agent-orch-task-01',
      runtime_state: 'running',
    });
    insertAgent(getDb(), {
      id: 'worker-agent-01',
      task_id: 'worker-task-01',
      window_index: 2,
      status: 'running',
      notify_agent_id: 'orch-agent-01',
    });

    // tmux: session alive, but worker window 2 is dead
    execFileMock.mockImplementation((...args: any[]) => {
      const [cmd, cmdArgs] = args as [string, string[]];
      if (cmd === 'tmux' && cmdArgs.includes('has-session')) {
        const cb = findCallback(...args);
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (
        cmd === 'tmux' &&
        cmdArgs.includes('display-message') &&
        cmdArgs.includes('octomux-agent-orch-task-01:2')
      ) {
        const cb = findCallback(...args);
        cb?.(new Error("can't find window: 2"), { stdout: '', stderr: "can't find window: 2" });
        return;
      }
      const cb = findCallback(...args);
      cb?.(null, { stdout: '', stderr: '' });
    });

    await pollStatuses();

    expect(sendMessageToAgent).toHaveBeenCalledWith(
      'octomux-agent-orch-task-01',
      1,
      expect.stringContaining('worker-agent-01'),
    );

    // worker agent should be marked stopped
    const agent = getDb()
      .prepare('SELECT status FROM agents WHERE id = ?')
      .get('worker-agent-01') as { status: string };
    expect(agent.status).toBe('stopped');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun run test server/poller.test.ts
```

Expected: FAIL — `pollAgentWindows` doesn't exist yet.

- [ ] **Step 3: Implement `pollAgentWindows()` in `server/poller.ts`**

Add a helper to check if a tmux window exists:

```typescript
async function checkWindowStatus(session: string, windowIndex: number): Promise<'alive' | 'dead'> {
  try {
    await execFile('tmux', ['display-message', '-t', `${session}:${windowIndex}`, '-p', '#I']);
    return 'alive';
  } catch {
    return 'dead';
  }
}
```

Add the main function (call this from inside `pollStatuses`, after the existing loop):

```typescript
async function pollAgentWindows(): Promise<void> {
  const db = getDb();
  // Only watch agents that have a notify target AND live inside a running task session
  const watchedAgents = db
    .prepare(
      `SELECT a.id, a.task_id, a.window_index, a.label,
              t.tmux_session, a.notify_agent_id
       FROM agents a
       INNER JOIN tasks t ON a.task_id = t.id
       WHERE a.status = 'running'
         AND a.notify_agent_id IS NOT NULL
         AND t.runtime_state = 'running'
         AND t.tmux_session IS NOT NULL`,
    )
    .all() as Array<{
    id: string;
    task_id: string;
    window_index: number;
    label: string;
    tmux_session: string;
    notify_agent_id: string;
  }>;

  const results = await Promise.allSettled(
    watchedAgents.map(async (agent) => {
      const status = await checkWindowStatus(agent.tmux_session, agent.window_index);
      return { agent, status };
    }),
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { agent, status } = result.value;
    if (status !== 'dead') continue;

    db.prepare(
      `UPDATE agents SET status = 'stopped', hook_activity = 'idle', hook_activity_updated_at = datetime('now')
       WHERE id = ?`,
    ).run(agent.id);

    // Look up the notify target agent
    const target = db
      .prepare(
        `SELECT a.window_index, t.tmux_session
         FROM agents a
         INNER JOIN tasks t ON a.task_id = t.id
         WHERE a.id = ? AND a.status != 'stopped' AND t.runtime_state = 'running'`,
      )
      .get(agent.notify_agent_id) as { window_index: number; tmux_session: string } | undefined;

    if (!target) continue;

    const msg = `[octomux] Sub-agent ${agent.id} ("${agent.label}") finished. Check results: octomux get-task --json ${agent.task_id}`;
    await sendMessageToAgent(target.tmux_session, target.window_index, msg);
  }
}
```

Wire it into `pollStatuses()` — add at the very end, before the `return`:

```typescript
await pollAgentWindows();
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun run test server/poller.test.ts
```

Expected: PASS

- [ ] **Step 5: Run full suite**

```bash
bun run test
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add server/poller.ts server/poller.test.ts
git commit -m "feat(poller): detect dead agent windows and notify orchestrator agent"
```

---

## Task 5: CLI — `--skeleton` and `--notify-agent` flags on `add-agent`

**Files:**

- Modify: `cli/src/commands/add-agent.ts`
- Modify: `cli/src/commands/add-agent.test.ts`

- [ ] **Step 1: Write failing tests**

In `cli/src/commands/add-agent.test.ts`, add two cases:

```typescript
it('passes skeleton to addAgent', async () => {
  const addAgent = vi.fn(async () => makeAgent());
  const program = buildProgram(makeClient(addAgent));
  await program.parseAsync(
    ['add-agent', '--task', 'task-1', '--prompt', 'do the thing', '--skeleton', 'researcher'],
    { from: 'user' },
  );
  expect(addAgent).toHaveBeenCalledWith(
    'task-1',
    expect.objectContaining({ skeleton: 'researcher' }),
  );
});

it('passes notify-agent to addAgent', async () => {
  const addAgent = vi.fn(async () => makeAgent());
  const program = buildProgram(makeClient(addAgent));
  await program.parseAsync(
    [
      'add-agent',
      '--task',
      'task-1',
      '--prompt',
      'do the thing',
      '--notify-agent',
      'parent-agent-01',
    ],
    { from: 'user' },
  );
  expect(addAgent).toHaveBeenCalledWith(
    'task-1',
    expect.objectContaining({ notify_agent_id: 'parent-agent-01' }),
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun run test cli/src/commands/add-agent.test.ts
```

Expected: FAIL — no `--skeleton` or `--notify-agent` options.

- [ ] **Step 3: Add flags to `cli/src/commands/add-agent.ts`**

```typescript
export function registerAddAgent(program: Command): void {
  program
    .command('add-agent')
    .description('Add a new agent (tmux window) to an existing running task')
    .requiredOption('-t, --task <task-id>', 'task ID to add the agent to')
    .requiredOption('-p, --prompt <prompt>', 'initial prompt for the new agent')
    .option('-a, --agent <agent-type>', 'Claude Code agent type (e.g. code-reviewer)')
    .option('-l, --label <label>', 'label for the new agent (default: server-assigned "Agent N")')
    .option('--model <id>', 'per-agent model override (e.g. claude-opus-4-8, claude-sonnet-4-6)')
    .option('--skeleton <name>', 'role skeleton to load from <repo>/.octomux/agents/<name>.md')
    .option('--notify-agent <agent-id>', 'agent ID to notify when this agent finishes')
    .action(async (opts, cmd) => {
      const { client, json } = getContext(cmd);

      const payload: {
        prompt: string;
        agent?: string;
        label?: string;
        model?: string;
        skeleton?: string;
        notify_agent_id?: string;
      } = { prompt: opts.prompt };
      if (opts.agent) payload.agent = opts.agent;
      if (opts.label) payload.label = opts.label;
      if (opts.model) payload.model = opts.model;
      if (opts.skeleton) payload.skeleton = opts.skeleton;
      if (opts.notifyAgent) payload.notify_agent_id = opts.notifyAgent;

      const agent = await client.addAgent(opts.task, payload);

      if (json) {
        outputJson(agent);
        return;
      }

      success(`Added agent to task ${opts.task}`);
      console.log(label('Agent ID', agent.id));
      console.log(label('Label', agent.label));
      console.log(label('Window', String(agent.window_index)));
    });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun run test cli/src/commands/add-agent.test.ts
```

Expected: PASS

- [ ] **Step 5: Run full suite + typecheck**

```bash
bun run test && bun run typecheck
```

Expected: all green (same pre-existing typecheck errors, none new).

- [ ] **Step 6: Commit**

```bash
git add cli/src/commands/add-agent.ts cli/src/commands/add-agent.test.ts cli/src/client.ts
git commit -m "feat(cli): add --skeleton and --notify-agent to add-agent command"
```

---

## Task 6: Merge to next

- [ ] **Step 1: Run full suite one final time**

```bash
bun run test
```

Expected: all green.

- [ ] **Step 2: Merge**

```bash
git checkout next
git merge --ff-only <branch-name>
```

- [ ] **Step 3: Rebuild + restart server**

```bash
bun run build && pkill -f "octomux start"; sleep 1 && node bin/octomux.js start &
```

---

## Usage after implementation

An orchestrator agent running inside a task can spawn sub-agents like:

```bash
# Spawn a researcher sub-agent in the same task, notifying back to $CURRENT_AGENT_ID
octomux add-agent \
  --task $OCTOMUX_TASK_ID \
  --skeleton researcher \
  --model claude-sonnet-4-6 \
  --label "Researcher" \
  --notify-agent $OCTOMUX_AGENT_ID \
  --prompt "Research X and summarise findings in desk/research/X.md"
```

When the researcher window exits, octomux sends to the orchestrator's tmux window:

```
[octomux] Sub-agent <id> ("Researcher") finished. Check results: octomux get-task --json <task-id>
```
