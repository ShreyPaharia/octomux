# Phase 2 — Telegram assistant gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner talk to octomux's conductor over Telegram — recall from the agent_learnings store, ask about work, and dispatch/monitor octomux tasks — as a thin adapter over the conductor octomux already runs.

**Architecture:** A channel adapter (grammY, long-poll) turns Telegram messages into conductor turns and posts the conductor's replies back. The brain is the existing conductor (an interactive `claude` session driven via `runner.ts` + transcript tail); Phase 2 adds the adapter, a `(channel, thread) → conv_id` map, inbound dedup, an outbound queue, a `search_learnings` recall tool, secret redaction, and the reliability P0 fixes the review found. Design: `spec/agent-gateway.md`.

**Tech Stack:** TypeScript, Express 5, better-sqlite3 (WAL), grammY (Telegram), the existing octomux conductor + MCP surface, vitest.

## Global Constraints

- Design: `spec/agent-gateway.md`. Scope is **v1**: Telegram only (Slack later), reactive chat, **no per-action approval button** (v2), outward MCP tools attached **read-only by credential**.
- **Security must-keep (v1):** a per-message **default-deny owner allowlist** checked BEFORE any dispatch. This is the only non-deferrable security control.
- **Outward writes are prevented by credential, not code:** outward MCP servers get read-scoped tokens (GitHub MCP also `--read-only`). No write-gate is built in v1. The assistant's only write capability is octomux's own coordination tools (`create_task`, `send_message`), ungated in v1 behind the allowlist.
- All `server/` logs via `childLogger('<module>')` (pino); never `console.*`. Lifecycle logs include a stable id.
- better-sqlite3 is synchronous; migrations forward-only in `server/db/migrations.ts`; SQLite `datetime('now')` single-quoted in template literals.
- Tests: vitest, `NODE_ENV=test`; DB tests use `createTestDb()`.
- Conventional commits: `feat(gateway): …`, kebab scope, ≤100 chars.
- **Do not `git commit` unless the user explicitly says so** (standing rule). Commit steps below are the standard TDD loop; if the human is driving, pause at each.
- **Live end-to-end (a real Telegram bot) is NOT testable in CI** — it needs a BotFather token + a GitHub read PAT (manual, Task 13). Every task here ships **unit tests with mocked transports**; Task 13 is the manual smoke.
- **Grounding rule for conductor-integration tasks (2, 8, 9–12):** the exact signatures live in `server/orchestrator/*.ts`. Each such task's first step is "read the named file(s) and confirm the anchor," because these modify existing, delicate code — do not write blind.

---

### Task 1: `searchShared` — task-less, repo-optional recall over the SHARED lane

Pure extension of the Phase-1 store. Fully self-contained and testable; unblocks the recall tool.

**Files:**

- Modify: `server/repositories/agent-learnings.ts`
- Test: `server/repositories/agent-learnings.test.ts`

**Interfaces:**

- Consumes: existing `SHARED_LANE`, `AgentLearning` type.
- Produces: `searchShared(query: string, opts?: { repo?: string; limit?: number }): AgentLearning[]` — matches `trigger`/`lesson` via `LIKE`, **only the `shared` lane**, dropping the `repo_path` filter when `opts.repo` is absent (cross-repo). Excludes superseded rows. Recency/usage order, default limit 8.

- [ ] **Step 1: Write the failing test**

Add to `server/repositories/agent-learnings.test.ts`:

```typescript
import { addLearning, searchShared, SHARED_LANE } from './agent-learnings.js';

describe('searchShared', () => {
  beforeEach(() => createTestDb());

  it('returns shared-lane matches across all repos when no repo is given', () => {
    addLearning({
      repo_path: '/a',
      lane: SHARED_LANE,
      trigger: 'retry',
      lesson: 'hedging retry lives in retry.ts',
      evidence: 'retry.ts',
    });
    addLearning({
      repo_path: '/b',
      lane: SHARED_LANE,
      trigger: 'tests',
      lesson: 'vitest needs default: mocked',
      evidence: 'setup.ts',
    });
    addLearning({
      repo_path: '/a',
      lane: 'loop:tk1',
      trigger: 'x',
      lesson: 'private retry note',
      evidence: 'e',
    });
    const hits = searchShared('retry').map((l) => l.lesson);
    expect(hits).toContain('hedging retry lives in retry.ts');
    expect(hits).not.toContain('private retry note'); // private lane excluded
  });

  it('filters by repo when given', () => {
    addLearning({
      repo_path: '/a',
      lane: SHARED_LANE,
      trigger: 't',
      lesson: 'in a',
      evidence: 'e',
    });
    addLearning({
      repo_path: '/b',
      lane: SHARED_LANE,
      trigger: 't',
      lesson: 'in b',
      evidence: 'e',
    });
    expect(searchShared('in', { repo: '/a' }).map((l) => l.lesson)).toEqual(['in a']);
  });

  it('excludes superseded rows', () => {
    const row = addLearning({
      repo_path: '/a',
      lane: SHARED_LANE,
      trigger: 't',
      lesson: 'stale',
      evidence: 'e',
    })!;
    // supersede via the existing repository fn
    (require('./agent-learnings.js') as typeof import('./agent-learnings.js')).supersedeLearning(
      row.id,
      'obsolete',
    );
    expect(searchShared('stale').length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test server/repositories/agent-learnings.test.ts -t searchShared`
Expected: FAIL — `searchShared` is not exported.

- [ ] **Step 3: Implement**

Add to `server/repositories/agent-learnings.ts`:

```typescript
export function searchShared(
  query: string,
  opts: { repo?: string; limit?: number } = {},
): AgentLearning[] {
  const q = `%${query.trim()}%`;
  const where = ['lane = ?', 'superseded_at IS NULL', '(trigger LIKE ? OR lesson LIKE ?)'];
  const params: unknown[] = [SHARED_LANE, q, q];
  if (opts.repo) {
    where.unshift('repo_path = ?');
    params.unshift(opts.repo);
  }
  params.push(opts.limit ?? 8);
  return getDb()
    .prepare(
      `SELECT * FROM agent_learnings WHERE ${where.join(' AND ')}
       ORDER BY (last_used_at IS NULL) ASC, last_used_at DESC, usage_count DESC, created_at DESC
       LIMIT ?`,
    )
    .all(...params) as AgentLearning[];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test server/repositories/agent-learnings.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add server/repositories/agent-learnings.ts server/repositories/agent-learnings.test.ts
git commit -m "feat(gateway): searchShared — task-less repo-optional recall over shared lane"
```

---

### Task 2: `search_learnings` — a read tool on the conductor's MCP surface

Exposes Task 1 to the assistant. **Integration task** — modifies the conductor's MCP registration.

**Files (confirm anchors first):**

- Read: `server/orchestrator/command-registry.ts` (the `COMMANDS` registry), `server/orchestrator/mcp/read.ts` (read tools + `POLICY_ONLY_COMMANDS`), `server/orchestrator/mcp/server.ts` (how a read tool is surfaced).
- Modify: whichever of the above register a read tool (follow the exact pattern of `list_tasks`/`recent_repos`).
- Test: the nearest existing MCP/read test (e.g. `server/orchestrator/mcp/read.test.ts` if present, else `server/api.*orchestrator*` test).

**Interfaces:**

- Consumes: `searchShared` (Task 1).
- Produces: an MCP read tool `search_learnings({ query: string, repo?: string })` returning the matched learnings as lean rows (`{ trigger, lesson, evidence, repo_path }[]`), registered as an `auto`/policy-only (never-gated) read.

- [ ] **Step 1: Read + confirm the read-tool pattern**

Read the three files above. Identify exactly how `recent_repos` (a zero/one-arg read) is declared in `COMMANDS`, handled in `read.ts`, and listed in `POLICY_ONLY_COMMANDS`. Mirror it. Note the exact handler signature and the args-schema shape used.

- [ ] **Step 2: Write the failing test**

Following the existing read-tool test pattern, assert that invoking `search_learnings` with `{ query: 'retry' }` returns the shared-lane rows from a seeded `agent_learnings` table, and that the tool is in the policy-only (auto-approved) set. (Reuse the seeding + invocation helpers the neighbouring read-tool tests use.)

- [ ] **Step 3: Run test to verify it fails**

Run: `bun run test <the read-tool test file>`
Expected: FAIL — `search_learnings` not registered.

- [ ] **Step 4: Implement**

Register `search_learnings` in `command-registry.ts` (read tool, `mcp: true`), handle it in `read.ts` by calling `searchShared(query, repo ? { repo } : {})` and mapping to `{ trigger, lesson, evidence, repo_path }`, and add it to `POLICY_ONLY_COMMANDS`. Match the surrounding code exactly (imports, logging via `childLogger`, no raw SQL — call the repository).

- [ ] **Step 5: Run tests + typecheck**

Run: `bun run test <the read-tool test file> && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/orchestrator/
git commit -m "feat(gateway): search_learnings MCP read tool over searchShared"
```

---

### Task 3: Outbound secret redaction (reuse Phase-1 lint patterns)

**Files:**

- Create: `server/gateway/redact.ts`
- Test: `server/gateway/redact.test.ts`

**Interfaces:**

- Consumes: the secret-shape regexes from `server/repositories/learn-lint.ts` (reuse, don't re-derive).
- Produces: `redactSecrets(text: string): string` — replaces secret spans (`postgres://…:…@`, AWS keys, `xox[bap]-…`, `ghp_…`, PEM blocks, `KEY=…` env lines, private-key headers) with `‹redacted›`.

- [ ] **Step 1: Write the failing test**

Create `server/gateway/redact.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  it.each([
    ['db is postgres://svc:S3cr3t@db.prod:5432/x', 'S3cr3t'],
    ['token xoxb-123-abc456', 'xoxb-123-abc456'],
    ['-----BEGIN RSA PRIVATE KEY-----', 'PRIVATE KEY'],
    ['use ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_'],
  ])('redacts %s', (input) => {
    expect(redactSecrets(input)).toContain('‹redacted›');
  });
  it('leaves clean text untouched', () => {
    expect(redactSecrets('the retry lives in retry.ts')).toBe('the retry lives in retry.ts');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test server/gateway/redact.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `server/gateway/redact.ts` — a `SECRET_PATTERNS: RegExp[]` array (same shapes as `learn-lint.ts` plus the `xox[bap]-`, `KEY=` env-line, and `postgres://` credential forms), each applied with `.replace(re, '‹redacted›')`:

```typescript
const SECRET_PATTERNS: RegExp[] = [
  /\b(postgres|postgresql|mysql|mongodb|redis|amqp):\/\/[^\s]*:[^\s@]*@/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(sk|ghp|xox[baprs])-[A-Za-z0-9_-]{12,}\b/g,
  /\b[A-Z0-9_]{3,}=[^\s]{8,}\b/g, // KEY=value env lines
];
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((s, re) => s.replace(re, '‹redacted›'), text);
}
```

- [ ] **Step 4: Run tests + commit**

Run: `bun run test server/gateway/redact.test.ts`
Expected: PASS.

```bash
git add server/gateway/redact.ts server/gateway/redact.test.ts
git commit -m "feat(gateway): outbound secret redaction"
```

---

### Task 4: Owner allowlist (the one v1 security must-keep)

**Files:**

- Create: `server/gateway/allowlist.ts`
- Test: `server/gateway/allowlist.test.ts`

**Interfaces:**

- Produces: `isAllowed(channel: 'telegram' | 'slack', senderId: string): boolean` — default-deny; reads a per-channel id allowlist from env (`OCTOMUX_GATEWAY_TELEGRAM_ALLOW` = comma-separated numeric ids) or a 0600 config file (`~/.octomux/gateway-allowlist.json`). Empty/missing config → deny all.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { isAllowed } from './allowlist.js';

afterEach(() => {
  delete process.env.OCTOMUX_GATEWAY_TELEGRAM_ALLOW;
});

describe('isAllowed', () => {
  it('denies by default when no allowlist configured', () => {
    expect(isAllowed('telegram', '123')).toBe(false);
  });
  it('allows an id in the env allowlist, denies others', () => {
    process.env.OCTOMUX_GATEWAY_TELEGRAM_ALLOW = '123, 456';
    expect(isAllowed('telegram', '123')).toBe(true);
    expect(isAllowed('telegram', '999')).toBe(false);
  });
});
```

- [ ] **Step 2–4:** Run (FAIL) → implement `allowlist.ts` (parse env CSV into a `Set<string>` per channel, default-deny; the config-file path is a fallback read via `fs` guarded by try/catch) → run (PASS).

- [ ] **Step 5: Commit** `feat(gateway): default-deny owner allowlist`.

---

### Task 5: Gateway state — `channel_threads` map + inbound dedup

**Files:**

- Modify: `server/db/migrations.ts` (two tables)
- Create: `server/repositories/gateway.ts`
- Test: `server/repositories/gateway.test.ts`

**Interfaces:**

- Produces:
  - `getThreadConv(channel, threadKey): string | undefined` and `setThreadConv(channel, threadKey, convId): void` (the `(channel, thread) → conv_id` map).
  - `seenInbound(channel, externalId): boolean` and `markInbound(channel, externalId): void` (at-least-once dedup on `update_id`/`event_id`).

- [ ] **Step 1: Write the failing test** — insert/get a thread→conv mapping; `seenInbound` false then true after `markInbound`; distinct channels don't collide. (Mirror `agent-learnings.test.ts` structure with `createTestDb`.)

- [ ] **Step 2: Run (FAIL).**

- [ ] **Step 3: Migration + repository.** Append to `migrations.ts`:

```typescript
// ── Gateway: channel↔conversation map + inbound dedup (2026-07-23) ────────
instance.exec(`
    CREATE TABLE IF NOT EXISTS channel_threads (
      channel     TEXT NOT NULL,
      thread_key  TEXT NOT NULL,
      conv_id     TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (channel, thread_key)
    );
    CREATE TABLE IF NOT EXISTS gateway_inbound (
      channel      TEXT NOT NULL,
      external_id  TEXT NOT NULL,
      seen_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (channel, external_id)
    );
  `);
```

Then `server/repositories/gateway.ts` with the four functions (parameterized `INSERT OR IGNORE` / `SELECT`), logging via `childLogger('gateway-repo')`.

- [ ] **Step 4: Run (PASS) + commit** `feat(gateway): thread→conversation map + inbound dedup store`.

---

### Task 6: `ChannelAdapter` interface + Telegram adapter (grammY)

**Files:**

- Add dependency: `grammy`
- Create: `server/gateway/adapter.ts` (the interface), `server/gateway/telegram.ts` (grammY impl)
- Test: `server/gateway/telegram.test.ts` (grammY's transformer/mock — no live network)

**Interfaces:**

- Produces:
  - `interface ChannelAdapter { id: 'telegram' | 'slack'; start(onMessage: (m: InboundMessage) => Promise<void>): Promise<void>; send(threadKey: string, text: string): Promise<void>; sendTyping(threadKey: string): Promise<void>; }`
  - `interface InboundMessage { channel: string; threadKey: string; senderId: string; externalId: string; text: string; }`
  - `createTelegramAdapter(token: string): ChannelAdapter`

- [ ] **Step 1:** `bun add grammy` (add to root `package.json`; if `grammy` needs to be a trusted dependency for bun native builds, add to `trustedDependencies` like node-pty).

- [ ] **Step 2: Write the failing test.** Use grammY's built-in test transport (`Bot.api.config.use` transformer that intercepts calls, per grammY docs) to assert: an incoming update calls `onMessage` with a normalized `InboundMessage` (`threadKey = chat.id`, `senderId = from.id`, `externalId = update_id`, `text`); `send(threadKey, text)` issues a `sendMessage` with the right `chat_id`+`text`. No real network.

- [ ] **Step 3: Run (FAIL).**

- [ ] **Step 4: Implement `adapter.ts` (types) + `telegram.ts`.** grammY `Bot(token)`, `bot.on('message:text', …)` → normalize → `onMessage`; `send` → `bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' })`; `sendTyping` → `bot.api.sendChatAction(chatId, 'typing')`; `start` → `bot.start()` (long-poll). Keep it a few dozen lines; no middleware framework.

- [ ] **Step 5: Run (PASS) + typecheck + commit** `feat(gateway): ChannelAdapter + Telegram (grammY) adapter`.

---

### Task 7: Outbound queue — per-thread serialize + retry + idempotency

**Files:**

- Create: `server/gateway/outbound.ts`
- Test: `server/gateway/outbound.test.ts`

**Interfaces:**

- Consumes: `ChannelAdapter.send` (Task 6).
- Produces: `class OutboundQueue { constructor(send: (threadKey, text) => Promise<void>); enqueue(threadKey: string, text: string): void }` — one in-flight send per `threadKey` (FIFO), retry with backoff on throw (max 3), and a per-message idempotency guard so a retry-after-timeout doesn't double-send (dedupe on a message key within a short window).

- [ ] **Step 1: Write the failing test** — enqueue two messages to one thread; assert `send` is called in order, one at a time (second awaits the first); a `send` that rejects once is retried and eventually delivered; the same logical message isn't sent twice. Use a mock `send` with controllable resolution.

- [ ] **Step 2–4:** Run (FAIL) → implement (a `Map<threadKey, Promise chain>`; retry wrapper; a short-TTL `Set` of delivered keys) → run (PASS).

- [ ] **Step 5: Commit** `feat(gateway): per-thread outbound queue with retry + idempotency`.

---

### Task 8: Gateway wire-up — the glue

**Integration task.** Ties everything to the conductor. Cannot be fully e2e-tested without a token (Task 13); this task ships a unit test with the conductor calls mocked.

**Files (confirm anchors first):**

- Read: `server/orchestrator/stream.ts` (`dispatchUserTurn`, `pushToConversation`, transcript-tail lifecycle), `server/orchestrator/runner.ts` (`startConversation`/`resumeConversation`), `server/orchestrator/store.ts` (conversation creation), `server/index.ts` (where `startPolling()` and WS wiring live at boot).
- Create: `server/gateway/index.ts` (`startGateway()`), `server/gateway/gateway.test.ts`
- Modify: `server/index.ts` (call `startGateway()` at boot when a token is configured)

**Interfaces:**

- Consumes: `isAllowed` (T4), `getThreadConv`/`setThreadConv`/`seenInbound`/`markInbound` (T5), `createTelegramAdapter` (T6), `OutboundQueue` (T7), `redactSecrets` (T3), and the conductor's turn-in / reply-out primitives (confirm exact names in Step 1).
- Produces: `startGateway(deps): void` — wires an inbound handler.

- [ ] **Step 1: Read + confirm** the conductor primitives: how a conversation is created/resumed for a given cwd, how a user turn is delivered (`dispatchUserTurn`), how the reply is observed (the transcript tail → assistant text → the turn-done boundary from Task 10), and how `pushToConversation` / a programmatic reply callback works. Write down the exact signatures the gateway will call.

- [ ] **Step 2: Write the failing test.** With the conductor primitives mocked, assert the inbound pipeline: an allowed sender's new message → (dedup) → maps/creates a conv → delivers the turn → the mocked reply is redacted → enqueued to outbound; a **denied** sender is dropped (no conv, no turn); a duplicate `externalId` is dropped.

- [ ] **Step 3: Run (FAIL).**

- [ ] **Step 4: Implement `startGateway`:** `adapter.start(async (m) => { if (!isAllowed(m.channel, m.senderId)) return; if (seenInbound(m.channel, m.externalId)) return; markInbound(...); const conv = getThreadConv(...) ?? await createConvForThread(...); setThreadConv(...); await sendTurnAndAwaitReply(conv, m.text); … })`. On reply: `outbound.enqueue(m.threadKey, redactSecrets(rendered))`. Turn-handling policy (debounce idle bursts, interrupt-and-merge when running) is a **follow-up (Task 12 lock first)** — v1 may start with simple serialize-per-thread; leave a `ponytail:` note. Wire `startGateway` into `server/index.ts` behind `if (process.env.OCTOMUX_GATEWAY_TELEGRAM_TOKEN)`.

- [ ] **Step 5: Run (PASS) + typecheck + commit** `feat(gateway): wire inbound→conductor→outbound pipeline`.

---

### Task 9: Conductor P0 — liveness means "claude is alive," and drop the shell fallback

**Integration / delicate.** Closes the "chat text executed as bash" hazard the security + reliability reviews found.

**Files (confirm anchors first):**

- Read + Modify: `server/orchestrator/runner.ts` — `isConversationSessionAlive` (~:543), the launch command building the `claude; exec $SHELL -i` fallback (~:309, ~:394), and `sendTurn` (~:483) which gates on liveness.
- Test: the existing runner test (or add one) asserting the liveness check.

- [ ] **Step 1: Read + confirm** the three anchors and the current liveness check (`tmux has-session`).
- [ ] **Step 2: Write/adjust a failing test** — liveness returns false when the pane's running command is a shell, true when it's `claude`/`node`.
- [ ] **Step 3: Implement:** liveness = `tmux display-message -p '#{pane_current_command}'` matches `node`/`claude` (not the shell); on false, `sendTurn` resumes instead of pasting. Replace the `exec $SHELL -i` tail with a non-interactive hold (`; echo CONDUCTOR_EXITED; read -r _`) so a dead conductor can never accept keystrokes.
- [ ] **Step 4: Run full suite + typecheck** (this touches a live subsystem — run everything). Expected: PASS.
- [ ] **Step 5: Commit** `fix(orchestrator): liveness = claude-alive; drop interactive-shell fallback`.

---

### Task 10: Conductor P0 — explicit turn-completion boundary

**Integration.** The bot must know when a reply is done.

**Files (confirm anchors first):**

- Read: `server/orchestrator/transcript.ts` (`parseLine`; the `stop_hook_summary` system line — confirmed present in `__fixtures__/transcript-2.1.183-basic-qa.jsonl`), `server/orchestrator/stream.ts` (`chatEventToWsEvent`, which currently drops `system` lines).
- Modify: expose a per-turn "stop" signal (an event / callback) keyed off the `stop_hook_summary` line — fire even if the hook errored (presence, not success).
- Test: feed a fixture transcript through the parser and assert one stop signal per turn.

- [ ] **Steps:** read/confirm → failing test (fixture → exactly one stop per user turn) → implement (parse the `system/stop_hook_summary` line in `parseLine`; emit a `turn_done` signal the tail exposes) → run suite → commit `feat(orchestrator): expose per-turn stop boundary for programmatic consumers`.

---

### Task 11: Conductor P0 — gateway-owned transcript tail (decouple from WS clients)

**Integration.** Today the tail only runs while a browser WS is connected; a phone DM with no dashboard is read by nothing.

**Files (confirm anchors first):**

- Read: `server/orchestrator/stream.ts` (`startTranscriptTail` ~:454, teardown on last WS disconnect ~:141), `server/orchestrator/runner.ts` (`rehydrateConversations` ~:620, read-only today).
- Modify: allow a non-WS owner (the gateway) to hold a tail per active thread; `rehydrateConversations` starts tails for threads with a live session on boot.
- Test: assert a tail can be started/stopped independent of any WS client; a gateway-registered consumer receives assistant lines with zero WS clients connected.

- [ ] **Steps:** read/confirm → failing test → implement (refcount the tail by consumers, WS _or_ gateway; start on first consumer, stop on last; boot rehydrate opens tails for live-session threads) → run suite → commit `feat(orchestrator): gateway-owned transcript tail independent of web clients`.

---

### Task 12: Conductor P0 — single FIFO write lock per conversation (+ turn-handling policy)

**Integration.** All writers (user turns + supervisor notes + interrupts) must serialize into one pane; enables the debounce/interrupt policy.

**Files (confirm anchors first):**

- Read: `server/orchestrator/stream.ts` (`dispatchUserTurn` ~:377), `server/orchestrator/supervisor.ts` (its separate per-conv injection chain), `server/orchestrator/runner.ts` (`sendTurn`).
- Modify: one per-conversation FIFO that every writer passes through; each dequeue waits for turn-idle (Task 10's stop boundary, no open tool_use) before pasting. Then implement the gateway turn policy: **debounce** rapid inbound while idle (coalesce), **interrupt-and-merge** when a turn is running (send the interrupt key, then inject) — never interrupt during an approval-wait (n/a in v1, but leave the guard).
- Test: two concurrent writers to one conversation are serialized (second waits for the first's stop); a mid-turn message interrupts and re-injects (assert interrupt issued before the new paste).

- [ ] **Steps:** read/confirm → failing test → implement lock + policy → run suite → commit `feat(orchestrator): single-writer FIFO per conversation + gateway turn policy`.

---

### Task 13: Read-only outward MCP config + manual smoke (needs tokens)

**Files:**

- Create: `docs/gateway-setup.md`
- Modify: gateway MCP config so the assistant conversation attaches outward MCP servers read-only (via the conductor's existing `--mcp-config` / `writeOrchestratorMcpConfig` path).

- [ ] **Step 1:** Read `server/orchestrator/runner.ts` `writeOrchestratorMcpConfig` and confirm how the octomux MCP server is attached. Add an optional block that also attaches, for gateway conversations, the outward MCP servers from config — **GitHub MCP with `--read-only` over stdio + a read-scoped PAT**, and any already-configured Slack/Jira/Linear/Notion MCP servers, read-scoped.
- [ ] **Step 2:** Write `docs/gateway-setup.md`: (a) create a Telegram bot via BotFather, set `OCTOMUX_GATEWAY_TELEGRAM_TOKEN`; (b) add your Telegram numeric id to `OCTOMUX_GATEWAY_TELEGRAM_ALLOW`; (c) create a GitHub fine-grained **read-only** PAT, wire the GitHub MCP `--read-only`; (d) `octomux start`, DM the bot, verify the four-beat (recall → dispatch → approve[v2] → status).
- [ ] **Step 3 (manual smoke — not CI):** run it once locally with real tokens; confirm an allowed DM gets a reply and a non-allowlisted id is silently ignored. Record the result in the doc.
- [ ] **Step 4: Commit** `docs(gateway): setup + read-only outward MCP config`.

---

## Self-Review

**Spec coverage** (against `spec/agent-gateway.md`):

- Owner allowlist → T4 (+ enforced in T8). ✓
- Outward read-only by credential → T13 (config) + the "no write-gate" constraint. ✓
- Recall (task-less, cross-repo) → T1 + T2. ✓
- Channel adapter (Telegram, grammY) → T6. ✓
- Session map + inbound dedup → T5. ✓
- Outbound queue (retry/idempotency) → T7. ✓
- Secret redaction → T3. ✓
- Transport P0s (liveness/shell, turn boundary, gateway-owned tail, FIFO+policy) → T9–T12. ✓
- Turn-handling policy (debounce/interrupt) → T12. ✓
- Streaming/typing/rendering UX → partially (T6 has `sendTyping`, HTML parse mode; full streaming/rendering is a v1.1 follow-up — noted, not a gap for the reactive slice).
- Slack, approval button → **out of v1 scope** (deferred), as the spec states.

**Placeholder scan:** Tasks 1, 3, 4, 5, 7 are fully concrete. Tasks 2, 8, 9–13 are **integration/delicate** and their Step 1 is explicitly "read the named file + confirm the anchor" — this is deliberate for modifying existing, delicate conductor code (the plan gives exact files, anchors, and the precise change), not a hidden placeholder. No `TBD`/`TODO`.

**Type consistency:** `searchShared(query, {repo?})` → `AgentLearning[]` matches T1↔T2. `InboundMessage`/`ChannelAdapter` shapes match T6↔T7↔T8. `getThreadConv`/`seenInbound` names match T5↔T8. `redactSecrets` T3↔T8. `turn_done`/stop-boundary T10↔T12.

## Notes for the executor

- **Order:** T1→T5 are self-contained and fully testable — build and verify these first. T6–T8 are the adapter + glue (unit-tested, token-gated for live). T9–T12 are the conductor P0 fixes — **run the full suite after each**, they touch a live subsystem. T13 is manual (tokens).
- The **live bot is not CI-testable** — T13 is the human smoke. Everything before it ships with mocked-transport unit tests.
- Standing rule: **do not commit unless the user says so.**
