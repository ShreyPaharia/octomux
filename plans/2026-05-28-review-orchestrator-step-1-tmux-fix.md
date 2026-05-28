# Review Orchestrator — Step 1: tmux send-keys fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the bug where messages sent via `tmux send-keys` to a running Claude Code TUI are pasted into the input buffer but never submitted (the trailing `Enter` is absorbed into the bracketed-paste payload as a newline rather than a submit). Extract a shared helper, replace the two affected callsites, prove it works.

**Architecture:** New module `server/tmux-input.ts` exports `sendMessageToAgent(session, windowIndex, message)`. Implementation splits into two `execFile` calls: first sends the message as literal text using tmux's `-l` flag (no keysym interpretation), then a 50ms delay, then sends the `Enter` keysym as a separate invocation. This is the standard tmux + TUI workaround documented in tmux/Claude Code issues. Two callsites swap to the helper; `server/chats.ts` (which sends shell commands to a shell prompt, not a TUI) is intentionally left alone.

**Tech Stack:** TypeScript, vitest, `execFile` via `child_process` + `promisify`. ESM modules.

**Spec reference:** `docs/superpowers/specs/2026-05-27-review-orchestrator-design.md`, Section 0.

**Working assumptions about the codebase** (verify with the current source, do not rely on memory):

- `server/api.ts` line 1038 is inside `POST /api/tasks/:id/agents/:agentId/message`. The current code calls `execFile('tmux', ['send-keys', '-t', `${task.tmux_session}:${agent.window_index}`, message, 'Enter'])` in one shot.
- `server/poller.ts` line 519 is inside `nudgeAgentForReReview`. Same single-shot send-keys pattern with target `${tmuxSession}:${agent.window_index}`.
- `server/chats.ts` line 106 launches Claude by sending the literal shell command `claude --resume <id> "$(cat <prompt-file>)"` followed by `Enter` to a tmux pane that holds a shell. Do NOT touch this — the shell has no bracketed-paste mode, the Enter submits, and adding a 50ms delay would slow every agent launch.
- All server logs go through `childLogger('<module>')`. Never use `console.*` in `server/`.
- Conventional Commits, kebab-case scopes, 100-char header. Never add `Co-Authored-By:` trailers (user's global rule).
- Tests run with `bun run test`. Type checks with `bun run typecheck`.
- `server/test-helpers.ts` exports `findExecCall` for asserting against mocked `execFile` call lists.

---

## File structure (created or modified in step 1)

### New files

| Path                        | Responsibility                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `server/tmux-input.ts`      | Exports `sendMessageToAgent(session, windowIndex, message)` — the split send-keys helper. |
| `server/tmux-input.test.ts` | Asserts the helper makes two `send-keys` invocations in order with the expected args.     |

### Modified files

| Path                    | Change                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `server/api.ts`         | Replace the inline `send-keys` call inside `POST /api/tasks/:id/agents/:agentId/message` with `sendMessageToAgent(...)`. |
| `server/api.test.ts`    | Update existing assertion in the "sends message via tmux send-keys" test to expect the two-call pattern.                 |
| `server/poller.ts`      | Replace the inline `send-keys` call inside `nudgeAgentForReReview` with `sendMessageToAgent(...)`.                       |
| `server/poller.test.ts` | Update existing assertions in the three nudge-related tests to expect the two-call pattern.                              |

---

## Task 1: Create the `sendMessageToAgent` helper with tests

**Files:**

- Create: `server/tmux-input.ts`
- Create: `server/tmux-input.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/tmux-input.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'child_process';

vi.mock('child_process', () => ({ execFile: vi.fn() }));

const mockedExecFile = vi.mocked(execFile);

import { sendMessageToAgent } from './tmux-input.js';

describe('sendMessageToAgent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedExecFile.mockReset();
    // execFile is callback-style; promisify wraps it. The mock has to invoke
    // the callback synchronously to play well with promisify + fake timers.
    mockedExecFile.mockImplementation(((_cmd: string, _args: string[], cb: any) => {
      cb(null, { stdout: '', stderr: '' });
      return {} as ReturnType<typeof execFile>;
    }) as unknown as typeof execFile);
  });

  it('sends the message and Enter as two separate send-keys calls with a delay', async () => {
    const promise = sendMessageToAgent('octomux-agent-abc', 0, 'hello world');
    await vi.advanceTimersByTimeAsync(60);
    await promise;

    expect(mockedExecFile).toHaveBeenCalledTimes(2);

    const firstCall = mockedExecFile.mock.calls[0];
    expect(firstCall[0]).toBe('tmux');
    expect(firstCall[1]).toEqual(['send-keys', '-t', 'octomux-agent-abc:0', '-l', 'hello world']);

    const secondCall = mockedExecFile.mock.calls[1];
    expect(secondCall[0]).toBe('tmux');
    expect(secondCall[1]).toEqual(['send-keys', '-t', 'octomux-agent-abc:0', 'Enter']);
  });

  it('forwards multi-line messages literally (newlines stay inside the message arg)', async () => {
    const message = 'line one\nline two\nline three';
    const promise = sendMessageToAgent('s', 3, message);
    await vi.advanceTimersByTimeAsync(60);
    await promise;

    expect(mockedExecFile.mock.calls[0][1]).toEqual(['send-keys', '-t', 's:3', '-l', message]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test server/tmux-input.test.ts`
Expected: FAIL with `Cannot find module './tmux-input.js'` (or equivalent ESM resolution error).

- [ ] **Step 3: Implement the helper**

Create `server/tmux-input.ts`:

```ts
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

const PASTE_TO_ENTER_DELAY_MS = 50;

/**
 * Send a user message to a running Claude Code TUI inside a tmux window.
 *
 * Two-call protocol: tmux delivers the multi-character `message` as a
 * bracketed-paste payload to the TUI. If we also pass `Enter` in the same
 * send-keys invocation, the TUI absorbs the Enter into the paste payload as
 * a literal newline rather than treating it as a submit. The workaround is
 * to send the text first (using `-l` to force literal interpretation), pause
 * briefly so the TUI finishes processing the paste, then send Enter as a
 * separate keysym.
 *
 * Do NOT use this for sending shell commands to a tmux pane that holds a
 * shell prompt (no bracketed-paste handling there) — the single-call pattern
 * is fine, faster, and `server/chats.ts` relies on it.
 */
export async function sendMessageToAgent(
  session: string,
  windowIndex: number,
  message: string,
): Promise<void> {
  const target = `${session}:${windowIndex}`;
  await execFile('tmux', ['send-keys', '-t', target, '-l', message]);
  await new Promise<void>((resolve) => setTimeout(resolve, PASTE_TO_ENTER_DELAY_MS));
  await execFile('tmux', ['send-keys', '-t', target, 'Enter']);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test server/tmux-input.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Type-check**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/tmux-input.ts server/tmux-input.test.ts
git commit -m "feat(server): add tmux-input helper for TUI-safe message sends"
```

---

## Task 2: Swap the api.ts callsite to the helper

**Files:**

- Modify: `server/api.ts` (around line 1038, the inline `execFile('tmux', ['send-keys', ...])` inside `POST /api/tasks/:id/agents/:agentId/message`)
- Modify: `server/api.test.ts` (the "sends message via tmux send-keys" test at ~line 1713)

- [ ] **Step 1: Update the existing test to expect two send-keys calls**

In `server/api.test.ts`, locate the test starting at ~line 1713 (`it('sends message via tmux send-keys and returns success', ...)`). The existing assertion uses `findExecCall` (or similar) to confirm a single `tmux send-keys` call. Update it to assert both calls in order:

```ts
const sendKeysCalls = vi
  .mocked(execFile)
  .mock.calls.filter(
    (c: unknown[]) =>
      c[0] === 'tmux' && Array.isArray(c[1]) && (c[1] as string[]).includes('send-keys'),
  );

expect(sendKeysCalls).toHaveLength(2);

// First call: literal text via -l, no Enter
const firstArgs = sendKeysCalls[0][1] as string[];
expect(firstArgs).toContain('-l');
expect(firstArgs).toContain('hello world'); // or whatever the test message is
expect(firstArgs).not.toContain('Enter');

// Second call: Enter only
const secondArgs = sendKeysCalls[1][1] as string[];
expect(secondArgs).toContain('Enter');
expect(secondArgs).not.toContain('-l');
```

Use whatever message string the test was already sending; do not invent a new one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test server/api.test.ts -t "sends message via tmux send-keys"`
Expected: FAIL — only one send-keys call is recorded today, the assertion expects two.

- [ ] **Step 3: Replace the production callsite**

In `server/api.ts`, locate the `app.post('/api/tasks/:id/agents/:agentId/message', ...)` route. Find the block:

```ts
await execFile('tmux', [
  'send-keys',
  '-t',
  `${task.tmux_session}:${agent.window_index}`,
  message,
  'Enter',
]);
```

Replace with:

```ts
await sendMessageToAgent(task.tmux_session!, agent.window_index, message);
```

At the top of `server/api.ts`, add (in import order with the existing sibling imports):

```ts
import { sendMessageToAgent } from './tmux-input.js';
```

If the local `execFile` import at the top of `api.ts` is no longer used after this change, delete it (and the `promisify` line if also unused). If `execFile` has other callers in `api.ts`, leave the import in place.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test server/api.test.ts -t "sends message via tmux send-keys"`
Expected: PASS.

- [ ] **Step 5: Run the full api test file**

Run: `bun run test server/api.test.ts`
Expected: PASS (no regressions in other tests).

- [ ] **Step 6: Commit**

```bash
git add server/api.ts server/api.test.ts
git commit -m "fix(api): use tmux-input helper so chat messages actually submit"
```

---

## Task 3: Swap the poller.ts callsite to the helper

**Files:**

- Modify: `server/poller.ts` (the `nudgeAgentForReReview` function, around line 519)
- Modify: `server/poller.test.ts` (the three nudge-related tests at ~lines 802, 825, 868, 896)

- [ ] **Step 1: Update existing tests to expect two send-keys calls**

In `server/poller.test.ts`, locate every `it` block that asserts the nudge calls `tmux send-keys` (around lines 802, 868, 896 — there are three: the success-path test plus two related). Each currently picks the single `send-keys` call from the `execFile` mock and inspects its args. Refactor each to:

```ts
const sendKeysCalls = vi
  .mocked(execFile)
  .mock.calls.filter(
    (c: unknown[]) =>
      c[0] === 'tmux' && Array.isArray(c[1]) && (c[1] as string[]).includes('send-keys'),
  );

expect(sendKeysCalls).toHaveLength(2);

const literalArgs = sendKeysCalls[0][1] as string[];
expect(literalArgs).toContain('-l');
expect(literalArgs.some((a) => a.startsWith('Re-review requested'))).toBe(true);

const enterArgs = sendKeysCalls[1][1] as string[];
expect(enterArgs).toContain('Enter');
```

Adjust the substring (`Re-review requested`) to match `buildReReviewNudge`'s actual output; if the test was looking for a different prefix, preserve that.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test server/poller.test.ts -t "nudges"`
Expected: FAIL — the tests now expect two send-keys calls; production code still emits one.

- [ ] **Step 3: Replace the production callsite**

In `server/poller.ts`, locate `nudgeAgentForReReview`. Replace:

```ts
const target = `${tmuxSession}:${agent.window_index}`;
const message = buildReReviewNudge(pr);
await execFile('tmux', ['send-keys', '-t', target, message, 'Enter']);
return true;
```

with:

```ts
const message = buildReReviewNudge(pr);
await sendMessageToAgent(tmuxSession, agent.window_index, message);
return true;
```

At the top of `server/poller.ts`, add to the imports:

```ts
import { sendMessageToAgent } from './tmux-input.js';
```

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `bun run test server/poller.test.ts -t "nudges"`
Expected: PASS.

- [ ] **Step 5: Run the full poller test file**

Run: `bun run test server/poller.test.ts`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add server/poller.ts server/poller.test.ts
git commit -m "fix(poller): use tmux-input helper so re-review nudges actually submit"
```

---

## Task 4: Full test + type-check pass

- [ ] **Step 1: Type-check the whole project**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 2: Run the full vitest suite**

Run: `bun run test`
Expected: all tests pass.

- [ ] **Step 3: Lint**

Run: `bun run lint`
Expected: no errors (warnings OK).

---

## Task 5: Manual verification in the dashboard

This is a smoke test the engineer runs before declaring the fix landed.

- [ ] **Step 1: Start the dev server**

Run: `bun run dev`
Expected: Express on :7777, Vite on :5173 (or whatever port Vite picks).

- [ ] **Step 2: Create a scratch task with a Claude Code agent**

Open `http://localhost:5173` → New Task → pick any agent → start it. Wait until the task shows `running`.

- [ ] **Step 3: Send a message from the dashboard chat input**

Type `tell me a joke` in the chat input and submit. Click into the agent's tmux terminal view (the xterm.js pane on the task detail page).

Expected: the agent receives the message, processes it, and responds. The input box clears after a moment. Before the fix, the message would appear in the input buffer of the Claude TUI and just sit there until you manually pressed Enter inside the pane.

- [ ] **Step 4: Verify the re-review nudge path (if you have a tracked GitHub repo with an open review-requested PR)**

This step is optional but ideal: bump the PR head SHA by pushing a new commit while an `auto_review` task is running. After the next poller tick (≤60s), the running agent should receive the re-review message and start acting on it without manual intervention.

If you don't have a convenient PR to test against, skip this step — Task 3's unit tests cover the call shape.

- [ ] **Step 5: Document the manual verification result**

Add a one-line entry to your engineering log / Linear ticket noting the manual smoke test passed (or what failed). No code change.

---

## Self-review checklist

After completing all tasks, verify:

- [ ] `server/chats.ts` was **not** modified (the agent-launch shell command path is intentionally unaffected).
- [ ] `server/tmux-input.ts` exports exactly one function, `sendMessageToAgent`, with the documented signature.
- [ ] The 50ms delay is a single named constant (`PASTE_TO_ENTER_DELAY_MS`), not scattered as a magic number.
- [ ] No remaining inline `execFile('tmux', ['send-keys', ..., message, 'Enter'])` in either `server/api.ts` or `server/poller.ts`.
- [ ] All three modified test files still pass and don't add new tests beyond the ones described here (this is a focused bug fix, not a coverage expansion).

---

## Done criteria

- All vitest tests pass (`bun run test`).
- `bun run typecheck` and `bun run lint` are clean.
- Manual smoke test in the dashboard confirms a typed chat message actually submits to the running agent without any manual Enter inside the tmux pane.

Step 1 is independently shippable. Step 2 (backend orchestrator) depends on this fix being in place because the poller's re-review nudge mechanism is part of the orchestrator runtime.
