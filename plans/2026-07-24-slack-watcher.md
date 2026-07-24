# Slack Watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cron-scheduled headless workflow (`slack-watcher`) that reads the owner's inbox in the watched (company) workspace via the claude.ai Slack MCP connector and has the gateway bot — in the owner's personal workspace — DM a concise digest with suggested replies, only when something needs the owner.

**Architecture:** New workflow kind modeled exactly on `overnight-log-summary`: `schema.ts` (config + output JSON Schemas), `run.ts` (skill-body interpolation + `runSessionVertical`), `index.ts` (registry entry), shipped skill at `plugin/skills/slack-watcher/SKILL.md` seeded into the `schedule_skills` DB table on first read. The skill reads via the Slack MCP connector tools and posts via `curl` with the gateway bot token inherited from the server's env. Spec: `spec/slack-watcher.md`.

**Tech Stack:** TypeScript (Express 5 server), vitest, better-sqlite3 test DB via `createTestDb()`, Ajv for schema tests, Slack Web API over curl (no new npm deps).

## Global Constraints

- Conventional commits: `feat(scope): message`, kebab-case scope, header ≤ 100 chars.
- Prettier: single quotes, trailing commas, 100 char width, semicolons. Run `bun run format` before committing if unsure.
- Server files use `const logger = childLogger('<module>');` — never `console.*` in `server/`.
- Tests: vitest, `NODE_ENV=test` is set by vitest.config.ts. Run a single file with `bun run vitest run <path>`.
- Full gates before PR: `bun run test`, `bun run typecheck`, `bun run lint`.
- The frontend /schedules form is schema-driven from the workflow `config` schema — **no UI changes are needed**.
- The agent never sends Slack messages as the owner. Only the bot posts, and only the digest.

---

### Task 1: Config + output schemas

**Files:**
- Create: `server/workflows/slack-watcher/schema.ts`
- Test: `server/workflows/slack-watcher/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SLACK_WATCHER_CONFIG_SCHEMA` (object schema with `slackUserId: string` default `''` — member id in the **watched** workspace, `digestUserId: string` default `''` — member id in the **bot's** workspace, `lookbackMinutes: number` default `40`, `digestChannel: string` default `''`) and `SLACK_WATCHER_SCHEMA` (submit_result payload: required `outcome`, `window`, `summary`, `digestSent`, `items`; optional `links`). Item shape: `{ channel, from, about, urgency: 'low'|'medium'|'high', suggestedReply?, permalink? }`.

- [ ] **Step 1: Write the failing test**

`server/workflows/slack-watcher/schema.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { SLACK_WATCHER_CONFIG_SCHEMA, SLACK_WATCHER_SCHEMA } from './schema.js';

describe('SLACK_WATCHER_SCHEMA', () => {
  it('requires the run-result envelope alongside kind-specific fields', () => {
    const validate = new Ajv({ useDefaults: true }).compile(SLACK_WATCHER_SCHEMA);

    expect(validate({ window: '40m', summary: 'ok', digestSent: false, items: [] })).toBe(false);
    expect(
      validate({ outcome: 'done', window: '40m', summary: 'ok', digestSent: false, items: [] }),
    ).toBe(true);
  });

  it('accepts a full digest item and rejects an unknown urgency', () => {
    const validate = new Ajv().compile(SLACK_WATCHER_SCHEMA);
    const base = { outcome: 'done', window: '40m', summary: '1 item', digestSent: true };

    expect(
      validate({
        ...base,
        items: [
          {
            channel: '#deploys',
            from: 'Priya',
            about: 'Blocked on the deploy config',
            urgency: 'high',
            suggestedReply: 'Use the staging override for now.',
            permalink: 'https://slack.com/archives/C1/p1',
          },
        ],
      }),
    ).toBe(true);
    expect(
      validate({
        ...base,
        items: [{ channel: '#x', from: 'a', about: 'b', urgency: 'urgent' }],
      }),
    ).toBe(false);
  });

  it('applies config defaults for digestUserId, lookbackMinutes, and digestChannel', () => {
    const validate = new Ajv({ useDefaults: true }).compile(SLACK_WATCHER_CONFIG_SCHEMA);
    const cfg: Record<string, unknown> = { slackUserId: 'U01ABCDEF' };

    expect(validate(cfg)).toBe(true);
    expect(cfg.digestUserId).toBe('');
    expect(cfg.lookbackMinutes).toBe(40);
    expect(cfg.digestChannel).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run server/workflows/slack-watcher/schema.test.ts`
Expected: FAIL — cannot resolve `./schema.js`.

- [ ] **Step 3: Write the schemas**

`server/workflows/slack-watcher/schema.ts`:

```typescript
/** JSON Schemas for the slack-watcher vertical. Split out from index.ts so
 * run.ts can import them without a circular dependency.
 *
 * `outcome` + `links` are the universal run-result envelope (see
 * `RUN_RESULT_SCHEMA` in @octomux/types, spec/workflow-consolidation.md §5). */
export const SLACK_WATCHER_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    slackUserId: {
      type: 'string',
      title: 'Watched member id',
      description:
        "The owner's member id in the watched workspace (e.g. U01ABCDEF) — whose inbox to search.",
      default: '',
    },
    digestUserId: {
      type: 'string',
      title: 'Digest member id',
      description:
        "The owner's member id in the bot's workspace — whom the bot DMs. Same as the watched id when both halves share a workspace.",
      default: '',
    },
    lookbackMinutes: {
      type: 'number',
      title: 'Lookback minutes',
      description: 'How far back each run scans — cron interval plus overlap so nothing is missed.',
      default: 40,
    },
    digestChannel: {
      type: 'string',
      title: 'Digest channel id',
      description: 'Channel for the digest. Empty = the bot opens a DM with the owner.',
      default: '',
    },
  },
  additionalProperties: false,
};

export const SLACK_WATCHER_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['done', 'blocked', 'failed'] },
    window: { type: 'string' },
    summary: { type: 'string' },
    digestSent: { type: 'boolean' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
          from: { type: 'string' },
          about: { type: 'string' },
          urgency: { type: 'string', enum: ['low', 'medium', 'high'] },
          suggestedReply: { type: 'string' },
          permalink: { type: 'string' },
        },
        required: ['channel', 'from', 'about', 'urgency'],
        additionalProperties: false,
      },
    },
    links: {
      type: 'array',
      items: {
        type: 'object',
        required: ['label', 'url'],
        properties: { label: { type: 'string' }, url: { type: 'string' } },
        additionalProperties: false,
      },
    },
  },
  required: ['outcome', 'window', 'summary', 'digestSent', 'items'],
  additionalProperties: false,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run server/workflows/slack-watcher/schema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/workflows/slack-watcher/schema.ts server/workflows/slack-watcher/schema.test.ts
git commit -m "feat(workflows): slack-watcher config and output schemas"
```

---

### Task 2: Run service with dedup memory

**Files:**
- Create: `server/workflows/slack-watcher/run.ts`
- Modify: `server/schedule-prompt.ts:13-19` (add `'slack-watcher'` to `CRON_PROMPT_KINDS`)
- Test: `server/workflows/slack-watcher/run.test.ts`

**Interfaces:**
- Consumes: `SLACK_WATCHER_SCHEMA` from Task 1; existing `resolveSchedulePrompt({ scheduleId, kind })`, `runSessionVertical(input)`, `listRunsForWorkflow(kind)`, `insertRun` / `finishRun` (tests only).
- Produces: `runSlackWatcher(input: RunSlackWatcherInput): Promise<{ result: SlackWatcherResult }>` with `RunSlackWatcherInput = { repoPath: string; scheduleId?: string | null; slackUserId: string; digestUserId: string; lookbackMinutes: number; digestChannel: string; trigger?: 'cron' | 'manual' }`, plus exported `SlackWatcherResult` / `SlackWatcherItem` types and `previousItemsJson(): string`.

- [ ] **Step 1: Write the failing test**

`server/workflows/slack-watcher/run.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from '../../test-helpers.js';
import { insertRun, finishRun } from '../../repositories/runs.js';

const mockGetSkill = vi.fn();
const mockRunSessionVertical = vi.fn();

vi.mock('../../skills.js', () => ({
  getSkill: (...args: unknown[]) => mockGetSkill(...args),
}));
vi.mock('../../services/session-vertical-service.js', () => ({
  runSessionVertical: (...args: unknown[]) => mockRunSessionVertical(...args),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { runSlackWatcher, previousItemsJson } from './run.js';
import { SLACK_WATCHER_SCHEMA } from './schema.js';

const SKILL_BODY =
  'Watch {{slackUserId}} back {{lookbackMinutes}}m, DM {{digestUserId}} at "{{digestChannel}}", skip {{previousItems}}.';

describe('runSlackWatcher', () => {
  beforeEach(() => {
    createTestDb();
    mockGetSkill.mockReset();
    mockRunSessionVertical.mockReset();
    mockGetSkill.mockResolvedValue({ name: 'slack-watcher', content: SKILL_BODY });
    mockRunSessionVertical.mockResolvedValue({ result: { summary: 'ok' } });
  });

  it('interpolates config placeholders and calls runSessionVertical', async () => {
    const { result } = await runSlackWatcher({
      repoPath: '/repos/octomux',
      scheduleId: 'sched-1',
      slackUserId: 'U01ABCDEF',
      digestUserId: 'U0PERSONAL',
      lookbackMinutes: 40,
      digestChannel: '',
    });

    expect(result).toEqual({ summary: 'ok' });
    expect(mockGetSkill).toHaveBeenCalledWith('slack-watcher');
    const call = mockRunSessionVertical.mock.calls[0][0];
    expect(call.kind).toBe('slack-watcher');
    expect(call.scheduleId).toBe('sched-1');
    expect(call.workspaceDir).toBe('/repos/octomux');
    expect(call.input).toBe('Watch U01ABCDEF back 40m, DM U0PERSONAL at "", skip [].');
    expect(call.outputSchema).toBe(SLACK_WATCHER_SCHEMA);
  });

  it('threads the previous done run’s items into {{previousItems}}', async () => {
    const items = [{ channel: '#x', from: 'Priya', about: 'deploy', urgency: 'high' }];
    const run = insertRun({ workflowKind: 'slack-watcher', trigger: 'cron' });
    finishRun(run.id, {
      status: 'done',
      result: { outcome: 'done', window: '40m', summary: '1', digestSent: true, items },
    });

    expect(previousItemsJson()).toBe(JSON.stringify(items));

    await runSlackWatcher({
      repoPath: '/repos/octomux',
      slackUserId: 'U01ABCDEF',
      digestUserId: 'U0PERSONAL',
      lookbackMinutes: 40,
      digestChannel: 'C123',
    });
    const call = mockRunSessionVertical.mock.calls[0][0];
    expect(call.input).toContain(JSON.stringify(items));
    expect(call.input).toContain('DM U0PERSONAL at "C123"');
  });

  it('falls back to [] for missing, unfinished, or malformed previous runs', () => {
    expect(previousItemsJson()).toBe('[]');

    const running = insertRun({ workflowKind: 'slack-watcher', trigger: 'cron' });
    expect(previousItemsJson()).toBe('[]'); // running run has no result yet

    finishRun(running.id, { status: 'failed', error: 'boom' });
    expect(previousItemsJson()).toBe('[]'); // failed run is not dedup memory
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run server/workflows/slack-watcher/run.test.ts`
Expected: FAIL — cannot resolve `./run.js`.

- [ ] **Step 3: Add the kind to CRON_PROMPT_KINDS**

In `server/schedule-prompt.ts`, extend the array (order matches the existing list style):

```typescript
export const CRON_PROMPT_KINDS = [
  'doc-drift',
  'prod-log-triage',
  'weekly-update',
  'overnight-log-summary',
  'daily-plan',
  'slack-watcher',
] as const;
```

`slack-watcher` is **not** added to `TASK_BACKED_KINDS` — it is a session vertical, not task-backed.

- [ ] **Step 4: Write the run service**

`server/workflows/slack-watcher/run.ts`:

```typescript
/**
 * Service layer for the slack-watcher vertical: loads the skill body,
 * interpolates schedule config plus the previous run's digested items (the
 * dedup memory), and runs headless via `runSessionVertical`. Slack tokens
 * reach the skill through the server's inherited environment — see
 * spec/slack-watcher.md §Slack app tokens.
 */
import { resolveSchedulePrompt } from '../../schedule-prompt.js';
import { listRunsForWorkflow } from '../../repositories/runs.js';
import { runSessionVertical } from '../../services/session-vertical-service.js';
import { SLACK_WATCHER_SCHEMA } from './schema.js';

export interface RunSlackWatcherInput {
  repoPath: string;
  scheduleId?: string | null;
  /** Owner's member id in the watched workspace — whose inbox to search. */
  slackUserId: string;
  /** Owner's member id in the bot's workspace — whom the bot DMs. */
  digestUserId: string;
  lookbackMinutes: number;
  digestChannel: string;
  trigger?: 'cron' | 'manual';
}

export interface SlackWatcherItem {
  channel: string;
  from: string;
  about: string;
  urgency: 'low' | 'medium' | 'high';
  suggestedReply?: string;
  permalink?: string;
}

export interface SlackWatcherResult {
  outcome: 'done' | 'blocked' | 'failed';
  window: string;
  summary: string;
  digestSent: boolean;
  items: SlackWatcherItem[];
}

/** Items from the most recent finished run — injected as the skill's dedup memory. */
export function previousItemsJson(): string {
  const last = listRunsForWorkflow('slack-watcher').find(
    (r) => r.status === 'done' && r.result_json,
  );
  if (!last) return '[]';
  try {
    const result = JSON.parse(last.result_json!) as { items?: unknown };
    return JSON.stringify(Array.isArray(result.items) ? result.items : []);
  } catch {
    return '[]';
  }
}

export async function runSlackWatcher(
  input: RunSlackWatcherInput,
): Promise<{ result: SlackWatcherResult }> {
  const skillContent = await resolveSchedulePrompt({
    scheduleId: input.scheduleId,
    kind: 'slack-watcher',
  });
  const prompt = skillContent
    .replace(/\{\{slackUserId\}\}/g, input.slackUserId)
    .replace(/\{\{digestUserId\}\}/g, input.digestUserId)
    .replace(/\{\{lookbackMinutes\}\}/g, String(input.lookbackMinutes))
    .replace(/\{\{digestChannel\}\}/g, input.digestChannel)
    .replace(/\{\{previousItems\}\}/g, previousItemsJson());

  return runSessionVertical<SlackWatcherResult>({
    kind: 'slack-watcher',
    scheduleId: input.scheduleId,
    workspaceDir: input.repoPath,
    input: prompt,
    outputSchema: SLACK_WATCHER_SCHEMA,
    trigger: input.trigger ?? 'cron',
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run vitest run server/workflows/slack-watcher/run.test.ts server/schedule-prompt.test.ts`
Expected: PASS (both files — schedule-prompt tests must not regress).

- [ ] **Step 6: Commit**

```bash
git add server/workflows/slack-watcher/run.ts server/workflows/slack-watcher/run.test.ts server/schedule-prompt.ts
git commit -m "feat(workflows): slack-watcher run service with previous-run dedup memory"
```

---

### Task 3: Shipped skill prompt

**Files:**
- Create: `plugin/skills/slack-watcher/SKILL.md`

**Interfaces:**
- Consumes: placeholders `{{slackUserId}}`, `{{digestUserId}}`, `{{lookbackMinutes}}`, `{{digestChannel}}`, `{{previousItems}}` (interpolated by Task 2), the Slack MCP connector tools for reads, and `OCTOMUX_GATEWAY_SLACK_BOT_TOKEN` (inherited from the server process) for posting.
- Produces: the prompt body that `getSkill('slack-watcher')` returns and `resolveScheduleSkillContent` seeds into the `schedule_skills` table. Its `submit_result` payload must match `SLACK_WATCHER_SCHEMA` from Task 1.

- [ ] **Step 1: Write the skill**

`plugin/skills/slack-watcher/SKILL.md` (this is prompt content — there is no unit test; Task 4's registration test plus the live smoke test in Task 6 cover it):

````markdown
---
name: slack-watcher
description: Use when running a scheduled slack-watcher session — scan the owner's Slack inbox for new messages that need them, DM a concise digest with suggested replies via the bot, and submit a structured result via submit_result
---

# Slack watcher

Scan the owner's Slack inbox for the last {{lookbackMinutes}} minutes and, only if
something needs them, send one concise digest DM through the octomux bot. This is a
headless, unattended session — you do not edit files, commit, or open PRs. Your only
side effects are Slack MCP reads, at most one bot-token `chat.postMessage`, and one
`submit_result` call.

The owner's member id in the **watched** workspace is `{{slackUserId}}` (use it for all
inbox searches). Their member id in the **bot's** workspace is `{{digestUserId}}` (use
it only to open the digest DM) — the two workspaces may differ, so never mix the ids up.

## Slack access

Reads and writes use **different credentials in different workspaces** — never mix them:

- **Inbox reads (watched workspace):** your Slack MCP connector tools —
  `slack_search_public_and_private`, `slack_read_thread`, `slack_read_channel`,
  `slack_search_users`. You must never call the connector's send/draft/canvas tools.
- **Posting the digest (bot's workspace):** `OCTOMUX_GATEWAY_SLACK_BOT_TOKEN` (xoxb-,
  inherited from the server env) via `curl` — this is the only send you ever perform.

Before anything else, confirm the Slack MCP tools are available. If they are not, or the
bot token is missing, or a Slack call fails with an auth error: do not retry endlessly —
call `submit_result` with `outcome: "blocked"`, name exactly what was missing or the
exact Slack error string in `summary`, and stop.

## Steps

1. **Compute the window.** `SINCE=$(date -d "-{{lookbackMinutes}} minutes" +%s)` —
   only messages with `ts >= $SINCE` count.

2. **Collect candidates** with the Slack MCP tools (watched workspace):

   - Mentions: `slack_search_public_and_private` with a query for `<@{{slackUserId}}>`,
     newest first.
   - DMs to the owner: the same search tool with an `is:dm` query (and `is:mpim` for
     group DMs).
   - Keep only hits inside the window, then pull thread context with
     `slack_read_thread` (or nearby channel history with `slack_read_channel`) so you
     understand what is actually being asked. Use `slack_search_users` to resolve
     display names when a hit only gives you a user id.

3. **Filter ruthlessly.** Drop: messages authored by `{{slackUserId}}`; bot and app
   messages; joins/leaves and other channel noise; FYI-only chatter with no question
   or request directed at the owner; and anything already covered by a previous
   digest — the items below were already reported, so skip their threads unless a
   **new** message arrived after the window they were reported in:

   ```json
   {{previousItems}}
   ```

4. **Compose the digest** — natural, human, concise. For each item (max 10, ordered
   by urgency): who and where, what it's about in plain language, and a suggested
   reply written in the owner's voice — short, direct, no corporate filler, ready to
   paste as-is. Format:

   ```
   *Slack digest — <n> things need you*

   1. *Priya · #deploys* — blocked on the staging deploy config, asking if she
      should wait for your chart fix.
      ↳ suggested: "Use the staging override for now — I'll land the chart fix
      tomorrow morning."
   ```

   Never include token values, API keys, connection strings, or other secret shapes
   in the digest — refer to them ("the staging token") without quoting them.

5. **Send it** with the bot token — only if at least one item survived filtering.
   Resolve the channel: use `{{digestChannel}}` if non-empty, otherwise
   `curl -s -X POST https://slack.com/api/conversations.open -H "Authorization: Bearer $OCTOMUX_GATEWAY_SLACK_BOT_TOKEN" -d "users={{digestUserId}}"`
   and take `.channel.id`. Then one
   `chat.postMessage` with the digest as `text`. **Zero items → send nothing.**
   Silence is the correct output for a quiet window.

6. **Call `submit_result` exactly once** with:

   ```json
   {
     "outcome": "done",
     "window": "<e.g. last 40 minutes>",
     "summary": "<one line: '3 items need attention' or 'nothing needs attention'>",
     "digestSent": true,
     "items": [
       {
         "channel": "#deploys",
         "from": "Priya",
         "about": "Blocked on the staging deploy config",
         "urgency": "high",
         "suggestedReply": "Use the staging override for now — I'll land the chart fix tomorrow morning.",
         "permalink": "https://…"
       }
     ]
   }
   ```

   `items` must list everything you digested this run (it becomes the next run's
   dedup memory), and be `[]` with `digestSent: false` on a quiet window.
   `outcome`: `"done"` normally, `"blocked"` for token/auth problems, `"failed"`
   only if composing/sending itself broke.

## Notes

- Be conservative — this runs unattended. When unsure whether something needs the
  owner, prefer including it at `low` urgency over silently dropping it.
- Never send any message other than the single digest, and never post as the owner —
  reads happen through the connector, but its send/draft tools are off-limits; the only
  send you perform is the one bot-token `chat.postMessage`. Do not look for workarounds.
- Suggested replies are suggestions. The owner sends them; you never do.
````

- [ ] **Step 2: Verify the skill loads**

Run: `bun run vitest run server/schedule-prompt.test.ts`
Expected: PASS. Also sanity-check frontmatter parses: `head -5 plugin/skills/slack-watcher/SKILL.md` shows the `name: slack-watcher` block.

- [ ] **Step 3: Commit**

```bash
git add plugin/skills/slack-watcher/SKILL.md
git commit -m "feat(skills): slack-watcher digest skill"
```

---

### Task 4: Workflow registration

**Files:**
- Create: `server/workflows/slack-watcher/index.ts`
- Modify: `server/workflows/index.ts:1-9` (side-effect import, alphabetical)
- Test: `server/workflows/slack-watcher/index.test.ts`

**Interfaces:**
- Consumes: `runSlackWatcher` (Task 2), both schemas (Task 1), `registerWorkflow` / `RunContext` / `WorkflowType`, `resolveWorkflowConfig` (tests).
- Produces: registered kind `slack-watcher` (displayName `Slack Watcher`, `surfaces: ['artifact']`, cron trigger) — visible to the /schedules form and `listCronWorkflowKinds()`.

- [ ] **Step 1: Write the failing test**

`server/workflows/slack-watcher/index.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWorkflow, listWorkflows, listCronWorkflowKinds } from '../registry.js';
import { resolveWorkflowConfig } from '../config.js';
import type { ScheduleRow } from '../../repositories/schedules.js';

const mockRunSlackWatcher = vi.fn().mockResolvedValue({ result: {} });

vi.mock('./run.js', () => ({
  runSlackWatcher: (...args: unknown[]) => mockRunSlackWatcher(...args),
}));

import './index.js';

function makeRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 'sched1',
    kind: 'slack-watcher',
    repo_path: '/repo',
    cron: '*/30 3-18 * * *',
    enabled: 1,
    last_run_at: null,
    config_json: null,
    ...overrides,
  };
}

describe('slack-watcher workflow registration', () => {
  beforeEach(() => {
    mockRunSlackWatcher.mockClear();
  });

  it('registers the kind with an artifact surface, config, output schema, cron trigger', () => {
    const wf = getWorkflow('slack-watcher');
    expect(wf).toBeDefined();
    expect(wf?.displayName).toBe('Slack Watcher');
    expect(wf?.surfaces).toEqual(['artifact']);
    expect(wf?.config).toBeDefined();
    expect(wf?.output).toBeDefined();
    expect(wf?.trigger).toEqual({ kind: 'cron' });
  });

  it('appears in listWorkflows() and listCronWorkflowKinds()', () => {
    expect(listWorkflows().some((w) => w.kind === 'slack-watcher')).toBe(true);
    expect(listCronWorkflowKinds()).toContain('slack-watcher');
  });

  it('fires the run with schedule id and config defaults, without awaiting it', async () => {
    mockRunSlackWatcher.mockReturnValue(new Promise(() => {}));

    const wf = getWorkflow('slack-watcher')!;
    const row = makeRow({ id: 'sched-42', config_json: JSON.stringify({ slackUserId: 'U07X' }) });
    await wf.run!({
      repoPath: row.repo_path,
      config: resolveWorkflowConfig(wf, row.config_json),
      scheduleId: row.id,
    });

    expect(mockRunSlackWatcher).toHaveBeenCalledTimes(1);
    const call = mockRunSlackWatcher.mock.calls[0][0];
    expect(call.repoPath).toBe('/repo');
    expect(call.scheduleId).toBe('sched-42');
    expect(call.slackUserId).toBe('U07X');
    expect(call.digestUserId).toBe('');
    expect(call.lookbackMinutes).toBe(40);
    expect(call.digestChannel).toBe('');
  });

  it('passes through config overrides for digest user, lookback, and digest channel', async () => {
    const wf = getWorkflow('slack-watcher')!;
    const row = makeRow({
      config_json: JSON.stringify({
        slackUserId: 'U07X',
        digestUserId: 'U0PERSONAL',
        lookbackMinutes: 20,
        digestChannel: 'C9',
      }),
    });
    await wf.run!({
      repoPath: row.repo_path,
      config: resolveWorkflowConfig(wf, row.config_json),
      scheduleId: row.id,
    });

    const call = mockRunSlackWatcher.mock.calls[0][0];
    expect(call.digestUserId).toBe('U0PERSONAL');
    expect(call.lookbackMinutes).toBe(20);
    expect(call.digestChannel).toBe('C9');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run server/workflows/slack-watcher/index.test.ts`
Expected: FAIL — cannot resolve `./index.js`.

- [ ] **Step 3: Write the registration**

`server/workflows/slack-watcher/index.ts`:

```typescript
import { registerWorkflow } from '../registry.js';
import { childLogger } from '../../logger.js';
import { runSlackWatcher } from './run.js';
import { SLACK_WATCHER_CONFIG_SCHEMA, SLACK_WATCHER_SCHEMA } from './schema.js';
import type { RunContext, WorkflowType } from '../types.js';

const logger = childLogger('workflows/slack-watcher');

export const slackWatcherWorkflow: WorkflowType = {
  kind: 'slack-watcher',
  displayName: 'Slack Watcher',
  surfaces: ['artifact'],
  config: SLACK_WATCHER_CONFIG_SCHEMA,
  output: SLACK_WATCHER_SCHEMA,
  trigger: { kind: 'cron' },
  run: (ctx: RunContext) => {
    logger.info(
      { repo_path: ctx.repoPath, schedule_id: ctx.scheduleId },
      'slack-watcher: schedule fired',
    );
    const cfg = ctx.config as {
      slackUserId: string;
      lookbackMinutes: number;
      digestChannel: string;
    };

    // Fire-and-forget: runSessionVertical blocks for the full headless agent run.
    void runSlackWatcher({
      repoPath: ctx.repoPath,
      scheduleId: ctx.scheduleId,
      slackUserId: cfg.slackUserId,
      lookbackMinutes: cfg.lookbackMinutes,
      digestChannel: cfg.digestChannel,
      trigger: ctx.trigger,
    }).catch((err) => {
      logger.error(
        { err, repo_path: ctx.repoPath, schedule_id: ctx.scheduleId },
        'slack-watcher: run failed',
      );
    });
    return Promise.resolve();
  },
};

registerWorkflow(slackWatcherWorkflow);
```

In `server/workflows/index.ts`, add the side-effect import between `reviewer` and `weekly-update`:

```typescript
import './slack-watcher/index.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run vitest run server/workflows/slack-watcher/ server/workflows/registry.test.ts`
Expected: PASS (all slack-watcher files + registry untouched).

- [ ] **Step 5: Commit**

```bash
git add server/workflows/slack-watcher/index.ts server/workflows/slack-watcher/index.test.ts server/workflows/index.ts
git commit -m "feat(workflows): register slack-watcher cron workflow kind"
```

---

### Task 5: Gateway README — watcher setup docs

**Files:**
- Modify: `server/gateway/README.md` (new section after the Slack smoke test + "Not in v1" footer). The conductor manifest is untouched — v1 reads via the claude.ai Slack MCP connector, not a user token.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: operator docs for the two-workspace model and the v1.1 reader-app hardening path.

- [ ] **Step 1: Document the watcher in the README**

In `server/gateway/README.md`:

a. After the Slack "§7 smoke test" section, add:

```markdown
## Slack watcher (proactive digest)

The `slack-watcher` scheduled workflow (spec: [`spec/slack-watcher.md`](../../spec/slack-watcher.md))
scans the **owner's** inbox on a cron and has this same bot DM a concise digest with
suggested replies. Reads and writes are split across workspaces:

- **Inbox reads** happen in the *watched* workspace through the claude.ai Slack MCP
  connector the headless session inherits — no app install in that workspace. If the
  connector is unavailable in headless runs, watcher runs land as `blocked` on the
  /runs feed naming the missing tools.
- **Digest posting** uses this gateway's bot (`OCTOMUX_GATEWAY_SLACK_BOT_TOKEN`) in the
  bot's own workspace — no extra env vars.

Create the schedule at `/schedules` (kind **Slack Watcher**, cron e.g.
`*/30 3-18 * * *` — cron is UTC) with two member ids in the config: `slackUserId`
(watched workspace — whose inbox) and `digestUserId` (bot's workspace — whom to DM).

Hardening (v1.1, once the watched workspace allows an app install): a minimal
user-scopes-only reader app (`search:read`, `im:history`, `mpim:history`,
`channels:history`, `groups:history`) minting a read-only `xoxp-` token in
`OCTOMUX_SLACK_USER_TOKEN` replaces the MCP dependency.
```

b. In the final "## Not in v1" section, remove "proactive nudges (fast-follow)" and note it:

```markdown
The per-action approval button (v2) · full streaming/rich rendering (v1.1). Proactive
nudges shipped as the `slack-watcher` scheduled workflow — see above.
```

- [ ] **Step 2: Commit**

```bash
git add server/gateway/README.md
git commit -m "docs(gateway): slack-watcher digest setup and two-workspace model"
```

---

### Task 6: Full verification + PR

**Files:**
- No new files. Gates over the whole branch.

- [ ] **Step 1: Run the full gates**

```bash
bun run typecheck && bun run lint && bun run test
```
Expected: all pass. Fix anything that fails before proceeding (prettier width on the new files is the usual culprit — `bun run format`).

- [ ] **Step 2: Open the PR**

Push the branch and open a PR against `next` titled `feat(workflows): slack-watcher proactive inbox digest`, body summarizing spec + plan links (`spec/slack-watcher.md`, `plans/2026-07-24-slack-watcher.md`), ending with the standard generated-with footer.

---

### Task 7: Live devbox setup (after merge — interactive, owner in the loop)

**Files:** none (production config on this devbox).

This task is checklist-style, not TDD — it configures the live instance at `~/.octomux/`.

- [ ] **Step 1: Conductor app in the personal workspace.** Only the Telegram gateway is live today. Send the owner (Slack self-DM, per user rules) the api.slack.com/apps link + the conductor manifest with instructions: create the app **in their personal workspace** from `server/gateway/slack-app-manifest.yaml`, enable Socket Mode, install, and hand back the `xoxb-` + `xapp-` tokens and their personal-workspace member id (profile → ⋯ → Copy member ID).
- [ ] **Step 2: Env.** Add to the `.env` octomux boots from: `OCTOMUX_GATEWAY_SLACK_BOT_TOKEN`, `OCTOMUX_GATEWAY_SLACK_APP_TOKEN`, `OCTOMUX_GATEWAY_SLACK_ALLOW=<personal-workspace member id>`. Restart octomux; verify `gateway: Slack gateway started` in `~/.octomux/logs/octomux.log`. No watcher-specific env vars — inbox reads use the claude.ai Slack connector.
- [ ] **Step 3: Stop hook.** Verify the no-op Stop hook exists in `~/.claude/settings.json` (known requirement: without it, gateway replies buffer forever).
- [ ] **Step 4: Create the schedule.** `POST /api/schedules` (or /schedules UI): kind `slack-watcher`, repo path = the octomux repo, cron `*/30 3-18 * * *`, config `{ "slackUserId": "<watched-workspace member id>", "digestUserId": "<personal-workspace member id>" }`.
- [ ] **Step 5: Smoke test.** `POST /api/schedules/:id/run` → watch the run on the /runs feed. This first run doubles as the **MCP-in-headless check**: a `blocked` result naming missing Slack tools means the claude.ai connector isn't reachable headless, and the v1.1 reader app becomes the unblocker. Otherwise: digest DM arrives (or a clean `digestSent: false` result on a quiet window) → reply to the digest DM and confirm the gateway conductor responds → check `grep slack-watcher ~/.octomux/logs/octomux.log` for a clean run. Record the result in the README smoke-test table.
