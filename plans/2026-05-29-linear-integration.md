# Linear Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Linear integration that lives alongside Jira, sharing the existing integration framework. Status sync (octomux → Linear), `/create-task` reads Linear issues via MCP, comment-back on column moves, auto-prefill of per-team status maps from the Linear API, and a generic "default tracker" abstraction so future providers drop in cleanly.

**Architecture:** New `linearProvider` registered in `server/integrations/registry`. Linear-specific config (API key + per-team status maps) stored in the existing `integrations` table via JSON. New nullable `metadata` JSON column on `task_external_refs` to cache `team_key/team_id/issue_id/project_id` at link-time. New `POST /api/integrations/linear/prefill` endpoint hits Linear GraphQL once, fuzzy-matches state names per team, and returns an auto-filled map for the setup UI. SetupPage gets a generic tracker selector. Skills (markdown only) gain Linear branches.

**Tech Stack:** TypeScript, vitest, supertest, better-sqlite3, React 19, Linear GraphQL API. ESM modules.

**Spec reference:** `docs/superpowers/specs/2026-05-28-linear-integration-design.md`.

**Working assumptions about the codebase** (verify with the current source, do not rely on memory):

- Integration framework: `server/integrations/types.ts` defines `IntegrationProvider`. `server/integrations/registry.ts` has `registerProvider/getProvider/listProviders`. `server/integrations/index.ts` side-effect-imports each provider (`import './jira/index.js';`). Adding Linear requires a new `import './linear/index.js';` line.
- `task_external_refs` schema lives in `server/db.ts` lines 73–80. The migration pattern is `addColumn('<table>', '<name>', '<ddl>', cols)` called inside `initDb` (server/db.ts around line 311–331).
- Existing `task_external_refs` PRIMARY KEY is `(task_id, integration)` — one ref per integration per task.
- Provider registration in `server/integrations/jira/index.ts:205` is `registerProvider(jiraProvider);`. Mirror that line in linear/index.ts.
- Jira provider unit-test pattern at `server/integrations/jira/index.test.ts`: stubs `fetch` via `vi.stubGlobal`, uses table-driven `it.each` for validation, mocks fetch responses with `mockFetchOk/mockFetchFail` helpers.
- CLI commands use `commander` (`registerTaskRefAdd` in `cli/src/commands/task-ref-add.ts`). The shared client lives behind `getContext(cmd).client` exposing `addTaskRef`.
- Settings live in `~/.octomux/settings.json` (prod) / `./data/settings.json` (dev). `server/settings.ts` is the read/write layer; fields are added by extending the `OctomuxSettings` interface AND the `getSettings()` / `updateSettings()` field-by-field merge.
- API integration routes are in `server/api.ts`. `POST /api/tasks/:id/refs` is around lines 2367–2397. Integration CRUD around lines 2580–2650. Use `getDb()` for DB access.
- Frontend SPA imports flow through `src/lib/api.ts` (the typed client). New endpoints must be added to that file.
- Frontend integration form pattern: `src/components/integrations/JiraConfigForm.tsx` exports a form component and a `toJiraConfig(IntegrationRow)` helper. Mirror this exactly.
- `src/pages/IntegrationsPage.tsx` hardcodes a `kind === 'jira'` branch when rendering the "Add" button and modal. Generalize per-kind, or add a parallel `kind === 'linear'` branch.
- `src/pages/SetupPage.tsx` has a `DefaultsForm` inner component with three Jira-specific inputs. Replace with a multi-tracker shape that conditionally renders Linear or Jira fields based on the selected `defaultTracker`.
- All server logs go through `childLogger('<module>')`. Never use `console.*` in `server/`.
- Conventional Commits, kebab-case scopes, 100-char header. **Never add `Co-Authored-By:` trailers** (user's global rule).
- Tests: `bun run test` (vitest). Typecheck: `bun run typecheck`. Lint: `bun run lint`. Format: `bun run format`. Commit only after all three pass.
- `task_external_refs.metadata` is read in the server layer via `JSON.parse(row.metadata ?? 'null')` and the response field is typed `Record<string, unknown> | null`. Never expose the raw string to API consumers.

**Linear API basics** (you'll need these for the provider implementation):

- Endpoint: `https://api.linear.app/graphql` (POST, `Content-Type: application/json`).
- Auth: `Authorization: <api_key>` (no `Bearer` prefix — Linear uses the bare token).
- GraphQL request body: `{ query: '...', variables: {...} }`.
- Errors are reported in JSON `errors[]` even when HTTP 200. Provider code must check `body.errors` after `res.json()`.
- Useful queries / mutations for this plan:
  - `query { viewer { id name email } }` — used by `testConnection`.
  - `query { teams { nodes { id key name states { nodes { id name type } } } } }` — used by prefill.
  - `query Issue($id: String!) { issue(id: $id) { id identifier title description state { id name } team { id key name } project { id } labels { nodes { name } } } }` — used by handler to resolve UUIDs from a key like `BAC-123`.
  - `mutation StateUpdate($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }` — used by handler.
  - `mutation Comment($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }` — used by handler comment-back.

---

## File structure

### New files

| Path                                                    | Responsibility                                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `server/integrations/linear/index.ts`                   | Linear `IntegrationProvider` (validate, testConnection, handler) + side-effect registration.  |
| `server/integrations/linear/index.test.ts`              | Unit tests for validate / testConnection / handler.                                           |
| `server/integrations/linear/graphql.ts`                 | Thin wrapper: `linearGraphql(apiKey, query, variables)`. Used by provider + prefill + api.ts. |
| `server/integrations/linear/graphql.test.ts`            | Verifies headers, error propagation.                                                          |
| `server/integrations/linear/prefill.ts`                 | `prefillFromLinear(apiKey)` — fetches teams+states, returns auto-mapped status maps.          |
| `server/integrations/linear/prefill.test.ts`            | Tests fuzzy state-name matching and the `done = type === 'completed'` rule.                   |
| `server/api.linear-prefill.test.ts`                     | Supertest for `POST /api/integrations/linear/prefill`.                                        |
| `src/components/integrations/LinearConfigForm.tsx`      | React form: API key, prefill button, per-team status dropdowns, default-team picker.          |
| `src/components/integrations/LinearConfigForm.test.tsx` | Component test: renders, prefill flow, save submits expected config.                          |

### Modified files

| Path                                                                                | Change                                                                                                                                                            |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/db.ts`                                                                      | Add `metadata` column to `task_external_refs` via `addColumn`.                                                                                                    |
| `server/db.test.ts`                                                                 | New round-trip test for `task_external_refs.metadata`.                                                                                                            |
| `server/types.ts`                                                                   | Extend `TaskExternalRef` type with `metadata?: Record<string, unknown> \| null`.                                                                                  |
| `server/settings.ts`                                                                | Add `defaultTracker?: 'jira' \| 'linear'` and `defaultLinearTeamKey?: string` fields to `OctomuxSettings`, read/write logic.                                      |
| `server/settings.test.ts`                                                           | Round-trip the new settings fields.                                                                                                                               |
| `server/api.ts`                                                                     | (1) Accept `metadata` in `POST /api/tasks/:id/refs`. (2) Persist + return it on `GET /api/tasks/:id/refs`. (3) Add `POST /api/integrations/linear/prefill` route. |
| `server/api.task-refs.test.ts` (existing or co-located in api.integrations.test.ts) | Cover metadata persistence on the addRef endpoint.                                                                                                                |
| `server/integrations/index.ts`                                                      | Add `import './linear/index.js';`.                                                                                                                                |
| `cli/src/commands/task-ref-add.ts`                                                  | Add `--metadata <json>` flag, parse to object, pass to `client.addTaskRef`.                                                                                       |
| `cli/src/commands/task-ref-add.test.ts` (new)                                       | Verify the flag parses JSON and rejects non-objects.                                                                                                              |
| `cli/src/client.ts` (or equivalent)                                                 | Extend `addTaskRef` signature with optional `metadata` field.                                                                                                     |
| `src/lib/api.ts`                                                                    | (1) Extend `TaskExternalRef` with `metadata`. (2) Add `prefillLinear(apiKey)` method. (3) Extend `OctomuxSettings` type.                                          |
| `src/pages/IntegrationsPage.tsx`                                                    | (1) Drop the hard-coded `if (p.kind === 'jira')` button; render an "Add" button for any provider. (2) Add a `linear` branch in modal handling for create/edit.    |
| `src/pages/SetupPage.tsx`                                                           | Replace Jira-only `DefaultsForm` with a tracker selector + conditional Linear/Jira fields.                                                                        |
| `src/pages/SetupPage.test.tsx`                                                      | Cover the tracker selector + conditional rendering.                                                                                                               |
| `src/components/TaskRefsPanel.tsx`                                                  | (1) Linear chip color/icon. (2) Show `[<team>]` badge when `metadata.team_key` present.                                                                           |
| `src/components/TaskRefsPanel.test.tsx`                                             | Cover the team-badge rendering.                                                                                                                                   |
| `skills/create-task/SKILL.md`                                                       | Add Linear key detection + MCP fetch block + `--metadata` example.                                                                                                |
| `skills/update-task-status/SKILL.md`                                                | Add Linear example block in "Linking external references".                                                                                                        |
| `CLAUDE.md`                                                                         | Append a Gotchas note: `task_external_refs.metadata` is nullable JSON text; Linear uses bare API key (no Bearer).                                                 |

---

## Phase 1 — Data model: metadata column + types

## Task 1: Add `metadata` column to `task_external_refs`

**Files:**

- Modify: `server/db.ts` (around line 311–331, additive migrations block)
- Modify: `server/db.test.ts` (add new round-trip test)
- Modify: `server/types.ts` (extend `TaskExternalRef`)

- [ ] **Step 1: Write the failing test**

Append to `server/db.test.ts`:

```ts
describe('task_external_refs metadata column', () => {
  it('round-trips JSON metadata', () => {
    const db = createTestDb();
    db.prepare(`INSERT INTO tasks (id, status) VALUES ('t1', 'draft')`).run();
    db.prepare(
      `INSERT INTO task_external_refs (task_id, integration, ref, url, metadata)
       VALUES ('t1', 'linear', 'BAC-1', 'https://linear.app/x/issue/BAC-1', ?)`,
    ).run(JSON.stringify({ team_key: 'BAC', team_id: 'uuid-1' }));
    const row = db
      .prepare(`SELECT metadata FROM task_external_refs WHERE task_id = 't1'`)
      .get() as { metadata: string };
    expect(JSON.parse(row.metadata)).toEqual({ team_key: 'BAC', team_id: 'uuid-1' });
  });

  it('accepts NULL metadata (legacy rows)', () => {
    const db = createTestDb();
    db.prepare(`INSERT INTO tasks (id, status) VALUES ('t2', 'draft')`).run();
    db.prepare(
      `INSERT INTO task_external_refs (task_id, integration, ref) VALUES ('t2', 'jira', 'PROJ-1')`,
    ).run();
    const row = db
      .prepare(`SELECT metadata FROM task_external_refs WHERE task_id = 't2'`)
      .get() as { metadata: string | null };
    expect(row.metadata).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test server/db.test.ts`
Expected: FAIL with `SQLITE_ERROR: table task_external_refs has no column named metadata` or similar.

- [ ] **Step 3: Add the migration in `server/db.ts`**

Inside `initDb` after the `taskCols` / `agentCols` block, add:

```ts
const taskRefCols = columnsOf('task_external_refs');
addColumn('task_external_refs', 'metadata', 'metadata TEXT', taskRefCols);
```

Place it after the last `addColumn('agents', ...)` call and before the index-creation block.

- [ ] **Step 4: Extend `TaskExternalRef` in `server/types.ts`**

Find the `TaskExternalRef` interface (search for `interface TaskExternalRef`). Add the field:

```ts
export interface TaskExternalRef {
  task_id: string;
  integration: string;
  ref: string;
  url: string | null;
  metadata: Record<string, unknown> | null; // NEW
  created_at: string;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test server/db.test.ts`
Expected: PASS — both new cases plus all existing tests.

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: no errors. If existing call sites destructure `TaskExternalRef`, they may need `metadata: null` added to mocked fixtures — fix those at point of failure.

- [ ] **Step 7: Commit**

```bash
git add server/db.ts server/db.test.ts server/types.ts
git commit -m "feat(db): add metadata JSON column to task_external_refs"
```

---

## Task 2: Settings additions — `defaultTracker` and `defaultLinearTeamKey`

**Files:**

- Modify: `server/settings.ts`
- Modify: `server/settings.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/settings.test.ts`:

```ts
describe('OctomuxSettings tracker fields', () => {
  it('round-trips defaultTracker and defaultLinearTeamKey', async () => {
    await updateSettings({ defaultTracker: 'linear', defaultLinearTeamKey: 'BAC' });
    const s = await getSettings();
    expect(s.defaultTracker).toBe('linear');
    expect(s.defaultLinearTeamKey).toBe('BAC');
  });

  it('preserves Jira defaults when only Linear fields are updated', async () => {
    await updateSettings({ defaultJiraBaseUrl: 'https://acme.atlassian.net' });
    await updateSettings({ defaultTracker: 'linear' });
    const s = await getSettings();
    expect(s.defaultJiraBaseUrl).toBe('https://acme.atlassian.net');
    expect(s.defaultTracker).toBe('linear');
  });

  it('rejects an invalid defaultTracker value', async () => {
    await expect(updateSettings({ defaultTracker: 'asana' as any })).rejects.toThrow(
      /defaultTracker/,
    );
  });
});
```

(If your `settings.test.ts` uses isolated tempdirs per test, follow that pattern — don't share state across tests.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test server/settings.test.ts`
Expected: FAIL — fields don't exist, error message doesn't include "defaultTracker".

- [ ] **Step 3: Extend `OctomuxSettings` interface**

In `server/settings.ts`, modify the interface (around line 10):

```ts
export type DefaultTracker = 'jira' | 'linear';

export interface OctomuxSettings {
  editor: EditorChoice;
  defaultHarnessId: string;
  harnesses: Record<string, Record<string, unknown>>;

  defaultTracker?: DefaultTracker; // NEW
  defaultJiraBaseUrl?: string;
  defaultJiraProjectKey?: string;
  defaultLinearTeamKey?: string; // NEW
  defaultBaseBranch?: string;
  onboardingCompletedAt?: string;

  /** @deprecated promoted into harnesses['claude-code'] on next save */
  claudeFlags?: string;
  /** @deprecated */
  dangerouslySkipPermissions?: boolean;
}
```

- [ ] **Step 4: Extend `getSettings` read logic**

In the return block of `getSettings()` (around line 92–104), add lines for the new fields:

```ts
return {
  editor: (parsed.editor as EditorChoice) ?? DEFAULT_SETTINGS.editor,
  defaultHarnessId: (parsed.defaultHarnessId as string) ?? DEFAULT_SETTINGS.defaultHarnessId,
  harnesses: mergedHarnesses,
  defaultTracker:
    parsed.defaultTracker === 'jira' || parsed.defaultTracker === 'linear'
      ? parsed.defaultTracker
      : undefined,
  defaultJiraBaseUrl:
    typeof parsed.defaultJiraBaseUrl === 'string' ? parsed.defaultJiraBaseUrl : undefined,
  defaultJiraProjectKey:
    typeof parsed.defaultJiraProjectKey === 'string' ? parsed.defaultJiraProjectKey : undefined,
  defaultLinearTeamKey:
    typeof parsed.defaultLinearTeamKey === 'string' ? parsed.defaultLinearTeamKey : undefined,
  defaultBaseBranch:
    typeof parsed.defaultBaseBranch === 'string' ? parsed.defaultBaseBranch : undefined,
  onboardingCompletedAt:
    typeof parsed.onboardingCompletedAt === 'string' ? parsed.onboardingCompletedAt : undefined,
};
```

- [ ] **Step 5: Extend `updateSettings` validation and merge logic**

At the top of `updateSettings(patch)` (around line 108), add validation:

```ts
if (
  patch.defaultTracker !== undefined &&
  patch.defaultTracker !== 'jira' &&
  patch.defaultTracker !== 'linear'
) {
  throw new Error(`Invalid defaultTracker: ${patch.defaultTracker}. Must be 'jira' or 'linear'.`);
}
```

In the merge block where the new settings object is built (around line 140–158), add fields:

```ts
const merged: OctomuxSettings = {
  editor: patch.editor ?? current.editor,
  defaultHarnessId: patch.defaultHarnessId ?? current.defaultHarnessId,
  harnesses: mergedHarnesses,
  defaultTracker:
    patch.defaultTracker !== undefined ? patch.defaultTracker : current.defaultTracker,
  defaultJiraBaseUrl:
    patch.defaultJiraBaseUrl !== undefined ? patch.defaultJiraBaseUrl : current.defaultJiraBaseUrl,
  defaultJiraProjectKey:
    patch.defaultJiraProjectKey !== undefined
      ? patch.defaultJiraProjectKey
      : current.defaultJiraProjectKey,
  defaultLinearTeamKey:
    patch.defaultLinearTeamKey !== undefined
      ? patch.defaultLinearTeamKey
      : current.defaultLinearTeamKey,
  defaultBaseBranch:
    patch.defaultBaseBranch !== undefined ? patch.defaultBaseBranch : current.defaultBaseBranch,
  onboardingCompletedAt:
    patch.onboardingCompletedAt !== undefined
      ? patch.onboardingCompletedAt
      : current.onboardingCompletedAt,
};
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun run test server/settings.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

Run: `bun run typecheck`
Expected: no errors.

```bash
git add server/settings.ts server/settings.test.ts
git commit -m "feat(settings): add defaultTracker and defaultLinearTeamKey fields"
```

---

## Phase 2 — Linear provider

## Task 3: Linear GraphQL wrapper

**Files:**

- Create: `server/integrations/linear/graphql.ts`
- Create: `server/integrations/linear/graphql.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/integrations/linear/graphql.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { linearGraphql, LinearApiError } from './graphql.js';

describe('linearGraphql', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs to api.linear.app with the bare api key as Authorization', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: { viewer: { id: 'u1', name: 'Test' } } }),
    });

    const result = await linearGraphql('lin_api_xyz', 'query { viewer { id name } }');
    expect(result).toEqual({ viewer: { id: 'u1', name: 'Test' } });

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.linear.app/graphql');
    expect(opts.method).toBe('POST');
    const headers = opts.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('lin_api_xyz');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('passes variables in the body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: { issue: { id: 'iss-1' } } }),
    });

    await linearGraphql('k', 'query I($id: String!) { issue(id: $id) { id } }', { id: 'BAC-1' });

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({
      query: 'query I($id: String!) { issue(id: $id) { id } }',
      variables: { id: 'BAC-1' },
    });
  });

  it('throws LinearApiError when response contains errors[]', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        errors: [
          { message: 'Authentication failed', extensions: { code: 'AUTHENTICATION_ERROR' } },
        ],
      }),
    });

    await expect(linearGraphql('bad', 'query { viewer { id } }')).rejects.toThrow(LinearApiError);
    await expect(linearGraphql('bad', 'query { viewer { id } }')).rejects.toThrow(
      /Authentication failed/,
    );
  });

  it('throws on HTTP non-2xx', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: vi.fn().mockResolvedValue('upstream broke'),
    });

    await expect(linearGraphql('k', 'query {}')).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test server/integrations/linear/graphql.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `linearGraphql`**

Create `server/integrations/linear/graphql.ts`:

```ts
import { childLogger } from '../../logger.js';

const logger = childLogger('integrations:linear:graphql');

export class LinearApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'LinearApiError';
  }
}

export async function linearGraphql<T = unknown>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, ...(variables ? { variables } : {}) }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.warn({ status: res.status, body: text }, 'linear graphql non-2xx');
    throw new LinearApiError(`Linear API HTTP ${res.status} ${res.statusText ?? ''}: ${text}`);
  }

  const body = (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };
  if (body.errors && body.errors.length > 0) {
    const first = body.errors[0];
    throw new LinearApiError(first.message, first.extensions?.code);
  }
  if (body.data === undefined) {
    throw new LinearApiError('Linear API returned no data and no errors');
  }
  return body.data;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test server/integrations/linear/graphql.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/integrations/linear/graphql.ts server/integrations/linear/graphql.test.ts
git commit -m "feat(integrations): add Linear GraphQL wrapper"
```

---

## Task 4: Linear provider — `validate` and `testConnection`

**Files:**

- Create: `server/integrations/linear/index.ts`
- Create: `server/integrations/linear/index.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/integrations/linear/index.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { linearProvider } from './index.js';

const VALID_CONFIG = {
  api_key: 'lin_api_xyz',
  default_team_key: 'BAC',
  status_map_by_team: {
    BAC: {
      backlog: '11111111-1111-1111-1111-111111111111',
      planned: '22222222-2222-2222-2222-222222222222',
      in_progress: '33333333-3333-3333-3333-333333333333',
      human_review: '44444444-4444-4444-4444-444444444444',
      pr: '44444444-4444-4444-4444-444444444444',
      done: '55555555-5555-5555-5555-555555555555',
    },
  },
};

function mockFetchOk(data: unknown) {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({ data }),
    text: vi.fn().mockResolvedValue(''),
  });
}

describe('linearProvider.validate', () => {
  it('accepts a valid config', () => {
    expect(linearProvider.validate(VALID_CONFIG)).toEqual({ ok: true });
  });

  it.each([
    ['missing api_key', { ...VALID_CONFIG, api_key: '' }, 'api_key'],
    ['null config', null, 'object'],
    [
      'status_map_by_team not an object',
      { ...VALID_CONFIG, status_map_by_team: 'bad' },
      'status_map_by_team',
    ],
    [
      'invalid status_map column key',
      { ...VALID_CONFIG, status_map_by_team: { BAC: { bogus: 'uuid' } } },
      'column',
    ],
    [
      'invalid UUID in map',
      { ...VALID_CONFIG, status_map_by_team: { BAC: { done: 'not-a-uuid' } } },
      'uuid',
    ],
  ] as const)('rejects %s', (_label, config, expectedWord) => {
    const result = linearProvider.validate(config);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.toLowerCase().includes(expectedWord))).toBe(true);
  });

  it('allows partial team maps (unmapped slots OK)', () => {
    const cfg = {
      api_key: 'k',
      status_map_by_team: { BAC: { done: '55555555-5555-5555-5555-555555555555' } },
    };
    expect(linearProvider.validate(cfg)).toEqual({ ok: true });
  });
});

describe('linearProvider.test', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls Linear `viewer` query with bare api key', async () => {
    mockFetchOk({ viewer: { id: 'u', name: 'Dev User', email: 'dev@x.io' } });
    const result = await linearProvider.test!(VALID_CONFIG);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('Dev User');

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.linear.app/graphql');
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('lin_api_xyz');
  });

  it('returns ok:false on auth error', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        errors: [
          { message: 'Authentication failed', extensions: { code: 'AUTHENTICATION_ERROR' } },
        ],
      }),
    });
    const result = await linearProvider.test!(VALID_CONFIG);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/authentication/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test server/integrations/linear/index.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement validate + testConnection**

Create `server/integrations/linear/index.ts`:

```ts
import { childLogger } from '../../logger.js';
import type { IntegrationProvider, ValidationResult, JsonSchema } from '../types.js';
import type { HookEnvelope } from '../../hook-types.js';
import { registerProvider } from '../registry.js';
import { linearGraphql, LinearApiError } from './graphql.js';

const logger = childLogger('integrations:linear');

const OCTOMUX_COLUMNS = [
  'backlog',
  'planned',
  'in_progress',
  'human_review',
  'pr',
  'done',
] as const;
type OctomuxColumn = (typeof OCTOMUX_COLUMNS)[number];

export interface LinearConfig {
  api_key: string;
  workspace_url?: string;
  default_team_key?: string;
  status_map_by_team: Record<string, Partial<Record<OctomuxColumn, string>>>;
}

const CONFIG_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['api_key', 'status_map_by_team'],
  properties: {
    api_key: { type: 'string', title: 'API key', secret: true },
    workspace_url: { type: 'string', format: 'uri', title: 'Workspace URL (display only)' },
    default_team_key: { type: 'string', title: 'Default team key' },
    status_map_by_team: {
      type: 'object',
      title: 'Per-team status maps',
      description: 'Map octomux workflow_status values to Linear state UUIDs, keyed by team key.',
    },
  },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validate(config: unknown): ValidationResult {
  if (typeof config !== 'object' || config === null) {
    return { ok: false, errors: ['config must be an object'] };
  }
  const cfg = config as Record<string, unknown>;
  const errors: string[] = [];

  if (!cfg.api_key || typeof cfg.api_key !== 'string' || !cfg.api_key.trim()) {
    errors.push('api_key is required');
  }

  if (
    !cfg.status_map_by_team ||
    typeof cfg.status_map_by_team !== 'object' ||
    Array.isArray(cfg.status_map_by_team)
  ) {
    errors.push('status_map_by_team must be an object');
  } else {
    for (const [teamKey, teamMap] of Object.entries(cfg.status_map_by_team)) {
      if (typeof teamMap !== 'object' || teamMap === null || Array.isArray(teamMap)) {
        errors.push(`status_map_by_team.${teamKey} must be an object`);
        continue;
      }
      for (const [col, uuid] of Object.entries(teamMap as Record<string, unknown>)) {
        if (!OCTOMUX_COLUMNS.includes(col as OctomuxColumn)) {
          errors.push(`status_map_by_team.${teamKey}: invalid column "${col}"`);
          continue;
        }
        if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) {
          errors.push(`status_map_by_team.${teamKey}.${col}: not a valid uuid`);
        }
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

async function testConnection(config: unknown): Promise<{ ok: boolean; message: string }> {
  const cfg = config as LinearConfig;
  try {
    const data = await linearGraphql<{ viewer: { id: string; name: string; email: string } }>(
      cfg.api_key,
      'query { viewer { id name email } }',
    );
    return { ok: true, message: `Connected as ${data.viewer.name ?? data.viewer.email}` };
  } catch (err) {
    const msg = err instanceof LinearApiError ? err.message : (err as Error).message;
    return { ok: false, message: `Connection failed: ${msg}` };
  }
}

// Handler implemented in Task 5 — placeholder for now so the provider object compiles.
async function handler(_envelope: HookEnvelope, _config: unknown): Promise<void> {
  // implemented in Task 5
}

export const linearProvider: IntegrationProvider = {
  kind: 'linear',
  displayName: 'Linear',
  configSchema: CONFIG_SCHEMA,
  events: ['workflow_status_changed'],
  validate,
  test: testConnection,
  handler,
};

registerProvider(linearProvider);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test server/integrations/linear/index.test.ts`
Expected: PASS for validate + test sections. Handler tests don't exist yet (Task 5).

- [ ] **Step 5: Commit**

```bash
git add server/integrations/linear/index.ts server/integrations/linear/index.test.ts
git commit -m "feat(integrations): add Linear provider validate+testConnection"
```

---

## Task 5: Linear provider — `handler` (status sync + comment-back)

**Files:**

- Modify: `server/integrations/linear/index.ts` (replace placeholder handler)
- Modify: `server/integrations/linear/index.test.ts` (add handler tests)

- [ ] **Step 1: Write the failing tests**

Append to `server/integrations/linear/index.test.ts`:

```ts
import type { HookEnvelope } from '../../hook-types.js';

function makeEnvelope(overrides: Partial<HookEnvelope> = {}): HookEnvelope {
  return {
    event: 'workflow_status_changed',
    task: {
      id: 'task-abc',
      external_refs: [
        {
          integration: 'linear',
          ref: 'BAC-1',
          url: null,
          metadata: { team_key: 'BAC', issue_id: 'lin-uuid-1' },
        },
      ],
    } as any,
    data: { from: 'in_progress', to: 'done' },
    ...overrides,
  };
}

describe('linearProvider.handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('issueUpdate + commentCreate when ref + map hit + non-backlog target', async () => {
    // Two sequential graphql calls expected: issueUpdate, then commentCreate.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: { issueUpdate: { success: true } } }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: { commentCreate: { success: true } } }),
    });

    await linearProvider.handler(makeEnvelope(), VALID_CONFIG);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(firstBody.query).toContain('issueUpdate');
    expect(firstBody.variables).toMatchObject({
      id: 'lin-uuid-1',
      stateId: '55555555-5555-5555-5555-555555555555',
    });
    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body as string);
    expect(secondBody.query).toContain('commentCreate');
    expect(secondBody.variables.body).toContain('done');
  });

  it('suppresses comment when target is backlog', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: { issueUpdate: { success: true } } }),
    });
    await linearProvider.handler(
      makeEnvelope({ data: { from: 'planned', to: 'backlog' } }),
      VALID_CONFIG,
    );
    expect(mockFetch).toHaveBeenCalledTimes(1); // only issueUpdate, no commentCreate
  });

  it('skips when no linear ref on task', async () => {
    await linearProvider.handler(
      makeEnvelope({
        task: { id: 't', external_refs: [{ integration: 'jira', ref: 'P-1' }] } as any,
      }),
      VALID_CONFIG,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('skips when team has no mapping for to_status', async () => {
    await linearProvider.handler(
      makeEnvelope({ data: { from: 'backlog', to: 'unknown_status' } as any }),
      VALID_CONFIG,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('parses team_key from ref string when metadata missing', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: { issue: { id: 'lin-uuid-2', team: { key: 'BAC' } } },
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: { issueUpdate: { success: true } } }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: { commentCreate: { success: true } } }),
    });

    await linearProvider.handler(
      makeEnvelope({
        task: {
          id: 't',
          external_refs: [{ integration: 'linear', ref: 'BAC-9', metadata: null }],
        } as any,
      }),
      VALID_CONFIG,
    );
    expect(mockFetch).toHaveBeenCalledTimes(3); // issue lookup + issueUpdate + commentCreate
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test server/integrations/linear/index.test.ts`
Expected: handler tests FAIL (placeholder is a no-op).

- [ ] **Step 3: Implement the handler**

Replace the placeholder `handler` in `server/integrations/linear/index.ts` with:

```ts
const ISSUE_LOOKUP_QUERY = `
  query Issue($id: String!) {
    issue(id: $id) {
      id
      team { id key }
    }
  }
`;

const ISSUE_UPDATE_MUTATION = `
  mutation IssueUpdate($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) { success }
  }
`;

const COMMENT_CREATE_MUTATION = `
  mutation CommentCreate($id: String!, $body: String!) {
    commentCreate(input: { issueId: $id, body: $body }) { success }
  }
`;

async function handler(envelope: HookEnvelope, config: unknown): Promise<void> {
  const cfg = config as LinearConfig;
  const task = envelope.task;

  const refs = (task.external_refs ?? []) as Array<{
    integration: string;
    ref: string;
    metadata?: Record<string, unknown> | null;
  }>;
  const linearRef = refs.find(
    (r) => r.integration === 'linear' || r.integration.startsWith('linear:'),
  );
  if (!linearRef) {
    logger.debug({ task_id: task.id }, 'linear handler: no linear ref, skipping');
    return;
  }

  const data = envelope.data as Record<string, unknown> | undefined;
  const toStatus = (data?.to_status ?? data?.to ?? '') as string;
  if (!toStatus) {
    logger.debug({ task_id: task.id }, 'linear handler: no to_status, skipping');
    return;
  }

  // Resolve team_key from metadata or by parsing the ref string.
  const metadata = (linearRef.metadata ?? {}) as Record<string, unknown>;
  let teamKey = typeof metadata.team_key === 'string' ? metadata.team_key : '';
  let issueId = typeof metadata.issue_id === 'string' ? metadata.issue_id : '';

  if (!teamKey) {
    const m = linearRef.ref.match(/^([A-Z][A-Z0-9]+)-\d+$/);
    if (m) teamKey = m[1];
  }

  if (!teamKey) {
    logger.debug(
      { task_id: task.id, ref: linearRef.ref },
      'linear handler: cannot derive team_key, skipping',
    );
    return;
  }

  const teamMap = cfg.status_map_by_team[teamKey];
  const stateId = teamMap?.[toStatus as OctomuxColumn];
  if (!stateId) {
    logger.debug(
      { task_id: task.id, team_key: teamKey, to_status: toStatus },
      'linear handler: no mapping for status, skipping',
    );
    return;
  }

  // Resolve issue UUID if we don't have it cached.
  if (!issueId) {
    try {
      const resp = await linearGraphql<{ issue: { id: string; team: { key: string } } | null }>(
        cfg.api_key,
        ISSUE_LOOKUP_QUERY,
        { id: linearRef.ref },
      );
      if (!resp.issue) {
        logger.warn({ task_id: task.id, ref: linearRef.ref }, 'linear handler: issue not found');
        return;
      }
      issueId = resp.issue.id;
    } catch (err) {
      logger.warn(
        { task_id: task.id, ref: linearRef.ref, err: (err as Error).message },
        'linear handler: issue lookup failed',
      );
      return;
    }
  }

  // State change.
  try {
    await linearGraphql(cfg.api_key, ISSUE_UPDATE_MUTATION, { id: issueId, stateId });
    logger.info(
      {
        task_id: task.id,
        issue_id: issueId,
        team_key: teamKey,
        to_status: toStatus,
        state_id: stateId,
      },
      'linear handler: state updated',
    );
  } catch (err) {
    logger.warn(
      { task_id: task.id, issue_id: issueId, err: (err as Error).message },
      'linear handler: issueUpdate failed',
    );
    return;
  }

  // Comment-back, unless we're resetting to backlog.
  if (toStatus === 'backlog') return;

  const prUrl = typeof (data?.pr_url ?? '') === 'string' ? (data?.pr_url as string) : '';
  const body = `octomux task moved to **${toStatus}**${prUrl ? ` — PR: ${prUrl}` : ''}.`;

  try {
    await linearGraphql(cfg.api_key, COMMENT_CREATE_MUTATION, { id: issueId, body });
  } catch (err) {
    // Comment failure shouldn't block the integration; log and move on.
    logger.warn(
      { task_id: task.id, issue_id: issueId, err: (err as Error).message },
      'linear handler: commentCreate failed',
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test server/integrations/linear/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/integrations/linear/index.ts server/integrations/linear/index.test.ts
git commit -m "feat(integrations): add Linear handler for status sync and comment-back"
```

---

## Task 6: Register the Linear provider with the framework

**Files:**

- Modify: `server/integrations/index.ts`

- [ ] **Step 1: Write a guard test**

Append to `server/integrations/index.test.ts` (create if it doesn't exist):

```ts
import { describe, it, expect } from 'vitest';
import { listProviders } from './registry.js';
import './index.js';

describe('integrations registry', () => {
  it('registers both jira and linear providers', () => {
    const kinds = listProviders().map((p) => p.kind);
    expect(kinds).toContain('jira');
    expect(kinds).toContain('linear');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test server/integrations/index.test.ts`
Expected: FAIL — `linear` not registered.

- [ ] **Step 3: Add side-effect import**

In `server/integrations/index.ts` add the import:

```ts
// Side-effect imports register all known providers.
import './jira/index.js';
import './linear/index.js'; // NEW

export { registerProvider, getProvider, listProviders } from './registry.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test server/integrations/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/integrations/index.ts server/integrations/index.test.ts
git commit -m "feat(integrations): register Linear provider"
```

---

## Phase 3 — Prefill endpoint

## Task 7: Prefill logic — `prefillFromLinear`

**Files:**

- Create: `server/integrations/linear/prefill.ts`
- Create: `server/integrations/linear/prefill.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/integrations/linear/prefill.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { prefillFromLinear } from './prefill.js';

const TEAMS_RESPONSE = {
  teams: {
    nodes: [
      {
        id: 'team-bac',
        key: 'BAC',
        name: 'Backend',
        states: {
          nodes: [
            { id: 's-backlog', name: 'Backlog', type: 'backlog' },
            { id: 's-todo', name: 'Todo', type: 'unstarted' },
            { id: 's-progress', name: 'In Progress', type: 'started' },
            { id: 's-review', name: 'In Review', type: 'started' },
            { id: 's-done', name: 'Done', type: 'completed' },
            { id: 's-cancel', name: 'Canceled', type: 'canceled' },
          ],
        },
      },
      {
        id: 'team-oge',
        key: 'OGE',
        name: 'Ostium Growth Engineering',
        states: {
          nodes: [
            { id: 's2-backlog', name: 'Backlog', type: 'backlog' },
            { id: 's2-prog', name: 'In progress', type: 'started' },
            { id: 's2-shipped', name: 'Shipped', type: 'completed' },
          ],
        },
      },
    ],
  },
};

describe('prefillFromLinear', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps Backend states by name with auto-prefill, prefers Backend as default', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: TEAMS_RESPONSE }),
    });

    const result = await prefillFromLinear('lin_xyz');

    expect(result.teams.length).toBe(2);
    expect(result.default_team_suggestion).toBe('BAC');
    expect(result.status_map_by_team.BAC).toEqual({
      backlog: 's-backlog',
      planned: 's-todo',
      in_progress: 's-progress',
      human_review: 's-review',
      pr: 's-review',
      done: 's-done',
    });
  });

  it('falls back to completed-type state for done when no name match', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: TEAMS_RESPONSE }),
    });

    const result = await prefillFromLinear('lin_xyz');
    // OGE has no "Done" by name — should pick the completed-typed "Shipped"
    expect(result.status_map_by_team.OGE.done).toBe('s2-shipped');
  });

  it('leaves slots unmapped when no candidate matches', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: TEAMS_RESPONSE }),
    });

    const result = await prefillFromLinear('lin_xyz');
    // OGE has no "Todo" / "Review" — those slots should be absent
    expect(result.status_map_by_team.OGE.planned).toBeUndefined();
    expect(result.status_map_by_team.OGE.human_review).toBeUndefined();
  });

  it('first team becomes default suggestion when no Backend team exists', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: { teams: { nodes: [TEAMS_RESPONSE.teams.nodes[1]] } },
      }),
    });

    const result = await prefillFromLinear('lin_xyz');
    expect(result.default_team_suggestion).toBe('OGE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test server/integrations/linear/prefill.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement prefill**

Create `server/integrations/linear/prefill.ts`:

```ts
import { linearGraphql } from './graphql.js';

interface LinearState {
  id: string;
  name: string;
  type: string;
}

interface LinearTeam {
  id: string;
  key: string;
  name: string;
  states: { nodes: LinearState[] };
}

interface TeamsResponse {
  teams: { nodes: LinearTeam[] };
}

const TEAMS_QUERY = `
  query Teams {
    teams {
      nodes {
        id
        key
        name
        states {
          nodes { id name type }
        }
      }
    }
  }
`;

const COLUMN_PATTERNS: Record<string, RegExp> = {
  backlog: /^backlog$/i,
  planned: /^(todo|planned)$/i,
  in_progress: /^(in[- ]?progress|in[- ]?development)$/i,
  human_review: /^(in[- ]?review|review)$/i,
  // pr handled same as human_review below
};

export interface PrefillResult {
  teams: Array<{
    id: string;
    key: string;
    name: string;
    states: LinearState[];
  }>;
  status_map_by_team: Record<
    string,
    Partial<Record<'backlog' | 'planned' | 'in_progress' | 'human_review' | 'pr' | 'done', string>>
  >;
  default_team_suggestion: string | null;
}

function pickByName(states: LinearState[], pattern: RegExp): string | undefined {
  const match = states.find((s) => pattern.test(s.name.trim()));
  return match?.id;
}

function pickDone(states: LinearState[]): string | undefined {
  // Prefer a state literally named "Done"; otherwise the first completed-type state.
  const byName = states.find((s) => /^done$/i.test(s.name.trim()));
  if (byName) return byName.id;
  const byType = states.find((s) => s.type === 'completed');
  return byType?.id;
}

export async function prefillFromLinear(apiKey: string): Promise<PrefillResult> {
  const data = await linearGraphql<TeamsResponse>(apiKey, TEAMS_QUERY);
  const teamsRaw = data.teams?.nodes ?? [];

  const teams = teamsRaw.map((t) => ({
    id: t.id,
    key: t.key,
    name: t.name,
    states: t.states.nodes,
  }));

  const status_map_by_team: PrefillResult['status_map_by_team'] = {};
  for (const t of teams) {
    const map: Partial<Record<string, string>> = {};
    for (const [col, pattern] of Object.entries(COLUMN_PATTERNS)) {
      const id = pickByName(t.states, pattern);
      if (id) map[col] = id;
    }
    // pr defaults to the human_review choice (Linear rarely has a distinct PR state).
    if (map.human_review) map.pr = map.human_review;
    const done = pickDone(t.states);
    if (done) map.done = done;
    status_map_by_team[t.key] = map as PrefillResult['status_map_by_team'][string];
  }

  const default_team_suggestion = teams.find((t) => t.key === 'BAC')?.key ?? teams[0]?.key ?? null;

  return { teams, status_map_by_team, default_team_suggestion };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test server/integrations/linear/prefill.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/integrations/linear/prefill.ts server/integrations/linear/prefill.test.ts
git commit -m "feat(integrations): add Linear prefill with fuzzy state matching"
```

---

## Task 8: API endpoint — `POST /api/integrations/linear/prefill`

**Files:**

- Modify: `server/api.ts`
- Create: `server/api.linear-prefill.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/api.linear-prefill.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { createApp } from './app.js';
import { createTestDb } from './test-helpers.js';

describe('POST /api/integrations/linear/prefill', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  it('returns prefilled map for given api key', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: {
          teams: {
            nodes: [
              {
                id: 'team-bac',
                key: 'BAC',
                name: 'Backend',
                states: {
                  nodes: [
                    { id: 's-backlog', name: 'Backlog', type: 'backlog' },
                    { id: 's-done', name: 'Done', type: 'completed' },
                  ],
                },
              },
            ],
          },
        },
      }),
    });

    const app = createApp();
    const res = await request(app)
      .post('/api/integrations/linear/prefill')
      .send({ api_key: 'lin_xyz' })
      .expect(200);

    expect(res.body.teams).toHaveLength(1);
    expect(res.body.status_map_by_team.BAC.backlog).toBe('s-backlog');
    expect(res.body.status_map_by_team.BAC.done).toBe('s-done');
    expect(res.body.default_team_suggestion).toBe('BAC');
  });

  it('returns 400 when api_key missing', async () => {
    const app = createApp();
    const res = await request(app).post('/api/integrations/linear/prefill').send({}).expect(400);
    expect(res.body.error).toMatch(/api_key/);
  });

  it('returns 502 on Linear auth failure', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        errors: [
          { message: 'Authentication failed', extensions: { code: 'AUTHENTICATION_ERROR' } },
        ],
      }),
    });
    const app = createApp();
    const res = await request(app)
      .post('/api/integrations/linear/prefill')
      .send({ api_key: 'bad' })
      .expect(502);
    expect(res.body.error).toMatch(/authentication/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test server/api.linear-prefill.test.ts`
Expected: FAIL — route doesn't exist (404).

- [ ] **Step 3: Add the route to `server/api.ts`**

Locate the integrations REST section (search for `POST /api/integrations/:id/test`). Add this route near it:

```ts
app.post('/api/integrations/linear/prefill', async (req: Request, res: Response) => {
  const body = req.body as { api_key?: string };
  const apiKey = body.api_key?.trim();
  if (!apiKey) {
    res.status(400).json({ error: 'api_key is required' });
    return;
  }
  try {
    const { prefillFromLinear } = await import('./integrations/linear/prefill.js');
    const result = await prefillFromLinear(apiKey);
    res.json(result);
  } catch (err) {
    const message = (err as Error).message;
    res.status(502).json({ error: message });
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test server/api.linear-prefill.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/api.ts server/api.linear-prefill.test.ts
git commit -m "feat(api): add POST /api/integrations/linear/prefill"
```

---

## Phase 4 — CLI + ref metadata flow

## Task 9: `task-ref-add --metadata` CLI flag

**Files:**

- Modify: `cli/src/commands/task-ref-add.ts`
- Create: `cli/src/commands/task-ref-add.test.ts`
- Modify: `cli/src/client.ts` (or whichever file declares `addTaskRef` — verify with `grep -r 'addTaskRef' cli/src`)

- [ ] **Step 1: Write the failing test**

Create `cli/src/commands/task-ref-add.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerTaskRefAdd } from './task-ref-add.js';

function makeProgram(client: { addTaskRef: ReturnType<typeof vi.fn> }) {
  const program = new Command();
  program.exitOverride();
  // The real CLI calls `getContext(cmd)` to fetch the client.
  // The simplest test plumbing is to attach the client onto the program and intercept getContext.
  // Use vi.doMock on '../action.js' so getContext returns our client.
  return { program, client };
}

vi.mock('../action.js', () => ({
  getContext: (_cmd: unknown) => ({
    client: (globalThis as any).__testClient,
    json: false,
  }),
}));

describe('task-ref-add CLI', () => {
  let addTaskRef: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    addTaskRef = vi.fn().mockResolvedValue({
      integration: 'linear',
      ref: 'BAC-1',
      url: null,
      metadata: null,
    });
    (globalThis as any).__testClient = { addTaskRef };
  });

  it('passes a parsed --metadata object to the client', async () => {
    const program = new Command();
    program.exitOverride();
    registerTaskRefAdd(program);
    await program.parseAsync([
      'node',
      'octomux',
      'task-ref-add',
      'task-1',
      'linear',
      'BAC-1',
      '--metadata',
      '{"team_key":"BAC","team_id":"uuid-1"}',
    ]);
    expect(addTaskRef).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        integration: 'linear',
        external_id: 'BAC-1',
        metadata: { team_key: 'BAC', team_id: 'uuid-1' },
      }),
    );
  });

  it('rejects non-object metadata (JSON array)', async () => {
    const program = new Command();
    program.exitOverride();
    registerTaskRefAdd(program);
    await expect(
      program.parseAsync([
        'node',
        'octomux',
        'task-ref-add',
        'task-1',
        'linear',
        'BAC-1',
        '--metadata',
        '[1,2,3]',
      ]),
    ).rejects.toThrow(/metadata.*object/i);
  });

  it('rejects invalid JSON', async () => {
    const program = new Command();
    program.exitOverride();
    registerTaskRefAdd(program);
    await expect(
      program.parseAsync([
        'node',
        'octomux',
        'task-ref-add',
        'task-1',
        'linear',
        'BAC-1',
        '--metadata',
        '{not json}',
      ]),
    ).rejects.toThrow(/metadata.*invalid|metadata.*JSON/i);
  });

  it('works without --metadata (backward compatible)', async () => {
    const program = new Command();
    program.exitOverride();
    registerTaskRefAdd(program);
    await program.parseAsync(['node', 'octomux', 'task-ref-add', 'task-1', 'jira', 'PROJ-1']);
    expect(addTaskRef).toHaveBeenCalledWith(
      'task-1',
      expect.not.objectContaining({ metadata: expect.anything() }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test cli/src/commands/task-ref-add.test.ts`
Expected: FAIL — flag doesn't exist.

- [ ] **Step 3: Add the flag and parse logic**

Replace `cli/src/commands/task-ref-add.ts` with:

```ts
import { Command } from 'commander';
import { getContext } from '../action.js';
import { outputJson, success, label } from '../format.js';

function parseMetadata(raw: string | undefined): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('--metadata is invalid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('--metadata must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function registerTaskRefAdd(program: Command): void {
  program
    .command('task-ref-add <id> <integration> <external_id>')
    .description('Link an external reference (e.g. Jira ticket, Linear issue) to a task')
    .option('-u, --url <url>', 'URL for the external item')
    .option('-t, --title <title>', 'display title for the external item')
    .option('-m, --metadata <json>', 'JSON object with integration-specific metadata')
    .action(async (id: string, integration: string, externalId: string, opts, cmd) => {
      const { client, json } = getContext(cmd);

      const metadata = parseMetadata(opts.metadata as string | undefined);

      const ref = await client.addTaskRef(id, {
        integration,
        external_id: externalId,
        url: opts.url,
        title: opts.title,
        ...(metadata !== undefined ? { metadata } : {}),
      });

      if (json) {
        outputJson(ref);
        return;
      }

      success(`Linked ${integration}:${externalId} to task ${id}`);
      if (ref.url) console.log(label('URL', ref.url));
      if (ref.title) console.log(label('Title', ref.title));
    });
}
```

- [ ] **Step 4: Extend the client signature**

Find the `addTaskRef` declaration (likely in `cli/src/client.ts` — `grep -n 'addTaskRef' cli/src/*.ts`). Add `metadata?: Record<string, unknown>` to the input type and pass it through to the request body:

```ts
async addTaskRef(
  taskId: string,
  input: {
    integration: string;
    external_id: string;
    url?: string;
    title?: string;
    metadata?: Record<string, unknown>; // NEW
  },
): Promise<TaskExternalRef> {
  // ... existing fetch call, just include metadata in the body when present
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test cli/src/commands/task-ref-add.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cli/src/commands/task-ref-add.ts cli/src/commands/task-ref-add.test.ts cli/src/client.ts
git commit -m "feat(cli): add --metadata flag to task-ref-add"
```

---

## Task 10: Server accepts and returns `metadata` on ref endpoints

**Files:**

- Modify: `server/api.ts` (`POST /api/tasks/:id/refs` and `GET /api/tasks/:id/refs`)
- Modify or add: `server/api.task-refs.test.ts` (or extend existing API tests — grep for `task_external_refs` in test files)

- [ ] **Step 1: Write the failing test**

In `server/api.task-refs.test.ts` (create if needed) or extend the appropriate existing supertest file:

```ts
describe('POST /api/tasks/:id/refs metadata', () => {
  it('accepts a metadata object and round-trips it', async () => {
    const app = createApp();
    // ... create a task first (use existing test helper or POST /api/tasks)
    const taskId = await createTestTask(app);

    const res = await request(app)
      .post(`/api/tasks/${taskId}/refs`)
      .send({
        integration: 'linear',
        ref: 'BAC-1',
        url: 'https://linear.app/x/issue/BAC-1',
        metadata: { team_key: 'BAC', team_id: 'uuid-1' },
      })
      .expect(201);

    expect(res.body.metadata).toEqual({ team_key: 'BAC', team_id: 'uuid-1' });

    const list = await request(app).get(`/api/tasks/${taskId}/refs`).expect(200);
    expect(list.body[0].metadata).toEqual({ team_key: 'BAC', team_id: 'uuid-1' });
  });

  it('rejects non-object metadata', async () => {
    const app = createApp();
    const taskId = await createTestTask(app);

    await request(app)
      .post(`/api/tasks/${taskId}/refs`)
      .send({ integration: 'linear', ref: 'BAC-2', metadata: [1, 2] })
      .expect(400);
  });

  it('legacy POST without metadata returns metadata: null', async () => {
    const app = createApp();
    const taskId = await createTestTask(app);
    const res = await request(app)
      .post(`/api/tasks/${taskId}/refs`)
      .send({ integration: 'jira', ref: 'PROJ-1' })
      .expect(201);
    expect(res.body.metadata).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test server/api.task-refs.test.ts`
Expected: FAIL — `metadata` not persisted.

- [ ] **Step 3: Update `POST /api/tasks/:id/refs` in `server/api.ts`**

Replace the handler body (lines 2367–2397) with:

```ts
app.post('/api/tasks/:id/refs', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const db = getDb();
  const body = req.body as AddRefRequest & { metadata?: unknown };

  if (!body.integration?.trim()) {
    res.status(400).json({ error: 'integration is required' });
    return;
  }
  if (!body.ref?.trim()) {
    res.status(400).json({ error: 'ref is required' });
    return;
  }
  if (
    body.metadata !== undefined &&
    body.metadata !== null &&
    (typeof body.metadata !== 'object' || Array.isArray(body.metadata))
  ) {
    res.status(400).json({ error: 'metadata must be a JSON object' });
    return;
  }

  const metadataJson =
    body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? JSON.stringify(body.metadata)
      : null;

  db.prepare(
    `INSERT OR REPLACE INTO task_external_refs (task_id, integration, ref, url, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  ).run(task.id, body.integration, body.ref, body.url ?? null, metadataJson);

  fireHook('ref_added', {
    event: 'ref_added',
    task,
    data: { integration: body.integration, ref: body.ref, url: body.url },
  });

  const raw = db
    .prepare('SELECT * FROM task_external_refs WHERE task_id = ? AND integration = ?')
    .get(task.id, body.integration) as { metadata: string | null } & Record<string, unknown>;

  res.status(201).json({
    ...raw,
    metadata: raw.metadata ? (JSON.parse(raw.metadata) as Record<string, unknown>) : null,
  });
});
```

- [ ] **Step 4: Update `GET /api/tasks/:id/refs` (lines 2443–2451)**

```ts
app.get('/api/tasks/:id/refs', (req: Request, res: Response) => {
  const task = loadTaskOrFail(req, res);
  if (!task) return;
  const db = getDb();
  const refs = db
    .prepare('SELECT * FROM task_external_refs WHERE task_id = ? ORDER BY created_at ASC')
    .all(task.id) as Array<{ metadata: string | null } & Record<string, unknown>>;
  res.json(
    refs.map((r) => ({
      ...r,
      metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : null,
    })),
  );
});
```

Also extend the `AddRefRequest` interface (search for its declaration) to add `metadata?: Record<string, unknown> | null`.

- [ ] **Step 5: Update any helper that reads task refs for hooks**

Search for `external_refs` references in handler-feeding code:

```bash
grep -rn 'external_refs' server/ --include='*.ts' | grep -v test
```

Anywhere a ref is loaded for the hook envelope, parse the `metadata` column. The simplest pattern: build a `loadTaskExternalRefs(taskId)` helper that returns parsed metadata, and use it everywhere `task.external_refs` is populated.

- [ ] **Step 6: Run test to verify it passes**

Run: `bun run test server/api.task-refs.test.ts`
Expected: PASS.

Also re-run: `bun run test server/integrations/linear/index.test.ts` to confirm the handler still sees `metadata` as an object (not a string).

- [ ] **Step 7: Commit**

```bash
git add server/api.ts server/api.task-refs.test.ts server/types.ts
git commit -m "feat(api): accept and return metadata on task ref endpoints"
```

---

## Phase 5 — Frontend

## Task 11: Frontend API client — types and prefill method

**Files:**

- Modify: `src/lib/api.ts`

- [ ] **Step 1: Inspect existing `TaskExternalRef` type and `OctomuxSettings` type in `src/lib/api.ts`.**

Run: `grep -n 'TaskExternalRef\|OctomuxSettings' src/lib/api.ts`

- [ ] **Step 2: Extend `TaskExternalRef`**

Add `metadata: Record<string, unknown> | null` to the interface.

- [ ] **Step 3: Extend `OctomuxSettings` mirror type**

Add `defaultTracker?: 'jira' | 'linear'` and `defaultLinearTeamKey?: string` to the SPA's settings type, matching the server interface.

- [ ] **Step 4: Add `prefillLinear`**

Append to the `api` object:

```ts
async prefillLinear(apiKey: string): Promise<{
  teams: Array<{ id: string; key: string; name: string; states: Array<{ id: string; name: string; type: string }> }>;
  status_map_by_team: Record<string, Partial<Record<'backlog' | 'planned' | 'in_progress' | 'human_review' | 'pr' | 'done', string>>>;
  default_team_suggestion: string | null;
}> {
  const res = await fetch('/api/integrations/linear/prefill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `prefill failed: ${res.status}`);
  }
  return res.json();
},
```

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors. If any existing call site to `addTaskRef` / `getSettings` breaks, fix it (most likely just adding `metadata: null` to test fixtures).

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(api-client): add Linear prefill + metadata field"
```

---

## Task 12: `LinearConfigForm` component

**Files:**

- Create: `src/components/integrations/LinearConfigForm.tsx`
- Create: `src/components/integrations/LinearConfigForm.test.tsx`

- [ ] **Step 1: Write the failing component test**

Create `src/components/integrations/LinearConfigForm.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LinearConfigForm } from './LinearConfigForm.js';
import { api } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  api: {
    prefillLinear: vi.fn(),
  },
}));

describe('LinearConfigForm', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders an empty form by default', () => {
    render(<LinearConfigForm onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByLabelText(/api key/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /connect.*auto-detect/i })).toBeInTheDocument();
  });

  it('calls prefillLinear when Connect & auto-detect is clicked, then shows team rows', async () => {
    (api.prefillLinear as any).mockResolvedValue({
      teams: [
        {
          id: 'team-bac',
          key: 'BAC',
          name: 'Backend',
          states: [
            { id: 's-backlog', name: 'Backlog', type: 'backlog' },
            { id: 's-done', name: 'Done', type: 'completed' },
          ],
        },
      ],
      status_map_by_team: { BAC: { backlog: 's-backlog', done: 's-done' } },
      default_team_suggestion: 'BAC',
    });

    const user = userEvent.setup();
    render(<LinearConfigForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText(/api key/i), 'lin_xyz');
    await user.click(screen.getByRole('button', { name: /connect.*auto-detect/i }));

    expect(api.prefillLinear).toHaveBeenCalledWith('lin_xyz');
    expect(await screen.findByText(/Backend \(BAC\)/i)).toBeInTheDocument();
  });

  it('submits the full config including status_map_by_team and default_team_key', async () => {
    (api.prefillLinear as any).mockResolvedValue({
      teams: [
        {
          id: 'team-bac',
          key: 'BAC',
          name: 'Backend',
          states: [{ id: 's-done', name: 'Done', type: 'completed' }],
        },
      ],
      status_map_by_team: { BAC: { done: 's-done' } },
      default_team_suggestion: 'BAC',
    });

    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<LinearConfigForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText(/api key/i), 'lin_xyz');
    await user.click(screen.getByRole('button', { name: /connect.*auto-detect/i }));
    await screen.findByText(/Backend \(BAC\)/i);
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        api_key: 'lin_xyz',
        default_team_key: 'BAC',
        status_map_by_team: { BAC: { done: 's-done' } },
      }),
      expect.any(String), // integration name
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/components/integrations/LinearConfigForm.test.tsx`
Expected: FAIL — component doesn't exist.

- [ ] **Step 3: Implement `LinearConfigForm`**

Create `src/components/integrations/LinearConfigForm.tsx`. Model the structure on `JiraConfigForm.tsx`:

```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import type { IntegrationRow } from '@/lib/api';

const WORKFLOW_STATUSES = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'planned', label: 'Planned' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'human_review', label: 'Human Review' },
  { key: 'pr', label: 'PR' },
  { key: 'done', label: 'Done' },
] as const;

type Column = (typeof WORKFLOW_STATUSES)[number]['key'];

export interface LinearConfig {
  api_key: string;
  workspace_url?: string;
  default_team_key?: string;
  status_map_by_team: Record<string, Partial<Record<Column, string>>>;
}

interface PrefillTeam {
  id: string;
  key: string;
  name: string;
  states: Array<{ id: string; name: string; type: string }>;
}

interface LinearConfigFormProps {
  initial?: Partial<LinearConfig>;
  prefillTeams?: PrefillTeam[]; // present when editing — re-show teams without re-prefill
  onSubmit: (config: LinearConfig, name: string) => Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
  nameInitial?: string;
}

export function LinearConfigForm({
  initial,
  prefillTeams: prefillTeamsInitial,
  onSubmit,
  onCancel,
  submitLabel = 'Save',
  nameInitial = '',
}: LinearConfigFormProps) {
  const [name, setName] = useState(nameInitial);
  const [apiKey, setApiKey] = useState(initial?.api_key ?? '');
  const [defaultTeamKey, setDefaultTeamKey] = useState(initial?.default_team_key ?? '');
  const [statusMapByTeam, setStatusMapByTeam] = useState<
    Record<string, Partial<Record<Column, string>>>
  >(initial?.status_map_by_team ?? {});
  const [teams, setTeams] = useState<PrefillTeam[]>(prefillTeamsInitial ?? []);
  const [prefilling, setPrefilling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handlePrefill() {
    setError(null);
    setPrefilling(true);
    try {
      const result = await api.prefillLinear(apiKey);
      setTeams(result.teams);
      setStatusMapByTeam(result.status_map_by_team);
      if (!defaultTeamKey && result.default_team_suggestion) {
        setDefaultTeamKey(result.default_team_suggestion);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPrefilling(false);
    }
  }

  function setMapping(teamKey: string, col: Column, stateId: string | undefined) {
    setStatusMapByTeam((prev) => {
      const teamMap = { ...(prev[teamKey] ?? {}) };
      if (stateId) {
        teamMap[col] = stateId;
      } else {
        delete teamMap[col];
      }
      return { ...prev, [teamKey]: teamMap };
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onSubmit(
        {
          api_key: apiKey.trim(),
          default_team_key: defaultTeamKey.trim() || undefined,
          status_map_by_team: statusMapByTeam,
        },
        name.trim() || 'Linear',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="linear-name" className="mb-1 block text-xs text-[#b5b5bd]">
          Integration name
        </label>
        <input
          id="linear-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Linear"
          className="w-full border border-glass-edge bg-[#0B0C0F] px-3 py-2 text-sm text-white outline-none focus:border-[#3B82F6]"
        />
      </div>

      <div>
        <label htmlFor="linear-api-key" className="mb-1 block text-xs text-[#b5b5bd]">
          API key
        </label>
        <input
          id="linear-api-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="lin_api_..."
          className="w-full border border-glass-edge bg-[#0B0C0F] px-3 py-2 font-mono text-sm text-white outline-none focus:border-[#3B82F6]"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!apiKey || prefilling}
          onClick={handlePrefill}
        >
          {prefilling ? 'Connecting…' : 'Connect & auto-detect teams'}
        </Button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>

      {teams.length > 0 && (
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-[#b5b5bd]">Default team</label>
            <select
              value={defaultTeamKey}
              onChange={(e) => setDefaultTeamKey(e.target.value)}
              className="w-full border border-glass-edge bg-[#0B0C0F] px-3 py-2 text-sm text-white outline-none focus:border-[#3B82F6]"
            >
              {teams.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.name} ({t.key})
                </option>
              ))}
            </select>
          </div>

          {teams.map((team) => {
            const teamMap = statusMapByTeam[team.key] ?? {};
            return (
              <details key={team.key} open={team.key === defaultTeamKey}>
                <summary className="cursor-pointer py-1 text-sm text-white">
                  {team.name} ({team.key})
                </summary>
                <div className="mt-2 space-y-2 pl-3">
                  {WORKFLOW_STATUSES.map((wf) => (
                    <div key={wf.key} className="flex items-center gap-2">
                      <span className="w-32 text-xs text-[#b5b5bd]">{wf.label}</span>
                      <select
                        value={teamMap[wf.key] ?? ''}
                        onChange={(e) => setMapping(team.key, wf.key, e.target.value || undefined)}
                        className="flex-1 border border-glass-edge bg-[#0B0C0F] px-2 py-1 text-xs text-white outline-none focus:border-[#3B82F6]"
                      >
                        <option value="">— unmapped —</option>
                        {team.states.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={submitting || !apiKey}>
          {submitting ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function toLinearConfig(row: IntegrationRow): LinearConfig {
  return row.config as LinearConfig;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/components/integrations/LinearConfigForm.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/integrations/LinearConfigForm.tsx src/components/integrations/LinearConfigForm.test.tsx
git commit -m "feat(ui): add LinearConfigForm with prefill + per-team status maps"
```

---

## Task 13: Wire `LinearConfigForm` into `IntegrationsPage`

**Files:**

- Modify: `src/pages/IntegrationsPage.tsx`

- [ ] **Step 1: Generalize the provider row's "Add" button**

In `src/pages/IntegrationsPage.tsx`, replace the hard-coded `if (p.kind === 'jira')` block at line 226–230 with a generic "Add" button per provider, then dispatch by kind inside `setModal`:

```tsx
{
  providers.map((p) => (
    <div key={p.kind} className="flex items-center justify-between py-3" style={ROW_DIVIDER}>
      <div className="flex items-center gap-3">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary/20 text-sm font-bold text-primary">
          {providerIcon(p.kind)}
        </span>
        <div>
          <p className="text-sm font-medium text-foreground">{p.displayName}</p>
          <p className="text-xs text-muted-soft">Events: {p.events.join(', ')}</p>
        </div>
      </div>
      <Button
        size="sm"
        onClick={() => {
          if (p.kind === 'jira') setModal({ kind: 'create-jira' });
          else if (p.kind === 'linear') setModal({ kind: 'create-linear' });
        }}
      >
        Add {p.displayName}
      </Button>
    </div>
  ));
}
```

- [ ] **Step 2: Add Linear modal branches**

Extend the `modal` state type:

```tsx
const [modal, setModal] = useState<
  | { kind: 'create-jira' }
  | { kind: 'edit-jira'; integration: IntegrationRow }
  | { kind: 'create-linear' }
  | { kind: 'edit-linear'; integration: IntegrationRow }
  | null
>(null);
```

Add handlers (parallel to `handleCreateJira` / `handleEditJira`):

```tsx
import { LinearConfigForm, toLinearConfig } from '@/components/integrations/LinearConfigForm';
import type { LinearConfig } from '@/components/integrations/LinearConfigForm';

async function handleCreateLinear(config: LinearConfig, name: string) {
  await api.createIntegration('linear', name, config as unknown as Record<string, unknown>);
  setModal(null);
  void refresh();
}

async function handleEditLinear(id: string, config: LinearConfig, name: string) {
  await api.updateIntegration(id, { name, config: config as unknown as Record<string, unknown> });
  setModal(null);
  void refresh();
}
```

Update `providerIcon`:

```tsx
function providerIcon(kind: string): string {
  if (kind === 'jira') return 'J';
  if (kind === 'linear') return 'L';
  return kind.charAt(0).toUpperCase();
}
```

Update edit dispatch (line 246):

```tsx
onEdit={() => {
  if (i.kind === 'jira') setModal({ kind: 'edit-jira', integration: i });
  else if (i.kind === 'linear') setModal({ kind: 'edit-linear', integration: i });
}}
```

Add Linear modals (after the existing Jira modals):

```tsx
{
  modal?.kind === 'create-linear' && (
    <Modal title="Add Linear integration" onClose={() => setModal(null)}>
      <LinearConfigForm
        onSubmit={handleCreateLinear}
        onCancel={() => setModal(null)}
        submitLabel="Create"
      />
    </Modal>
  );
}

{
  modal?.kind === 'edit-linear' && (
    <Modal title="Edit Linear integration" onClose={() => setModal(null)}>
      <LinearConfigForm
        initial={toLinearConfig(modal.integration)}
        nameInitial={modal.integration.name}
        onSubmit={(config, name) => handleEditLinear(modal.integration.id, config, name)}
        onCancel={() => setModal(null)}
        submitLabel="Save changes"
      />
    </Modal>
  );
}
```

- [ ] **Step 3: Verify in a running app**

Run: `bun run dev`
Open `http://localhost:5173/integrations`, click "Add Linear", paste a real Linear API key, click "Connect & auto-detect", confirm Backend appears at the top and the status dropdowns populate. Click Save. Confirm the new integration row appears below.

(If you don't have a real Linear key locally, skip the manual verification — the component test in Task 12 covers the logic.)

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/pages/IntegrationsPage.tsx
git commit -m "feat(ui): wire LinearConfigForm into IntegrationsPage"
```

---

## Task 14: SetupPage — tracker selector + conditional Linear/Jira sections

**Files:**

- Modify: `src/pages/SetupPage.tsx`
- Modify: `src/pages/SetupPage.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `src/pages/SetupPage.test.tsx`:

```tsx
it('shows Linear default-team input when defaultTracker = linear', async () => {
  vi.mocked(api.getSettings).mockResolvedValue({
    editor: 'nvim',
    defaultHarnessId: 'claude-code',
    harnesses: {},
    defaultTracker: 'linear',
    defaultLinearTeamKey: 'BAC',
  } as any);
  vi.mocked(api.getSetupStatus).mockResolvedValue({ items: [], summary: { ready: true } } as any);

  render(<SetupPage />);
  expect(await screen.findByLabelText(/default linear team key/i)).toHaveValue('BAC');
  expect(screen.queryByLabelText(/jira base url/i)).not.toBeInTheDocument();
});

it('shows Jira fields when defaultTracker = jira', async () => {
  vi.mocked(api.getSettings).mockResolvedValue({
    editor: 'nvim',
    defaultHarnessId: 'claude-code',
    harnesses: {},
    defaultTracker: 'jira',
    defaultJiraBaseUrl: 'https://x.atlassian.net',
    defaultJiraProjectKey: 'PROJ',
  } as any);
  vi.mocked(api.getSetupStatus).mockResolvedValue({ items: [], summary: { ready: true } } as any);

  render(<SetupPage />);
  expect(await screen.findByLabelText(/jira base url/i)).toHaveValue('https://x.atlassian.net');
  expect(screen.queryByLabelText(/default linear team key/i)).not.toBeInTheDocument();
});

it('switching tracker dropdown swaps the conditional sections', async () => {
  vi.mocked(api.getSettings).mockResolvedValue({
    editor: 'nvim',
    defaultHarnessId: 'claude-code',
    harnesses: {},
    defaultTracker: 'linear',
  } as any);
  vi.mocked(api.getSetupStatus).mockResolvedValue({ items: [], summary: { ready: true } } as any);

  const user = userEvent.setup();
  render(<SetupPage />);
  await screen.findByLabelText(/default linear team key/i);
  await user.selectOptions(screen.getByLabelText(/default tracker/i), 'jira');
  expect(screen.queryByLabelText(/default linear team key/i)).not.toBeInTheDocument();
  expect(screen.getByLabelText(/jira base url/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/pages/SetupPage.test.tsx`
Expected: FAIL — tracker selector doesn't exist.

- [ ] **Step 3: Refactor `DefaultsForm`**

Replace the `DefaultsForm` block in `src/pages/SetupPage.tsx` (lines 113–194) with:

```tsx
function DefaultsForm({
  initial,
  onSaved,
}: {
  initial: {
    defaultTracker?: 'jira' | 'linear';
    defaultBaseBranch?: string;
    defaultJiraBaseUrl?: string;
    defaultJiraProjectKey?: string;
    defaultLinearTeamKey?: string;
  };
  onSaved: () => void;
}) {
  const [tracker, setTracker] = useState<'jira' | 'linear' | ''>(initial.defaultTracker ?? '');
  const [baseBranch, setBaseBranch] = useState(initial.defaultBaseBranch ?? '');
  const [jiraUrl, setJiraUrl] = useState(initial.defaultJiraBaseUrl ?? '');
  const [jiraProject, setJiraProject] = useState(initial.defaultJiraProjectKey ?? '');
  const [linearTeamKey, setLinearTeamKey] = useState(initial.defaultLinearTeamKey ?? '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.updateSettings({
        defaultTracker: tracker || undefined,
        defaultBaseBranch: baseBranch.trim() || undefined,
        defaultJiraBaseUrl: jiraUrl.trim() || undefined,
        defaultJiraProjectKey: jiraProject.trim().toUpperCase() || undefined,
        defaultLinearTeamKey: linearTeamKey.trim().toUpperCase() || undefined,
      });
      showToast('success', 'DEFAULTS', 'Task defaults saved');
      onSaved();
    } catch (err) {
      showToast('error', 'ERROR', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 pt-2">
      <div>
        <label htmlFor="default-tracker" className="mb-1 block text-xs text-[#b5b5bd]">
          Default tracker
        </label>
        <select
          id="default-tracker"
          value={tracker}
          onChange={(e) => setTracker(e.target.value as 'jira' | 'linear' | '')}
          className="w-full border border-glass-edge bg-[#0B0C0F] px-3 py-2 text-sm text-white outline-none focus:border-[#3B82F6]"
          data-testid="setup-default-tracker"
        >
          <option value="">— none —</option>
          <option value="linear">Linear</option>
          <option value="jira">Jira</option>
        </select>
      </div>
      <div>
        <label className="mb-1 block text-xs text-[#b5b5bd]">Default base branch</label>
        <input
          type="text"
          value={baseBranch}
          onChange={(e) => setBaseBranch(e.target.value)}
          placeholder="main"
          className="w-full border border-glass-edge bg-[#0B0C0F] px-3 py-2 font-mono text-sm text-white outline-none focus:border-[#3B82F6]"
          data-testid="setup-default-branch"
        />
      </div>

      {tracker === 'linear' && (
        <div>
          <label htmlFor="default-linear-team" className="mb-1 block text-xs text-[#b5b5bd]">
            Default Linear team key
          </label>
          <input
            id="default-linear-team"
            type="text"
            value={linearTeamKey}
            onChange={(e) => setLinearTeamKey(e.target.value)}
            placeholder="BAC"
            className="w-full border border-glass-edge bg-[#0B0C0F] px-3 py-2 font-mono text-sm text-white outline-none focus:border-[#3B82F6]"
          />
        </div>
      )}

      {(tracker === 'jira' || initial.defaultJiraBaseUrl) && (
        <>
          <div>
            <label htmlFor="default-jira-url" className="mb-1 block text-xs text-[#b5b5bd]">
              Jira base URL (optional)
            </label>
            <input
              id="default-jira-url"
              type="text"
              value={jiraUrl}
              onChange={(e) => setJiraUrl(e.target.value)}
              placeholder="https://your-co.atlassian.net"
              className="w-full border border-glass-edge bg-[#0B0C0F] px-3 py-2 font-mono text-sm text-white outline-none focus:border-[#3B82F6]"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-[#b5b5bd]">
              Default Jira project key (optional)
            </label>
            <input
              type="text"
              value={jiraProject}
              onChange={(e) => setJiraProject(e.target.value)}
              placeholder="PROJ"
              className="w-full border border-glass-edge bg-[#0B0C0F] px-3 py-2 font-mono text-sm text-white outline-none focus:border-[#3B82F6]"
            />
          </div>
        </>
      )}

      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={saving}
          onClick={save}
          data-testid="setup-save-defaults"
        >
          {saving ? 'Saving…' : 'Save defaults'}
        </Button>
      </div>
    </div>
  );
}
```

Also update the prop `initial` passed by the parent (around line 353):

```tsx
{
  settings && <DefaultsForm initial={settings} onSaved={load} />;
}
```

`settings` already includes the new fields once Task 11 lands.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/pages/SetupPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pages/SetupPage.tsx src/pages/SetupPage.test.tsx
git commit -m "feat(ui): add tracker selector to Setup page defaults"
```

---

## Task 15: TaskRefsPanel — Linear chip + team badge

**Files:**

- Modify: `src/components/TaskRefsPanel.tsx`
- Modify: `src/components/TaskRefsPanel.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `src/components/TaskRefsPanel.test.tsx`:

```tsx
it('renders Linear chip with team badge when metadata.team_key is present', () => {
  const refs = [
    {
      task_id: 't1',
      integration: 'linear',
      ref: 'BAC-1',
      url: 'https://linear.app/x/issue/BAC-1',
      metadata: { team_key: 'BAC' },
      created_at: '2026-05-29T00:00:00Z',
    },
  ];
  render(<TaskRefsPanel refs={refs} taskId="t1" onChange={vi.fn()} />);
  expect(screen.getByText('BAC-1')).toBeInTheDocument();
  expect(screen.getByText('BAC')).toBeInTheDocument();
});

it('falls back to plain rendering when metadata is null', () => {
  const refs = [
    {
      task_id: 't1',
      integration: 'jira',
      ref: 'PROJ-1',
      url: null,
      metadata: null,
      created_at: '2026-05-29T00:00:00Z',
    },
  ];
  render(<TaskRefsPanel refs={refs} taskId="t1" onChange={vi.fn()} />);
  expect(screen.getByText('PROJ-1')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test src/components/TaskRefsPanel.test.tsx`
Expected: FAIL — team badge not rendered.

- [ ] **Step 3: Update the chip rendering**

In `src/components/TaskRefsPanel.tsx`, modify the existing chip block (around lines 82–111) to read metadata:

```tsx
{
  refs.map((r) => {
    const teamKey =
      r.metadata && typeof r.metadata === 'object' && 'team_key' in r.metadata
        ? String((r.metadata as { team_key?: unknown }).team_key ?? '')
        : '';
    return (
      <div
        key={r.integration}
        className="flex items-center gap-2 rounded-lg border border-glass-edge bg-glass-l1 px-3 py-2"
        data-integration={r.integration}
      >
        <span
          className={`text-[11px] font-medium ${r.integration === 'linear' ? 'text-[#a78bfa]' : 'text-muted-foreground'}`}
        >
          {r.integration}
        </span>
        <span className="text-[10px] text-muted-soft">:</span>
        {r.url ? (
          <a
            href={r.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-primary hover:underline"
          >
            {r.ref}
          </a>
        ) : (
          <span className="text-[11px] text-foreground">{r.ref}</span>
        )}
        {teamKey && (
          <span className="rounded bg-glass-l2 px-1.5 py-0.5 text-[10px] font-medium text-[#b5b5bd]">
            {teamKey}
          </span>
        )}
        <button
          type="button"
          className="ml-auto text-[10px] text-muted-soft hover:text-destructive"
          onClick={() => handleRemove(r.integration)}
          aria-label={`Remove ${r.integration} ref`}
          data-testid={`remove-ref-${r.integration}`}
        >
          ✕
        </button>
      </div>
    );
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test src/components/TaskRefsPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/TaskRefsPanel.tsx src/components/TaskRefsPanel.test.tsx
git commit -m "feat(ui): show team badge on Linear refs in TaskRefsPanel"
```

---

## Task 15b: Composer — recognize Linear URLs on paste

**Files:**

- Modify: the composer / new-task dialog component (locate via `grep -rln 'atlassian.net/browse\|defaultJiraBaseUrl' src/`)

- [ ] **Step 1: Locate the existing Jira URL paste behavior**

```bash
grep -rn 'atlassian.net' src/ --include='*.tsx' --include='*.ts'
```

The hit (or hits) will be inside the new-task composer or a paste handler. There should be a regex like `/([A-Z][A-Z0-9]+)-\d+/` paired with a URL like `https://*.atlassian.net/browse/...`.

- [ ] **Step 2: Extend the URL regex to also recognize Linear**

Add a parallel branch that matches `linear.app/<workspace>/issue/<KEY>`. The minimum diff is a second regex test:

```ts
const LINEAR_URL_RE = /linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]+-\d+)/;
const JIRA_URL_RE = /atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/;

function parseTrackerUrl(
  text: string,
): { integration: 'linear' | 'jira'; ref: string; url: string } | null {
  const linear = text.match(LINEAR_URL_RE);
  if (linear) return { integration: 'linear', ref: linear[1], url: text };
  const jira = text.match(JIRA_URL_RE);
  if (jira) return { integration: 'jira', ref: jira[1], url: text };
  return null;
}
```

If the existing code already uses a similar pattern for Jira, just add the Linear regex alongside and update the dispatch.

- [ ] **Step 3: Write or extend a test**

In whichever test file covers the composer, add an it() block that pastes a Linear URL and asserts the ref-add suggestion shows up. Pattern follows the existing Jira test in the same file (if no test exists, add one but keep it minimal: render, paste, assert).

- [ ] **Step 4: Typecheck + commit**

```bash
bun run typecheck
git add src/...  # whichever file you modified
git commit -m "feat(ui): recognize Linear issue URLs in composer paste"
```

If the codebase does not have an existing Jira paste handler (the spec mentioned it as an existing pattern; verify before assuming), skip this task — it's a nice-to-have, not a must-have.

---

## Phase 6 — Skills and docs

## Task 16: Update `create-task` SKILL.md for Linear

**Files:**

- Modify: `skills/create-task/SKILL.md`

- [ ] **Step 1: Add a Linear branch to step 1**

Insert after the existing "Fetching Jira ticket details" block (around line 26):

```markdown
**Fetching Linear issue details:**

When the ticket key matches a Linear team prefix (e.g. `BAC-123` where `BAC` is a Linear team key), or the URL is `linear.app/<workspace>/issue/<KEY>`:

1.  Extract the issue key (e.g., `BAC-843`).
2.  Use Linear MCP tools:
    - `mcp__plugin_linear_linear__get_issue({ query: '<issue-key>' })` to fetch title, description, state, labels, priority, team, project.
3.  Map fields to the prompt template:
    - `title` → task title + What section
    - `description` → Context section (extract acceptance criteria if present)
    - `labels[].name` / `priority` → urgency hints in Why section
    - `team.key` + `team.id` + `project.id` → ref metadata (Step 6 below)
    - `state` → ignored (octomux owns workflow state)
4.  Branch naming uses the same convention: `feat/BAC-123-add-position-sync`.

**How to decide which tracker the key belongs to:**

- Full URL with `linear.app` → Linear.
- Full URL with `*.atlassian.net` → Jira.
- Bare key (e.g. `BAC-123`):
  - If you can call `mcp__plugin_linear_linear__list_teams()` and find a team with matching key → Linear.
  - Otherwise treat as Jira (existing behavior).
- If both could match (rare), prefer the value of `defaultTracker` in `~/.octomux/settings.json`.
```

- [ ] **Step 2: Extend step 6 (Create the task) with `task-ref-add` Linear example**

After the existing `octomux create-task` block (around line 105), append:

````markdown
6a. **Link the Linear issue (if applicable):**

If the source was a Linear issue, immediately link it with the cached metadata so the status-sync handler doesn't need to refetch the team on every column change:

```bash
octomux task-ref-add <task-id> linear BAC-843 \
  --url 'https://linear.app/ostium-labs/issue/BAC-843' \
  --metadata '{"team_key":"BAC","team_id":"<uuid>","issue_id":"<uuid>","project_id":null}'
```
````

`team_id`, `issue_id`, and `project_id` come from the `get_issue` response. The handler falls back to a runtime lookup if metadata is missing, but caching is faster and rate-limit-friendly.

````

- [ ] **Step 3: Commit**

```bash
git add skills/create-task/SKILL.md
git commit -m "docs(skills): add Linear branch to create-task"
````

---

## Task 17: Update `update-task-status` SKILL.md

**Files:**

- Modify: `skills/update-task-status/SKILL.md`

- [ ] **Step 1: Add a Linear example in "Linking external references"**

In the "Linking external references" section (around line 88), append a Linear example block:

```markdown
# Link a Linear issue (Backend team example)

octomux task-ref-add abc123 linear BAC-843 \
 --url 'https://linear.app/ostium-labs/issue/BAC-843' \
 --title 'Add position sync to backend' \
 --metadata '{"team_key":"BAC","team_id":"a3b9a29e-9847-4f5e-9eae-6dc0eb63da92","issue_id":"<issue-uuid>"}'
```

Also add a one-line note above the examples block:

```markdown
The `--metadata` flag accepts a JSON object with integration-specific fields. For Linear, cache `team_key/team_id/issue_id/project_id` so the status-sync handler doesn't need extra API calls.
```

- [ ] **Step 2: Commit**

```bash
git add skills/update-task-status/SKILL.md
git commit -m "docs(skills): add Linear example to update-task-status"
```

---

## Task 18: CLAUDE.md gotchas + final verification

**Files:**

- Modify: `CLAUDE.md`

- [ ] **Step 1: Append Linear-specific gotchas**

In the "Gotchas" section of `CLAUDE.md`, append:

```markdown
- `task_external_refs.metadata` is a nullable JSON text column — always parse with `JSON.parse(row.metadata ?? 'null')` server-side, never expose the raw string.
- Linear API uses the bare API key in the `Authorization` header (no `Bearer` prefix) — see `server/integrations/linear/graphql.ts`.
- Linear errors come back as HTTP 200 with an `errors[]` array. Always check for that before treating the response as a success.
```

- [ ] **Step 2: Run the full verification suite**

Run all the verification commands in parallel where possible:

```bash
bun run typecheck
bun run lint
bun run test
bun run format:check
```

Expected: all pass.

If any test fails, fix the issue at root cause — don't skip the test. Common failures:

- Existing API tests that construct `TaskExternalRef` literals will need `metadata: null` added.
- Existing tests for `getSettings` may need to know about the new fields.

- [ ] **Step 3: Run the E2E smoke**

Run: `bun run test:e2e`
Expected: existing E2Es continue to pass. No new E2E was added in this plan — covered by component + supertest layers.

- [ ] **Step 4: Manual smoke (optional but recommended)**

```bash
bun run dev
```

In the browser:

1. Navigate to `/integrations`, click "Add Linear", paste a real Linear API key, click "Connect & auto-detect", confirm Backend team appears with prefilled status maps, save.
2. Navigate to `/setup`, switch default tracker to Linear, type "BAC" for default team key, save.
3. Create a task linked to a Linear issue (use the `/create-task` skill flow, or POST directly to `/api/tasks` + `/api/tasks/:id/refs` with `metadata`).
4. Move the task through columns; observe the Linear issue's state updates and a comment is posted (skip for `backlog`).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document Linear integration gotchas"
```

- [ ] **Step 6: Final inventory**

Run: `git log --oneline main..HEAD`
Expected: 18 commits (19 if Task 15b shipped), all in conventional-commit format:

- feat(db): add metadata JSON column to task_external_refs
- feat(settings): add defaultTracker and defaultLinearTeamKey fields
- feat(integrations): add Linear GraphQL wrapper
- feat(integrations): add Linear provider validate+testConnection
- feat(integrations): add Linear handler for status sync and comment-back
- feat(integrations): register Linear provider
- feat(integrations): add Linear prefill with fuzzy state matching
- feat(api): add POST /api/integrations/linear/prefill
- feat(cli): add --metadata flag to task-ref-add
- feat(api): accept and return metadata on task ref endpoints
- feat(api-client): add Linear prefill + metadata field
- feat(ui): add LinearConfigForm with prefill + per-team status maps
- feat(ui): wire LinearConfigForm into IntegrationsPage
- feat(ui): add tracker selector to Setup page defaults
- feat(ui): show team badge on Linear refs in TaskRefsPanel
- docs(skills): add Linear branch to create-task
- docs(skills): add Linear example to update-task-status
- docs: document Linear integration gotchas

---

## Out of scope (do not implement in this plan)

- Linear webhook → octomux (incoming sync).
- OAuth flow / app registration.
- Cycle/sprint awareness in any skill.
- Multi-workspace Linear support.
- Refactoring Jira provider beyond what this plan touches.
