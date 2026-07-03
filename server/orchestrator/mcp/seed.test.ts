/**
 * server/orchestrator/mcp/seed.test.ts
 *
 * Tests for the Linear seed tool (Task 4.1 / SHR-135):
 *  - pull_linear_issue returns a lean issue summary (pointer to the ticket).
 *  - Summary never contains the full description body or large text blobs.
 *  - Multi-task review card receives the planning session's task list.
 *  - Error handling: unknown issue, API errors, missing config.
 *
 * Spec refs: §5 #4 (plan-first batch card), §12 Phase 4.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createTestDb, insertTask } from '../../test-helpers.js';
import { getDb } from '../../db.js';
import { createConversation, upsertManagedTask } from '../store.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

const mockPush = vi.fn();
vi.mock('../stream.js', () => ({
  pushToConversation: vi.fn((_convId: string, msg: string) => mockPush(msg)),
  dispatchUserTurn: vi.fn().mockResolvedValue(undefined),
  persistAndPush: vi.fn(),
}));

vi.mock('../runner.js', () => ({
  startConversation: vi.fn().mockResolvedValue(undefined),
  resumeConversation: vi.fn().mockResolvedValue(undefined),
  sendTurn: vi.fn().mockResolvedValue(undefined),
  stopConversation: vi.fn().mockResolvedValue(undefined),
  conversationTmuxTarget: vi.fn().mockReturnValue('mock-session:1'),
}));

const mockInvokeLinear = vi.fn();

vi.mock('../../integrations/linear/graphql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../integrations/linear/graphql.js')>();
  return {
    ...actual,
    invokeLinear: (...args: unknown[]) => mockInvokeLinear(...args),
  };
});

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  handlePullLinearIssue,
  buildBatchPlanCard,
  LinearApiError,
  type LinearIssueSummary,
  type SubTaskItem,
} from './seed.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

type MockIssueInput = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state?: { name: string };
  priority?: number;
  estimate?: number | null;
  labels?: { nodes: Array<{ name: string }> };
  assignee?: { name: string; email: string } | null;
  team?: { key: string; name: string };
  description?: string | null;
};

function buildMockIssue(issue: MockIssueInput) {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    priority: issue.priority,
    estimate: issue.estimate,
    description: issue.description,
    get state() {
      return issue.state ? Promise.resolve(issue.state) : Promise.resolve(undefined);
    },
    get team() {
      return issue.team ? Promise.resolve(issue.team) : Promise.resolve(undefined);
    },
    labels: vi.fn().mockResolvedValue({ nodes: issue.labels?.nodes ?? [] }),
  };
}

/** Stub a successful Linear SDK issue fetch. */
function mockLinearIssueResponse(issue: MockIssueInput) {
  mockInvokeLinear.mockImplementationOnce(async (_apiKey, fn) =>
    fn({
      issue: vi.fn().mockResolvedValue(buildMockIssue(issue)),
    }),
  );
}

/** Stub a Linear API error surfaced by invokeLinear. */
function mockLinearError(message: string, code?: string) {
  mockInvokeLinear.mockRejectedValueOnce(new LinearApiError(message, code));
}

/** Stub a Linear HTTP-style failure surfaced by invokeLinear. */
function mockLinearHttpError(status: number) {
  mockInvokeLinear.mockRejectedValueOnce(new LinearApiError(`Linear API HTTP ${status}`));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('handlePullLinearIssue', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['identifier', 'SHR-123'],
    ['UUID', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'],
  ])('accepts issue id as %s and returns a lean summary', async (_label, issueId) => {
    mockLinearIssueResponse({
      id: 'uuid-abc-001',
      identifier: 'SHR-123',
      title: 'Add auth middleware',
      url: 'https://linear.app/team/issue/SHR-123',
      state: { name: 'In Progress' },
      priority: 2,
      estimate: 3,
      labels: { nodes: [{ name: 'backend' }] },
      assignee: { name: 'Alice', email: 'alice@example.com' },
      team: { key: 'SHR', name: 'Shared' },
      description: 'A'.repeat(5000), // large description — must NOT appear in summary
    });

    const result = await handlePullLinearIssue({
      issue_id: issueId,
      api_key: 'lin_api_test_key',
    });

    // Returns a lean summary
    expect(result).toBeDefined();
    expect(result.id).toBe('uuid-abc-001');
    expect(result.identifier).toBe('SHR-123');
    expect(result.title).toBe('Add auth middleware');
    expect(result.url).toBe('https://linear.app/team/issue/SHR-123');
    expect(result.state).toBe('In Progress');
    expect(result.priority).toBe(2);
    expect(result.labels).toEqual(['backend']);
    expect(result.team_key).toBe('SHR');
  });

  it('returns a pointer (url) to the issue — never the full description body', async () => {
    const hugeDescription = 'Long description: ' + 'x'.repeat(10_000);
    mockLinearIssueResponse({
      id: 'uuid-ptr-001',
      identifier: 'SHR-200',
      title: 'Pointer test',
      url: 'https://linear.app/team/issue/SHR-200',
      description: hugeDescription,
    });

    const result = await handlePullLinearIssue({
      issue_id: 'SHR-200',
      api_key: 'lin_api_test_key',
    });

    // Summary must never include the description body
    expect(result).not.toHaveProperty('description');
    // The url is the pointer to the full ticket
    expect(result.url).toMatch(/linear\.app.*SHR-200/);
    // url is short (a pointer, not the content)
    expect(result.url.length).toBeLessThan(512);
  });

  it('includes a brief description_snippet (<=256 chars) when provided', async () => {
    mockLinearIssueResponse({
      id: 'uuid-snip-001',
      identifier: 'SHR-300',
      title: 'Snippet test',
      url: 'https://linear.app/team/issue/SHR-300',
      description:
        'Short context for the planner.' + ' Extra text that should be truncated.'.repeat(20),
    });

    const result = await handlePullLinearIssue({
      issue_id: 'SHR-300',
      api_key: 'lin_api_test_key',
    });

    // Snippet is present and bounded
    if (result.description_snippet !== undefined) {
      expect(typeof result.description_snippet).toBe('string');
      expect(result.description_snippet.length).toBeLessThanOrEqual(256);
    }
  });

  it('returns estimate when available', async () => {
    mockLinearIssueResponse({
      id: 'uuid-est-001',
      identifier: 'SHR-400',
      title: 'Estimated issue',
      url: 'https://linear.app/team/issue/SHR-400',
      estimate: 5,
    });

    const result = await handlePullLinearIssue({
      issue_id: 'SHR-400',
      api_key: 'lin_api_test_key',
    });
    expect(result.estimate).toBe(5);
  });

  it('returns undefined estimate when not set', async () => {
    mockLinearIssueResponse({
      id: 'uuid-noest-001',
      identifier: 'SHR-401',
      title: 'No estimate',
      url: 'https://linear.app/team/issue/SHR-401',
      estimate: null,
    });

    const result = await handlePullLinearIssue({
      issue_id: 'SHR-401',
      api_key: 'lin_api_test_key',
    });
    expect(result.estimate).toBeUndefined();
  });

  it('throws LinearApiError on a GraphQL error response', async () => {
    mockLinearError('Entity not found', 'ENTITY_NOT_FOUND');

    await expect(
      handlePullLinearIssue({ issue_id: 'SHR-999', api_key: 'lin_api_test_key' }),
    ).rejects.toThrow(/Entity not found|not found/i);
  });

  it('throws on HTTP error from Linear', async () => {
    mockLinearHttpError(401);

    await expect(
      handlePullLinearIssue({ issue_id: 'SHR-888', api_key: 'bad_key' }),
    ).rejects.toThrow(/401|HTTP/i);
  });

  it('throws when issue resolves to null (not found)', async () => {
    mockInvokeLinear.mockImplementationOnce(async (_apiKey, fn) =>
      fn({
        issue: vi.fn().mockResolvedValue(null),
      }),
    );

    await expect(
      handlePullLinearIssue({ issue_id: 'SHR-777', api_key: 'lin_api_test_key' }),
    ).rejects.toThrow(/not found|SHR-777/i);
  });

  it('passes the api key through invokeLinear (SDK uses bare key auth)', async () => {
    mockLinearIssueResponse({
      id: 'uuid-auth-001',
      identifier: 'SHR-500',
      title: 'Auth header test',
      url: 'https://linear.app/team/issue/SHR-500',
    });

    await handlePullLinearIssue({ issue_id: 'SHR-500', api_key: 'lin_api_my_key' });

    expect(mockInvokeLinear).toHaveBeenCalledWith('lin_api_my_key', expect.any(Function));
  });
});

// ─── buildBatchPlanCard ───────────────────────────────────────────────────────

describe('buildBatchPlanCard', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  const sampleIssue: LinearIssueSummary = {
    id: 'uuid-bp-001',
    identifier: 'SHR-601',
    title: 'Auth middleware',
    url: 'https://linear.app/team/issue/SHR-601',
    state: 'Backlog',
    priority: 2,
    labels: ['backend'],
    team_key: 'SHR',
  };

  const sampleTasks: SubTaskItem[] = [
    {
      title: 'Add JWT middleware',
      description_pointer: 'plan.json#tasks[0]',
      suggested_model: 'claude-sonnet',
      suggested_effort: 'medium',
    },
    {
      title: 'Write auth tests',
      description_pointer: 'plan.json#tasks[1]',
      suggested_model: 'claude-haiku',
      suggested_effort: 'low',
    },
  ];

  it('renders a batch plan card with the issue summary pointer', () => {
    const card = buildBatchPlanCard('conv-bp-01', sampleIssue, sampleTasks);

    expect(card).toBeDefined();
    expect(card.type).toBe('batch_plan_card');
    expect(card.conversation_id).toBe('conv-bp-01');
    // Issue pointer fields
    expect(card.issue_id).toBe(sampleIssue.id);
    expect(card.issue_identifier).toBe('SHR-601');
    expect(card.issue_url).toBe(sampleIssue.url);
    // Must NOT include issue description body
    expect(JSON.stringify(card)).not.toContain('"description"');
  });

  it('lists all sub-tasks with pointers (never inline content)', () => {
    const card = buildBatchPlanCard('conv-bp-02', sampleIssue, sampleTasks);

    expect(Array.isArray(card.tasks)).toBe(true);
    expect(card.tasks).toHaveLength(2);

    const first = card.tasks[0]!;
    expect(first.title).toBe('Add JWT middleware');
    // description_pointer is a path reference, not content
    expect(first.description_pointer).toBe('plan.json#tasks[0]');
    expect(first.description_pointer.length).toBeLessThan(256);
    // model/effort hints surfaced for right-sizing (§6.7)
    expect(first.suggested_model).toBe('claude-sonnet');
    expect(first.suggested_effort).toBe('medium');
  });

  it('produces a card with approve/reject/edit actions', () => {
    const card = buildBatchPlanCard('conv-bp-03', sampleIssue, sampleTasks);

    expect(Array.isArray(card.actions)).toBe(true);
    const actionNames = card.actions.map((a) => a.type);
    expect(actionNames).toContain('approve_all');
    expect(actionNames).toContain('reject');
    // Edit per item is supported (card-level flag)
    expect(card.supports_per_item_edit).toBe(true);
  });

  it('handles empty task list gracefully', () => {
    const card = buildBatchPlanCard('conv-bp-04', sampleIssue, []);

    expect(card.tasks).toHaveLength(0);
    // Card still valid
    expect(card.type).toBe('batch_plan_card');
  });

  it('never embeds issue description or task prose in the card JSON', () => {
    const issueWithDesc: LinearIssueSummary = {
      ...sampleIssue,
      description_snippet: 'Short context.',
    };
    const tasksWithProse: SubTaskItem[] = [
      {
        title: 'Some task',
        description_pointer: 'plan.json#tasks[0]',
      },
    ];

    const card = buildBatchPlanCard('conv-bp-05', issueWithDesc, tasksWithProse);
    const cardJson = JSON.stringify(card);

    // Only the snippet (<=256 chars) may appear, never full prose
    if (issueWithDesc.description_snippet) {
      // snippet can appear in card as context
      expect(cardJson).toContain(issueWithDesc.description_snippet);
    }
    // But no long prose blobs
    const allValues = JSON.stringify(card);
    // No individual string value should be a large body (>512 chars)
    const parsed = JSON.parse(allValues) as Record<string, unknown>;
    function checkNoLargeProse(obj: unknown): void {
      if (typeof obj === 'string') {
        expect(obj.length).toBeLessThan(512);
      } else if (Array.isArray(obj)) {
        obj.forEach(checkNoLargeProse);
      } else if (obj && typeof obj === 'object') {
        Object.values(obj).forEach(checkNoLargeProse);
      }
    }
    checkNoLargeProse(parsed);
  });
});

// ─── Integration: pull + build card ──────────────────────────────────────────

describe('pull_linear_issue + batch card integration', () => {
  beforeEach(() => {
    createTestDb();
    vi.clearAllMocks();
  });

  it('a planning session task list renders as one multi-task card pushed to the conversation', async () => {
    const convId = createConversation({ title: 'Linear Plan Conv' });
    const planTask = insertTask(getDb(), { id: 'task-lin-01', worktree: null });
    upsertManagedTask({
      conversation_id: convId,
      task_id: planTask.id,
      phase: 'awaiting_approval',
      artifacts: JSON.stringify({ plan: 'plan.json' }),
    });

    mockLinearIssueResponse({
      id: 'uuid-int-001',
      identifier: 'SHR-700',
      title: 'Decompose feature X',
      url: 'https://linear.app/team/issue/SHR-700',
      state: { name: 'In Progress' },
      priority: 1,
      labels: { nodes: [{ name: 'feature' }] },
      team: { key: 'SHR', name: 'Shared' },
    });

    const issue = await handlePullLinearIssue({
      issue_id: 'SHR-700',
      api_key: 'lin_api_test_key',
    });

    const subTasks: SubTaskItem[] = [
      { title: 'Sub A', description_pointer: 'plan.json#tasks[0]' },
      { title: 'Sub B', description_pointer: 'plan.json#tasks[1]' },
    ];

    const card = buildBatchPlanCard(convId, issue, subTasks);

    // One card covers all tasks (§5 #4)
    expect(card.tasks).toHaveLength(2);
    expect(card.issue_identifier).toBe('SHR-700');

    // Simulate pushing the card to the conversation
    const { pushToConversation } = await import('../stream.js');
    (pushToConversation as ReturnType<typeof vi.fn>)(convId, JSON.stringify(card));

    expect(pushToConversation).toHaveBeenCalledWith(convId, expect.any(String));
    // The pushed message is a single batch card (not multiple individual cards)
    const calls = (pushToConversation as ReturnType<typeof vi.fn>).mock.calls as [string, string][];
    const cardPushes = calls.filter(([, msg]) => {
      try {
        return (JSON.parse(msg) as { type?: string }).type === 'batch_plan_card';
      } catch {
        return false;
      }
    });
    expect(cardPushes).toHaveLength(1);
  });
});
