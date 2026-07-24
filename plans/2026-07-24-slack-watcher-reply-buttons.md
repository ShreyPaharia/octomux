# Slack Watcher Reply Buttons Implementation Plan

> **STATUS: partially shipped, remainder CANCELLED (2026-07-24).** Tasks 1–2 landed
> (item reply fields, send vertical — kept dormant). Tasks 3–6 (interactive listener,
> gateway click handler, buttons setup) are cancelled: the owner chose copy-paste
> replies over click-to-send. See spec/slack-watcher.md §"v2: copyable replies +
> self-DM digest" for what shipped instead.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each digest item posted to Slack carries a **Send reply** button; clicking it sends the suggested reply verbatim into the original watched-workspace thread via a one-shot headless session vertical (the click is the human approval gate).

**Architecture:** Spec section: `spec/slack-watcher.md` §"v2: click-to-send reply buttons". Four seams: (1) watcher item schema gains `replyChannel`/`replyTs` and the skill posts Block Kit with per-item buttons; (2) a new `sendWatcherReply()` vertical (kind `slack-watcher-reply`) does the verbatim send through the Slack MCP connector, exactly like the watcher reads; (3) `ChannelAdapter` gains an optional `onAction` callback + `updateMessage`, and the Slack adapter listens for Socket Mode `interactive` events; (4) `createGateway` gains `handleAction()` — allowlist → dedup → "⏳ sending…" `chat.update` → dispatch the vertical → "✅ sent"/"⚠️ failed" update.

**Tech Stack:** TypeScript, vitest, `@slack/socket-mode` + `@slack/web-api` (already deps), Slack Block Kit, `runSessionVertical`.

## Global Constraints

- Conventional commits: `feat(scope): message`, kebab-case scope, header ≤ 100 chars. **Never add any AI attribution to commits or PRs** (no `Co-Authored-By`, no "Generated with" footers) — repo CLAUDE.md rule.
- Commit with explicit identity: `git -c user.name='Shrey Paharia' -c user.email='shreypaharia@gmail.com' commit …`.
- Prettier: single quotes, trailing commas, 100 char width, semicolons. `bun run format` if unsure.
- Server files: `const logger = childLogger('<module>');`, never `console.*`.
- Run one test file: `bun run vitest run <path>`. Full gates before PR: `bun run test`, `bun run typecheck`, `bun run lint`.
- The button `value` is self-contained JSON `{i, c, t, r}` (item index, watched-workspace channel, thread ts, reply text) — Slack caps it at 2000 chars.
- Security invariants: only allowlisted clickers dispatch sends; the send prompt forbids composition; malformed button values fail visibly ("⚠️"), never send.

---

### Task 1: Item schema fields + Block Kit digest in the skill

**Files:**

- Modify: `server/workflows/slack-watcher/schema.ts` (items sub-schema)
- Modify: `server/workflows/slack-watcher/schema.test.ts`
- Modify: `plugin/skills/slack-watcher/SKILL.md` (slack send branch + item collection)

**Interfaces:**

- Consumes: existing `SLACK_WATCHER_SCHEMA`.
- Produces: item objects may carry `replyChannel: string` and `replyTs: string` (both optional strings — watched-workspace channel id and thread ts for the suggested reply). Task 4's button values are built from these by the skill at digest time.

- [ ] **Step 1: Extend the schema test**

In `server/workflows/slack-watcher/schema.test.ts`, extend the full-item test ('accepts a full digest item and rejects an unknown urgency'): add to the accepted item object:

```typescript
            replyChannel: 'D0ASZE1MVJS',
            replyTs: '1784893312.104219',
```

(placed after `permalink`). Add a new test in the same describe block:

```typescript
it('accepts items without reply targeting fields', () => {
  const validate = new Ajv().compile(SLACK_WATCHER_SCHEMA);
  expect(
    validate({
      outcome: 'done',
      window: '40m',
      summary: '1 item',
      digestSent: true,
      items: [{ channel: '#x', from: 'a', about: 'b', urgency: 'low' }],
    }),
  ).toBe(true);
});
```

- [ ] **Step 2: Run to verify the extended test fails**

Run: `bun run vitest run server/workflows/slack-watcher/schema.test.ts`
Expected: FAIL — the full-item test rejects `replyChannel` (`additionalProperties: false`).

- [ ] **Step 3: Add the fields to the item schema**

In `server/workflows/slack-watcher/schema.ts`, inside `items.items.properties`, after `permalink`:

```typescript
          replyChannel: { type: 'string' },
          replyTs: { type: 'string' },
```

(`required` stays `['channel', 'from', 'about', 'urgency']`.)

- [ ] **Step 4: Run to verify tests pass**

Run: `bun run vitest run server/workflows/slack-watcher/schema.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Update the skill**

In `plugin/skills/slack-watcher/SKILL.md`:

a. In step 2 (Collect), append a bullet:

```markdown
- For every candidate you keep, record where a reply would go: the watched-workspace
  channel id and the thread ts (the root message's ts for a thread, the message's own
  ts otherwise). These become the item's `replyChannel` / `replyTs`.
```

b. Replace the `slack` branch of step 5 (Send it) — the lines from `- \`slack\`: resolve the channel` through the chat.postMessage curl sentence — with:

````markdown
- `slack`: resolve the digest channel — `{{digestChannel}}` if non-empty, otherwise
  `curl -s -X POST https://slack.com/api/conversations.open -H "Authorization: Bearer $OCTOMUX_GATEWAY_SLACK_BOT_TOKEN" -d "users={{digestUserId}}"`
  and take `.channel.id`. Then post the digest as **Block Kit** with one
  `chat.postMessage` call: `-H "Content-Type: application/json"` with a JSON body
  `{"channel": "<digest channel>", "text": "<plain-text digest fallback>", "blocks": [...]}`.
  Blocks: one `header` block (`Slack digest — <n> things need you`), then per item a
  `section` block (mrkdwn: `*<n>. <from> · <channel>* — <about>\n↳ suggested: "<reply>"`)
  followed — **only when the item has `replyChannel`, `replyTs`, and
  `suggestedReply`** — by an `actions` block:

  ```json
  {
    "type": "actions",
    "block_id": "swr_<item index>",
    "elements": [
      {
        "type": "button",
        "text": { "type": "plain_text", "text": "Send reply <n>" },
        "action_id": "slack_watcher_send_reply",
        "value": "{\"i\":<item index>,\"c\":\"<replyChannel>\",\"t\":\"<replyTs>\",\"r\":\"<suggestedReply, JSON-escaped>\"}"
      }
    ]
  }
  ```

  Keep each button's `value` under 2000 characters (replies are 1–2 sentences, so
  this only matters if you quoted too much — trim the reply, not the JSON keys).
````

c. In step 6's example `items` entry, add after `"permalink"`:

```json
         "replyChannel": "D0ASZE1MVJS",
         "replyTs": "1784893312.104219"
```

d. Add to `## Notes`:

```markdown
- The send buttons are wired server-side: clicking one sends that exact reply into the
  original thread. You only attach the data (`replyChannel`, `replyTs`, button value) —
  you never send replies yourself.
```

- [ ] **Step 6: Verify skill loads and placeholders unchanged**

Run: `bun run vitest run server/schedule-prompt.test.ts`
Expected: PASS. Also `grep -o '{{[a-zA-Z]*}}' plugin/skills/slack-watcher/SKILL.md | sort -u` still lists exactly the seven known placeholders.

- [ ] **Step 7: Commit**

```bash
git add server/workflows/slack-watcher/schema.ts server/workflows/slack-watcher/schema.test.ts plugin/skills/slack-watcher/SKILL.md
git commit -m "feat(workflows): reply targeting fields and Block Kit send buttons in slack-watcher digest"
```

---

### Task 2: The reply-send vertical

**Files:**

- Create: `server/workflows/slack-watcher/send-reply.ts`
- Modify: `server/workflows/index.ts` (side-effect import `./slack-watcher/send-reply.js` after `./slack-watcher/index.js`)
- Test: `server/workflows/slack-watcher/send-reply.test.ts`

**Interfaces:**

- Consumes: `runSessionVertical` (existing), `registerWorkflow` (existing).
- Produces: `sendWatcherReply(input: SendWatcherReplyInput): Promise<SendReplyResult>` with `SendWatcherReplyInput = { workspaceDir: string; channel: string; threadTs: string; text: string }` and `SendReplyResult = { outcome: 'done' | 'failed'; error?: string }`. Also registers feed-only kind `slack-watcher-reply` (no cron trigger, no `run`) so its runs rows render on /runs.

- [ ] **Step 1: Write the failing test**

`server/workflows/slack-watcher/send-reply.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRunSessionVertical = vi.fn();

vi.mock('../../services/session-vertical-service.js', () => ({
  runSessionVertical: (...args: unknown[]) => mockRunSessionVertical(...args),
}));

// ─── Import after mocks ─────────────────────────────────────────────────────

import { sendWatcherReply, SEND_REPLY_SCHEMA } from './send-reply.js';
import { getWorkflow, listCronWorkflowKinds } from '../registry.js';

describe('sendWatcherReply', () => {
  beforeEach(() => {
    mockRunSessionVertical.mockReset();
  });

  it('runs a slack-watcher-reply vertical with a verbatim-send prompt', async () => {
    mockRunSessionVertical.mockResolvedValue({ result: { outcome: 'done' } });

    const result = await sendWatcherReply({
      workspaceDir: '/repos/octomux',
      channel: 'D0ASZE1MVJS',
      threadTs: '1784893312.104219',
      text: 'taking a look now, will approve if all good',
    });

    expect(result).toEqual({ outcome: 'done' });
    const call = mockRunSessionVertical.mock.calls[0][0];
    expect(call.kind).toBe('slack-watcher-reply');
    expect(call.workspaceDir).toBe('/repos/octomux');
    expect(call.outputSchema).toBe(SEND_REPLY_SCHEMA);
    expect(call.trigger).toBe('manual');
    expect(call.input).toContain('D0ASZE1MVJS');
    expect(call.input).toContain('1784893312.104219');
    expect(call.input).toContain('taking a look now, will approve if all good');
    expect(call.input).toContain('EXACTLY');
  });

  it('maps a vertical failure to a failed outcome instead of throwing', async () => {
    mockRunSessionVertical.mockRejectedValue(new Error('session died'));

    const result = await sendWatcherReply({
      workspaceDir: '/repos/octomux',
      channel: 'C1',
      threadTs: '1.2',
      text: 'ok',
    });

    expect(result.outcome).toBe('failed');
    expect(result.error).toContain('session died');
  });

  it('registers slack-watcher-reply as a feed-only kind (not cron-schedulable)', () => {
    const wf = getWorkflow('slack-watcher-reply');
    expect(wf).toBeDefined();
    expect(wf?.surfaces).toEqual(['feed']);
    expect(listCronWorkflowKinds()).not.toContain('slack-watcher-reply');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run vitest run server/workflows/slack-watcher/send-reply.test.ts`
Expected: FAIL — cannot resolve `./send-reply.js`.

- [ ] **Step 3: Write the module**

`server/workflows/slack-watcher/send-reply.ts`:

```typescript
/**
 * One-shot headless vertical that sends a single click-approved slack-watcher
 * reply, verbatim, into the watched-workspace thread. Runs through the same
 * `runSessionVertical` + claude.ai Slack connector path the watcher reads
 * with — the conductor cannot do this (strict MCP config), a session vertical
 * can (spec/slack-watcher.md §v2).
 */
import { registerWorkflow } from '../registry.js';
import { runSessionVertical } from '../../services/session-vertical-service.js';

export interface SendWatcherReplyInput {
  workspaceDir: string;
  /** Watched-workspace channel id the reply goes to. */
  channel: string;
  /** Thread ts the reply attaches to. */
  threadTs: string;
  /** The exact reply text — sent verbatim, never composed. */
  text: string;
}

export interface SendReplyResult {
  outcome: 'done' | 'failed';
  error?: string;
}

export const SEND_REPLY_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['done', 'failed'] },
    error: { type: 'string' },
  },
  required: ['outcome'],
  additionalProperties: false,
};

/** Feed-only kind: runs rows render on /runs, but it is never cron-schedulable. */
registerWorkflow({
  kind: 'slack-watcher-reply',
  displayName: 'Slack Watcher Reply',
  surfaces: ['feed'],
  output: SEND_REPLY_SCHEMA,
  trigger: { kind: 'manual' },
});

function buildPrompt(input: SendWatcherReplyInput): string {
  return [
    'You are sending one owner-approved Slack reply. This is a headless, unattended',
    'session: your only side effects are one Slack send and one `submit_result` call.',
    '',
    'Using your Slack MCP connector send tool (`slack_send_message`), post EXACTLY this',
    'text — no edits, no additions, no follow-up messages:',
    '',
    `channel_id: ${input.channel}`,
    `thread_ts: ${input.threadTs}`,
    `text: ${input.text}`,
    '',
    'Then call `submit_result` exactly once with `{"outcome":"done"}` — or',
    '`{"outcome":"failed","error":"<why>"}` if the send tool is unavailable or the send',
    'errors. Do not compose, retry endlessly, or send anything else.',
  ].join('\n');
}

export async function sendWatcherReply(input: SendWatcherReplyInput): Promise<SendReplyResult> {
  try {
    const { result } = await runSessionVertical<SendReplyResult>({
      kind: 'slack-watcher-reply',
      workspaceDir: input.workspaceDir,
      input: buildPrompt(input),
      outputSchema: SEND_REPLY_SCHEMA,
      trigger: 'manual',
    });
    return result;
  } catch (err) {
    return { outcome: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}
```

In `server/workflows/index.ts`, add after the `./slack-watcher/index.js` import:

```typescript
import './slack-watcher/send-reply.js';
```

- [ ] **Step 4: Run to verify tests pass**

Run: `bun run vitest run server/workflows/slack-watcher/send-reply.test.ts server/workflows/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/workflows/slack-watcher/send-reply.ts server/workflows/slack-watcher/send-reply.test.ts server/workflows/index.ts
git commit -m "feat(workflows): slack-watcher-reply verbatim-send vertical"
```

---

### Task 3: Adapter interface + Slack interactive listener

**Files:**

- Modify: `server/gateway/adapter.ts`
- Modify: `server/gateway/slack.ts`
- Test: `server/gateway/slack.test.ts` (extend the existing file — it already injects a fake `socket`/`client` via `buildSlack` opts; mirror its existing event-emission pattern)

**Interfaces:**

- Consumes: nothing from Tasks 1–2.
- Produces: `InboundAction = { channel: 'telegram' | 'slack'; threadKey: string; senderId: string; externalId: string; actionId: string; value: string; messageTs: string; blocks: unknown[] }`; `ChannelAdapter.start(onMessage, onAction?)`; optional `ChannelAdapter.updateMessage?(threadKey, ts, text, blocks?)`. The Telegram adapter needs **no change** (optional members; its `start(onMessage)` still satisfies the interface).

- [ ] **Step 1: Extend adapter.ts**

Replace the interface block in `server/gateway/adapter.ts` with:

```typescript
export interface InboundMessage {
  channel: 'telegram' | 'slack';
  threadKey: string; // Telegram chat.id, later Slack thread_ts
  senderId: string; // Telegram from.id, later Slack user_id
  externalId: string; // Telegram update_id, later Slack event_id — for dedup
  text: string;
}

/** A block-actions button click (Slack-only in v1 of interactivity). */
export interface InboundAction {
  channel: 'telegram' | 'slack';
  /** Channel/DM id the interactive message lives in. */
  threadKey: string;
  senderId: string;
  /** envelope_id — for dedup. */
  externalId: string;
  actionId: string;
  /** The clicked button's raw `value` payload. */
  value: string;
  /** ts of the message carrying the buttons — for chat.update. */
  messageTs: string;
  /** The message's current blocks — callers patch and update in place. */
  blocks: unknown[];
}

export interface ChannelAdapter {
  id: 'telegram' | 'slack';
  start(
    onMessage: (m: InboundMessage) => Promise<void>,
    onAction?: (a: InboundAction) => Promise<void>,
  ): Promise<void>;
  send(threadKey: string, text: string): Promise<void>;
  sendTyping(threadKey: string): Promise<void>;
  /** Edit a previously-sent message in place. Absent on channels without edit APIs. */
  updateMessage?(threadKey: string, ts: string, text: string, blocks?: unknown[]): Promise<void>;
}
```

- [ ] **Step 2: Write the failing tests**

Append to `server/gateway/slack.test.ts` (match the file's existing fake-socket/fake-client setup — reuse its helpers; the shape below shows the required assertions, adapt setup to the file's idiom):

```typescript
describe('interactive (block_actions)', () => {
  it('routes a button click to onAction with action id, value, message ts and blocks', async () => {
    const { adapter, socket } = buildSlack('xoxb-test', 'xapp-test', {
      client: fakeClient,
      socket: fakeSocket,
    });
    const onAction = vi.fn().mockResolvedValue(undefined);
    await adapter.start(vi.fn(), onAction);

    const ack = vi.fn().mockResolvedValue(undefined);
    fakeSocket.emit('interactive', {
      ack,
      envelope_id: 'env-1',
      body: {
        type: 'block_actions',
        user: { id: 'U0BKJ83SF5G' },
        channel: { id: 'D0BKMV6UPJM' },
        message: { ts: '111.222', blocks: [{ type: 'header' }] },
        actions: [
          { action_id: 'slack_watcher_send_reply', value: '{"i":0,"c":"D1","t":"9.9","r":"ok"}' },
        ],
      },
    });
    await new Promise((r) => setImmediate(r));

    expect(ack).toHaveBeenCalled();
    expect(onAction).toHaveBeenCalledWith({
      channel: 'slack',
      threadKey: 'D0BKMV6UPJM',
      senderId: 'U0BKJ83SF5G',
      externalId: 'env-1',
      actionId: 'slack_watcher_send_reply',
      value: '{"i":0,"c":"D1","t":"9.9","r":"ok"}',
      messageTs: '111.222',
      blocks: [{ type: 'header' }],
    });
  });

  it('acks and ignores non-block_actions payloads and clicks with no actions', async () => {
    // emit body.type 'view_submission' and a block_actions body with actions: []
    // assert ack called, onAction NOT called
  });

  it('updateMessage calls chat.update with channel, ts, text, blocks', async () => {
    // adapter.updateMessage!('D0BKMV6UPJM', '111.222', 'fallback', [{ type: 'header' }])
    // assert fakeClient.chat.update called with { channel, ts, text, blocks }
  });
});
```

(Write the two sketched tests out fully in the file's idiom — they must assert, not comment.)

- [ ] **Step 3: Run to verify they fail**

Run: `bun run vitest run server/gateway/slack.test.ts`
Expected: FAIL — no `interactive` listener, no `updateMessage`.

- [ ] **Step 4: Implement in slack.ts**

Add a payload shape near `SlackMessageEventPayload`:

```typescript
/** Socket Mode `interactive` payload — shaped for the fields we destructure. */
interface SlackInteractivePayload {
  ack: (response?: unknown) => Promise<void>;
  envelope_id: string;
  body?: {
    type?: string;
    user?: { id?: string };
    channel?: { id?: string };
    message?: { ts?: string; blocks?: unknown[] };
    actions?: Array<{ action_id?: string; value?: string }>;
  };
}
```

In `start()`, change the signature to `async start(onMessage, onAction?)` (types per adapter.ts) and add after the `message` listener:

```typescript
socket.on('interactive', async ({ body, ack, envelope_id }: SlackInteractivePayload) => {
  // Always ack first — Slack redelivers unacked interactive payloads too.
  await ack();
  if (!onAction || body?.type !== 'block_actions') return;

  const action = body.actions?.[0];
  const userId = body.user?.id;
  const channelId = body.channel?.id;
  const messageTs = body.message?.ts;
  if (!action?.action_id || !userId || !channelId || !messageTs) return;

  try {
    await onAction({
      channel: 'slack',
      threadKey: String(channelId),
      senderId: String(userId),
      externalId: String(envelope_id),
      actionId: String(action.action_id),
      value: String(action.value ?? ''),
      messageTs: String(messageTs),
      blocks: body.message?.blocks ?? [],
    });
  } catch (err) {
    logger.error({ err, thread_key: channelId }, 'slack onAction handler threw');
  }
});
```

Add to the adapter object after `sendTyping`:

```typescript
    async updateMessage(threadKey: string, ts: string, text: string, blocks?: unknown[]) {
      await client.chat.update({
        channel: threadKey,
        ts,
        text,
        ...(blocks ? { blocks: blocks as never } : {}),
      });
    },
```

- [ ] **Step 5: Run to verify tests pass**

Run: `bun run vitest run server/gateway/slack.test.ts server/gateway/`
Expected: PASS (whole gateway directory — telegram/gateway tests must not regress).

- [ ] **Step 6: Commit**

```bash
git add server/gateway/adapter.ts server/gateway/slack.ts server/gateway/slack.test.ts
git commit -m "feat(gateway): slack interactive block_actions listener and message updates"
```

---

### Task 4: Gateway handleAction — click → send → status update

**Files:**

- Modify: `server/gateway/gateway.ts`
- Test: `server/gateway/gateway.test.ts` (extend; it already fakes the adapter + conductor and uses `createTestDb`)

**Interfaces:**

- Consumes: `InboundAction` (Task 3), `sendWatcherReply` (Task 2), existing `isAllowed` / `seenInbound` / `markInbound`.
- Produces: `Gateway.handleAction(a: InboundAction): Promise<void>` (exported on the Gateway interface for tests); `createGateway(adapter, conductor?, deps?: { sendReply?: SendReplyFn })` where `SendReplyFn = (input: { workspaceDir: string; channel: string; threadTs: string; text: string }) => Promise<{ outcome: 'done' | 'failed'; error?: string }>`; `adapter.start(handleInbound, handleAction)` wired in `start()`.

- [ ] **Step 1: Write the failing tests**

Append to `server/gateway/gateway.test.ts` (adapt setup to the file's existing fakes; each test needs a fake adapter with `updateMessage: vi.fn()` and a `deps.sendReply` spy; allowlist per the file's existing allowlist test setup):

```typescript
describe('handleAction (send-reply button)', () => {
  const clickBlocks = [
    { type: 'header', text: { type: 'plain_text', text: 'digest' } },
    { type: 'section', text: { type: 'mrkdwn', text: 'item 1' } },
    { type: 'actions', block_id: 'swr_0', elements: [{ type: 'button' }] },
  ];

  function makeAction(overrides: Partial<InboundAction> = {}): InboundAction {
    return {
      channel: 'slack',
      threadKey: 'D0BKMV6UPJM',
      senderId: 'U-ALLOWED',
      externalId: 'env-1',
      actionId: 'slack_watcher_send_reply',
      value: JSON.stringify({ i: 0, c: 'D-OSTIUM', t: '9.9', r: 'on it' }),
      messageTs: '111.222',
      blocks: clickBlocks,
      ...overrides,
    };
  }

  it('sends the reply verbatim and updates the item to ✅', async () => {
    const sendReply = vi.fn().mockResolvedValue({ outcome: 'done' });
    // gateway = createGateway(fakeAdapter, fakeConductor, { sendReply })
    await gateway.handleAction(makeAction());

    expect(sendReply).toHaveBeenCalledWith({
      workspaceDir: expect.any(String),
      channel: 'D-OSTIUM',
      threadTs: '9.9',
      text: 'on it',
    });
    // two updates: ⏳ first, then ✅ — both on the digest message
    expect(fakeAdapter.updateMessage).toHaveBeenCalledTimes(2);
    const [, secondCall] = fakeAdapter.updateMessage.mock.calls;
    expect(secondCall[0]).toBe('D0BKMV6UPJM');
    expect(secondCall[1]).toBe('111.222');
    const updatedBlocks = secondCall[3] as Array<{ type: string; block_id?: string }>;
    // the swr_0 actions block was replaced by a context block; others untouched
    expect(updatedBlocks.some((b) => b.block_id === 'swr_0' && b.type === 'context')).toBe(true);
    expect(updatedBlocks.filter((b) => b.type === 'header')).toHaveLength(1);
  });

  it('drops clicks from non-allowlisted users without sending or updating', async () => {
    // handleAction(makeAction({ senderId: 'U-STRANGER' }))
    // expect sendReply and updateMessage NOT called
  });

  it('dedups repeated envelope ids (second click is a no-op)', async () => {
    // same externalId twice → sendReply called once
  });

  it('marks the item ⚠️ without sending when the value is malformed JSON', async () => {
    // value: 'not-json' → sendReply NOT called, final update block text contains '⚠️'
  });

  it('marks the item ⚠️ when sendReply resolves failed', async () => {
    // sendReply → { outcome: 'failed', error: 'no connector' } → final update contains '⚠️'
  });

  it('ignores unknown action ids', async () => {
    // actionId: 'other_button' → nothing called
  });
});
```

(Write the sketched tests out fully — assertions, not comments.)

- [ ] **Step 2: Run to verify they fail**

Run: `bun run vitest run server/gateway/gateway.test.ts`
Expected: FAIL — no `handleAction`.

- [ ] **Step 3: Implement in gateway.ts**

a. Imports: add `InboundAction` to the adapter type import; add:

```typescript
import { sendWatcherReply } from '../workflows/slack-watcher/send-reply.js';
```

b. Types (near `GatewayConductor`):

```typescript
export type SendReplyFn = typeof sendWatcherReply;

export interface GatewayDeps {
  /** Injection seam for tests — real default sends via the slack-watcher-reply vertical. */
  sendReply?: SendReplyFn;
}
```

c. `Gateway` interface gains `handleAction(a: InboundAction): Promise<void>;`, and the factory becomes `createGateway(adapter: ChannelAdapter, conductor: GatewayConductor = realConductor, deps: GatewayDeps = {})` with `const sendReply = deps.sendReply ?? sendWatcherReply;`.

d. Implementation (after `handleInbound`):

```typescript
const SEND_REPLY_ACTION = 'slack_watcher_send_reply';

/** Replace the clicked item's actions block with a status line; leave the rest. */
function patchBlocks(blocks: unknown[], blockId: string | undefined, status: string): unknown[] {
  return blocks.map((b) => {
    const block = b as { type?: string; block_id?: string };
    if (block.type !== 'actions') return b;
    if (blockId !== undefined && block.block_id !== blockId) return b;
    return {
      type: 'context',
      ...(block.block_id ? { block_id: block.block_id } : {}),
      elements: [{ type: 'mrkdwn', text: status }],
    };
  });
}

async function updateItem(a: InboundAction, blockId: string | undefined, status: string) {
  if (!adapter.updateMessage) return;
  try {
    await adapter.updateMessage(
      a.threadKey,
      a.messageTs,
      status,
      patchBlocks(a.blocks, blockId, status),
    );
  } catch (err) {
    logger.error({ thread_key: a.threadKey, err }, 'gateway: failed to update digest message');
  }
}

async function handleAction(a: InboundAction): Promise<void> {
  if (a.actionId !== SEND_REPLY_ACTION) return;

  // Same trust boundary + redelivery guard as handleInbound.
  if (!isAllowed(a.channel, a.senderId)) return;
  if (seenInbound(a.channel, a.externalId)) return;
  markInbound(a.channel, a.externalId);

  let payload: { i?: number; c?: string; t?: string; r?: string };
  try {
    payload = JSON.parse(a.value) as typeof payload;
  } catch {
    payload = {};
  }
  const blockId = typeof payload.i === 'number' ? `swr_${payload.i}` : undefined;
  if (!payload.c || !payload.t || !payload.r) {
    await updateItem(a, blockId, '⚠️ failed: malformed button payload — reply not sent');
    return;
  }

  await updateItem(a, blockId, '⏳ sending…');
  const result = await sendReply({
    workspaceDir: gatewayCwd(),
    channel: payload.c,
    threadTs: payload.t,
    text: payload.r,
  });
  if (result.outcome === 'done') {
    await updateItem(a, blockId, `✅ sent: "${payload.r}"`);
  } else {
    await updateItem(a, blockId, `⚠️ failed: ${result.error ?? 'unknown error'} — reply not sent`);
  }
}
```

e. Wire it: in `start()`, `await adapter.start(handleInbound, handleAction);` and add `handleAction` to the returned object.

- [ ] **Step 4: Run to verify tests pass**

Run: `bun run vitest run server/gateway/`
Expected: PASS (all gateway tests).

- [ ] **Step 5: Commit**

```bash
git add server/gateway/gateway.ts server/gateway/gateway.test.ts
git commit -m "feat(gateway): dispatch slack-watcher reply sends from digest button clicks"
```

---

### Task 5: README + full gates + PR

**Files:**

- Modify: `server/gateway/README.md` (Slack watcher section)
- No other new files; gates over the whole branch.

- [ ] **Step 1: Document the buttons**

In `server/gateway/README.md` §"Slack watcher (proactive digest)", append:

```markdown
### One-click reply sending

With `digestTarget: 'slack'`, each digest item carries a **Send reply** button. Clicking
it (allowlisted users only) sends that suggested reply, verbatim, into the original
watched-workspace thread via a one-shot `slack-watcher-reply` session run (visible on
the /runs feed); the digest message updates in place (⏳ → ✅ / ⚠️). Replies sent this
way show Slack's "Sent using @Claude" attribution to recipients.

One-time app setup: enable **Interactivity & Shortcuts** on the Slack app
(api.slack.com/apps — no Request URL needed with Socket Mode). Without it the buttons
render but clicks go nowhere.
```

- [ ] **Step 2: Full gates**

```bash
bun run typecheck && bun run lint && bun run test
```

Expected: pass (the known `HomePage.test.tsx` waitFor flake under full-suite load may recur — re-run that file in isolation to confirm it's the flake before dismissing).

- [ ] **Step 3: Commit + PR**

```bash
git add server/gateway/README.md
git commit -m "docs(gateway): one-click reply sending for the slack-watcher digest"
```

Push `feat/slack-watcher-reply-buttons`, open a PR against `next` titled `feat(gateway): one-click reply buttons on slack-watcher digests`, body linking `spec/slack-watcher.md` §v2 and this plan. **No AI attribution anywhere.**

---

### Task 6: Live setup + smoke (after merge — owner in the loop)

- [ ] **Step 1: Interactivity toggle.** Owner enables **Interactivity & Shortcuts** on the `ostiumoctomux` app at api.slack.com/apps (send the link via Slack self-DM per user rules).
- [ ] **Step 2: Deploy.** `git -C ~/github/octomux pull` → `bun run build` → restart the `octomux` tmux session (kill any orphaned `node dist-server/index.js` still holding :7777 first — known failure mode).
- [ ] **Step 3: Flip the schedule.** `PATCH`/update schedule `1xyXJAEG5VSc` config to `{ "slackUserId": "U0A798PTVD1", "digestTarget": "slack", "digestChannel": "D0BKMV6UPJM" }` (direct DM channel id — the bot token lacks `im:write`, so `conversations.open` is unavailable).
- [ ] **Step 4: Safe click smoke.** Post a synthetic one-item digest via the bot token with a button whose value targets the owner's **own Ostium self-DM** (`{"i":0,"c":"D0A7UHQP7C1","t":"","r":"button smoke test"}` — empty `t` posts a top-level message). Owner clicks → verify ⏳ → ✅ transition, the reply arrives in the Ostium self-DM, and a `slack-watcher-reply` run appears on /runs.
- [ ] **Step 5: Real digest smoke.** `POST /api/schedules/1xyXJAEG5VSc/run` → digest arrives in the bot DM as Block Kit with buttons on reply-capable items. Do NOT click real items unless the reply should genuinely be sent.
