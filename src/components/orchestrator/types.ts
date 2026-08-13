import type { ThreadMessage } from './MessageThread';
import type { ActionCardDecision } from './ActionCard';

/** A plan-approval card that appears inline in the message thread. */
export interface PlanCardItem {
  kind: 'plan-card';
  id: string;
  taskId: string;
  planPath: string;
  artifactUrl: string;
  /** resolved once the user decides; removes the card from the thread */
  resolved: boolean;
}

/**
 * A read-only spec card for the workflow kind (SHR-143).
 * Rendered by SpecCard; no ws decision event — local dismiss only.
 */
export interface SpecCardItem {
  kind: 'spec-card';
  id: string;
  taskId: string;
  specPath: string;
  artifactUrl: string;
  /** true when the user has locally dismissed the card */
  resolved: boolean;
}

/**
 * An action card for a gated write-command (Task 3.3 / SHR-132).
 * Rendered by ActionCard; user can Approve/Edit/Reject/Respond.
 */
export interface ActionCardItem {
  kind: 'action-card';
  id: string;
  command: string;
  args: Record<string, unknown>;
  /** true when the command is in the always-ask (destructive) tier */
  alwaysAsk?: boolean;
  /** resolved once the user decides; removes the card from the thread */
  resolved: boolean;
}

/**
 * A conductor tool-call, rendered as a collapsible card distinct from prose
 * (SHR-161). Live/ephemeral — pushed from the transcript tail, not persisted.
 */
export interface ToolCallItem {
  kind: 'tool-call';
  id: string;
  toolName: string;
  input: unknown;
}

/**
 * A question card for the `ask_human` capability — the agent is blocked
 * waiting for a free-text answer, not a write to approve/reject. Rendered by
 * QuestionCard; sibling to ActionCard rather than a variant of it (no arg
 * fields, no always-allow toggle — always-ask is never promotable).
 */
export interface QuestionCardItem {
  kind: 'question-card';
  id: string;
  question: string;
  /** resolved once the user answers or rejects; removes the card from the thread */
  resolved: boolean;
}

/** A union of everything that can appear in the thread. */
export type ThreadItem =
  | ThreadMessage
  | PlanCardItem
  | SpecCardItem
  | ActionCardItem
  | QuestionCardItem
  | ToolCallItem;

export const ORCHESTRATOR_FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3B82F6]';

export const ORCHESTRATOR_SIDEBAR_WIDTH = 240;

export type { ActionCardDecision };
