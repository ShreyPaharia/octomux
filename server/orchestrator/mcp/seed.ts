/**
 * server/orchestrator/mcp/seed.ts
 *
 * Linear seed tool + batch plan card builder (Task 4.1 / SHR-135).
 *
 * Implements spec §5 #4 and Phase 4:
 *   - `pull_linear_issue(id, api_key)` — fetch an issue from Linear and return a
 *     LEAN SUMMARY (pointer to the ticket). The full description body is never
 *     returned; a bounded `description_snippet` (≤256 chars) may be included for
 *     planner context. The issue URL is the pointer (§1, §8).
 *   - `buildBatchPlanCard(conversation_id, issue, tasks)` — build the multi-task
 *     review card structure for plan-first batch dispatch. The card holds pointers
 *     (title, description_pointer path) and model/effort hints (§6.7), never
 *     inline task prose.
 *
 * The orchestrator must never receive plan/diff/description bodies — only
 * pointers. Both functions enforce this at the boundary.
 *
 * Linear API access goes through @linear/sdk via server/integrations/linear/graphql.ts.
 * API errors surface as LinearApiError.
 */

import { childLogger } from '../../logger.js';
import { invokeLinear, LinearApiError } from '../../integrations/linear/graphql.js';

export { LinearApiError };

const logger = childLogger('orchestrator/mcp/seed');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum length of the description_snippet included in the summary. */
const DESCRIPTION_SNIPPET_MAX = 256;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PullLinearIssueInput {
  /** Linear issue identifier (e.g. 'SHR-123') or UUID. */
  issue_id: string;
  /** Linear API key (bare, no Bearer prefix). */
  api_key: string;
}

/**
 * Lean Linear issue summary returned by pull_linear_issue.
 *
 * Pointers-only: the `url` is the pointer to the full ticket.
 * Never includes the full description body — only an optional bounded snippet.
 */
export interface LinearIssueSummary {
  /** Linear internal UUID for the issue. */
  id: string;
  /** Human-readable identifier (e.g. 'SHR-123'). */
  identifier: string;
  /** Issue title. */
  title: string;
  /** URL pointer to the full ticket in Linear — the orchestrator holds this, not the body. */
  url: string;
  /** Current state name (e.g. 'In Progress', 'Backlog'). */
  state?: string;
  /** Priority level (0=none, 1=urgent, 2=high, 3=medium, 4=low). */
  priority?: number;
  /** Story point estimate, if set. */
  estimate?: number;
  /** Label names on this issue. */
  labels?: string[];
  /** Team key (e.g. 'SHR'). */
  team_key?: string;
  /**
   * Bounded description snippet for planner context (≤256 chars).
   * Present only when a description exists. Never the full body.
   */
  description_snippet?: string;
}

/**
 * A single sub-task item in a batch plan card.
 *
 * The description_pointer is a path reference (e.g. 'plan.json#tasks[0]'),
 * never inline prose. model/effort hints support right-sizing (§6.7).
 */
export interface SubTaskItem {
  /** Sub-task title. */
  title: string;
  /** Pointer to where the task's description lives (path#fragment). Never inline prose. */
  description_pointer: string;
  /** Suggested model for this task (e.g. 'claude-sonnet', 'claude-haiku'). */
  suggested_model?: string;
  /** Suggested effort tier for this task (e.g. 'low', 'medium', 'high'). */
  suggested_effort?: string;
}

/** An action the user can take on the batch plan card. */
export interface CardAction {
  /** Action type identifier. */
  type: 'approve_all' | 'reject' | 'edit_item';
  /** Human-readable label. */
  label: string;
}

/**
 * Multi-task review card (spec §5 #4).
 *
 * One card covers the entire batch — approve-all / edit per-item / reject.
 * Contents are pointers only; no plan prose or description bodies.
 */
export interface BatchPlanCard {
  type: 'batch_plan_card';
  conversation_id: string;
  /** Issue identifier (e.g. 'SHR-123'). */
  issue_identifier: string;
  /** Linear internal issue UUID. */
  issue_id: string;
  /** URL pointer to the Linear ticket. */
  issue_url: string;
  /** Optional bounded snippet from the issue for context (≤256 chars). */
  issue_snippet?: string;
  /** Sub-tasks to dispatch — each holds a title + pointer, never inline prose. */
  tasks: SubTaskItem[];
  /** Actions available on this card. */
  actions: CardAction[];
  /** Whether the UI should support per-item editing of the task list. */
  supports_per_item_edit: boolean;
}

// ─── handlePullLinearIssue ────────────────────────────────────────────────────

/**
 * Fetch a Linear issue and return a lean summary (pointer to the ticket).
 *
 * CRITICAL: Never returns the full description body. An optional bounded
 * `description_snippet` (≤256 chars) may appear for planner context;
 * the `url` is the authoritative pointer to the full ticket.
 *
 * LinearApiError is thrown for API failures and when the issue is not found.
 */
export async function handlePullLinearIssue(
  input: PullLinearIssueInput,
): Promise<LinearIssueSummary> {
  const { issue_id, api_key } = input;

  logger.info({ issue_id, operation: 'handlePullLinearIssue' }, 'pull_linear_issue: start');

  const issue = await invokeLinear(api_key, (client) => client.issue(issue_id));

  if (!issue) {
    throw new LinearApiError(`Linear issue not found: ${issue_id}`);
  }

  const [state, team, labelsConnection] = await Promise.all([
    issue.state ?? Promise.resolve(undefined),
    issue.team ?? Promise.resolve(undefined),
    issue.labels(),
  ]);

  const summary: LinearIssueSummary = {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
  };

  if (state?.name) {
    summary.state = state.name;
  }

  if (typeof issue.priority === 'number') {
    summary.priority = issue.priority;
  }

  if (typeof issue.estimate === 'number') {
    summary.estimate = issue.estimate;
  }

  const labelNodes = labelsConnection.nodes;
  if (labelNodes.length > 0) {
    summary.labels = labelNodes.map((l) => l.name);
  }

  if (team?.key) {
    summary.team_key = team.key;
  }

  // Bounded description snippet for planner context — truncated at DESCRIPTION_SNIPPET_MAX
  if (issue.description && issue.description.trim().length > 0) {
    const snippet = issue.description.trim().slice(0, DESCRIPTION_SNIPPET_MAX);
    summary.description_snippet = snippet;
  }

  logger.info(
    { issue_id, identifier: issue.identifier, title: issue.title },
    'pull_linear_issue: done',
  );

  return summary;
}

// ─── buildBatchPlanCard ───────────────────────────────────────────────────────

/**
 * Build a multi-task review card for plan-first batch dispatch (spec §5 #4).
 *
 * One card covers the entire batch of sub-tasks from a planning session.
 * The user can approve-all, reject, or edit per-item before dispatch.
 *
 * Pointers-only: `issue_url` is the ticket pointer; each task holds a
 * `description_pointer` (path reference), never inline prose. The full issue
 * description body is never embedded in the card.
 */
export function buildBatchPlanCard(
  conversation_id: string,
  issue: LinearIssueSummary,
  tasks: SubTaskItem[],
): BatchPlanCard {
  logger.debug(
    {
      conversation_id,
      issue_identifier: issue.identifier,
      task_count: tasks.length,
      operation: 'buildBatchPlanCard',
    },
    'buildBatchPlanCard: building card',
  );

  const card: BatchPlanCard = {
    type: 'batch_plan_card',
    conversation_id,
    issue_identifier: issue.identifier,
    issue_id: issue.id,
    issue_url: issue.url,
    tasks,
    actions: [
      { type: 'approve_all', label: 'Approve all' },
      { type: 'reject', label: 'Reject' },
    ],
    supports_per_item_edit: true,
  };

  // Include bounded snippet from the issue for context — never the full body
  if (issue.description_snippet) {
    card.issue_snippet = issue.description_snippet;
  }

  return card;
}
