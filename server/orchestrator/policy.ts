/**
 * Policy engine for the orchestrator gate.
 *
 * classify(command, args) → 'auto' | 'ask' | 'always-ask'
 *
 * Tier semantics (spec §5):
 *   auto       — MCP read tools + octomux ask-tier commands promoted by an allow-rule.
 *   ask        — Reversible write commands (create-task, add-agent, send-message, …).
 *                A learnable allow-rule can promote an ask command to auto.
 *   always-ask — Destructive commands (delete-task, close-task).
 *                No rule can ever silence an always-ask command.
 *
 * Rules are stored in the `permission_rules` SQLite table (schema in db.ts).
 * Rules can only carry effect 'allow'; 'deny' rules are stored but ignored
 * because deny is the implicit default — rules only promote, never demote.
 */

import {
  listPermissionRulesByToolName,
  listPermissionRules,
  insertPermissionRule,
  deletePermissionRule,
} from './store.js';

// ─── Tier constants ───────────────────────────────────────────────────────────

/** Commands that run inline without a card (MCP read tools). */
const AUTO_TOOLS = new Set([
  'list_tasks',
  'get_task',
  'monitor_status',
  'get_task_output',
  'pull_linear_issue',
]);

/**
 * Read-only octomux subcommands. These never mutate state — they query the
 * running server (recent repos, default branch, task listings, …). They must
 * NOT be gated: the conductor uses them to gather context (e.g. find the repo
 * path before creating a task). Auto-allowed so they run without an approval
 * card. (Fixes: `octomux recent-repos` being denied then failing because it has
 * no server-side executor — it's a read, not a write.)
 */
const READ_SUBCOMMANDS = new Set([
  'list-tasks',
  'get-task',
  'recent-repos',
  'default-branch',
  'list-skills',
  'get-skill',
  'task-summary',
  'task-updates',
  'hooks-list',
  'list-integrations',
]);

/**
 * octomux subcommands that are reversible writes.
 * A learnable allow-rule can promote these to 'auto'.
 */
const ASK_SUBCOMMANDS = new Set([
  'create-task',
  'add-agent',
  'send-message',
  'set-status',
  'request-review',
  'resume-task',
]);

/**
 * octomux subcommands that are destructive.
 * These are ALWAYS gated — no rule can silence them.
 */
const ALWAYS_ASK_SUBCOMMANDS = new Set(['delete-task', 'close-task']);

// ─── Types ────────────────────────────────────────────────────────────────────

export type PolicyDecision = 'auto' | 'ask' | 'always-ask';

export interface PermissionRule {
  id: string;
  tool_name: string;
  /** JSON-encoded match object, or null for a blanket rule. */
  match: string | null;
  effect: 'allow' | 'deny';
  created_at: string;
}

export interface AddRuleInput {
  tool_name: string;
  /**
   * Optional scope for the rule.
   * - `{ subcommand: 'create-task' }` — applies to a specific octomux subcommand.
   * - `null` — blanket rule: applies to all subcommands of this tool_name.
   */
  match: { subcommand?: string } | null;
  effect: 'allow' | 'deny';
}

// ─── classify ────────────────────────────────────────────────────────────────

/**
 * Classify a tool call as auto / ask / always-ask.
 *
 * @param command - The tool name (e.g. 'octomux', 'list_tasks', 'bash').
 * @param args    - Positional arguments. For 'octomux', args[0] is the subcommand.
 */
export function classify(command: string, args: string[]): PolicyDecision {
  // ── MCP read tools are always auto ───────────────────────────────────────
  if (AUTO_TOOLS.has(command)) {
    return 'auto';
  }

  // ── octomux CLI commands ──────────────────────────────────────────────────
  if (command === 'octomux') {
    const subcommand = args[0] ?? '';

    // Read-only commands are never gated — they only query the server.
    if (READ_SUBCOMMANDS.has(subcommand)) {
      return 'auto';
    }

    // Destructive — always-ask, cannot be overridden by rules.
    if (ALWAYS_ASK_SUBCOMMANDS.has(subcommand)) {
      return 'always-ask';
    }

    // Reversible write — check if a rule promotes it to auto.
    const baseDecision: PolicyDecision = ASK_SUBCOMMANDS.has(subcommand) ? 'ask' : 'ask';
    return applyRules(command, subcommand, baseDecision);
  }

  // ── Any other command (bash, etc.) defaults to ask ────────────────────────
  return applyRules(command, args[0] ?? '', 'ask');
}

// ─── Rule application ─────────────────────────────────────────────────────────

/**
 * Consult stored permission_rules.
 * Only 'allow' rules are acted on (deny rules are stored but ignored).
 * Returns 'auto' if a matching allow-rule exists, otherwise the baseDecision.
 */
function applyRules(
  toolName: string,
  subcommand: string,
  baseDecision: PolicyDecision,
): PolicyDecision {
  const rules = listPermissionRulesByToolName(toolName) as PermissionRule[];

  for (const rule of rules) {
    const match = rule.match ? (JSON.parse(rule.match) as { subcommand?: string }) : null;

    // Blanket rule (no match constraint) → allow everything for this tool
    if (!match) {
      return 'auto';
    }

    // Subcommand-scoped rule
    if (match.subcommand && match.subcommand === subcommand) {
      return 'auto';
    }
  }

  return baseDecision;
}

// ─── addRule ──────────────────────────────────────────────────────────────────

/**
 * Persist a new permission rule.
 * Returns the generated rule id.
 *
 * Note: 'always-ask' commands are never promoted by rules — callers should
 * not add allow-rules for delete-task / close-task, but if they do, classify()
 * still returns 'always-ask' for those commands regardless.
 */
export function addRule(input: AddRuleInput): string {
  return insertPermissionRule({
    tool_name: input.tool_name,
    match: input.match ? JSON.stringify(input.match) : null,
    effect: input.effect,
  });
}

// ─── listRules ────────────────────────────────────────────────────────────────

/** Return all stored permission rules, ordered by creation time. */
export function listRules(): PermissionRule[] {
  return listPermissionRules() as PermissionRule[];
}

// ─── deleteRule ───────────────────────────────────────────────────────────────

/** Remove a permission rule by id. No-op if the id does not exist. */
export function deleteRule(id: string): void {
  deletePermissionRule(id);
}
