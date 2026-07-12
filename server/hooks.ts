import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { broadcast } from './events.js';
import { fireHook } from './hook-dispatcher.js';
import { childLogger } from './logger.js';
import { summarizeAgentProgress } from './summarize.js';
import { handleLoopIterationBoundary } from './task-engine/loop/engine.js';
import {
  isOrchestratorManaged,
  upsertManagedTask,
  getManagedTask,
  conversationIdForHookToken,
} from './orchestrator/store.js';
import { handlePreToolUse } from './orchestrator/gate.js';
import {
  runOrchestratorAction,
  ORCHESTRATOR_ACTIONS,
  type OrchestratorAction,
} from './orchestrator/actions.js';
import {
  findAgentByHarnessSession,
  checkAgentTokenExists,
  findAgentByTokenAndExactSession,
  findAgentByTokenWithNullSession,
  findActiveAgentsByToken,
  setAgentHarnessSessionId,
  setAgentHookActivity,
  setAgentHookActivityIfNotIdle,
  countRunningAgentsExcept,
} from './repositories/agent-runtime.js';
import {
  getTaskWorkflowStatus,
  getTaskRuntimeState,
  getWorktreePathForTask,
  setWorkflowStatus,
  addTaskUpdate,
  setCurrentSummary,
} from './repositories/tasks.js';
import {
  insertPermissionPrompt,
  resolveAgentPermissionPrompts,
  resolveOldestPendingByAgent,
  countPendingByTask,
} from './repositories/permission-prompts.js';
import { inTransaction } from './repositories/tx.js';

const logger = childLogger('hooks');

const router = Router();

function findAgentBySessionId(sessionId: string) {
  return findAgentByHarnessSession(sessionId);
}

/**
 * Look up an agent by hook_token, optionally constrained to a specific
 * harness_session_id (conversation id). Used by harness-issued sessions
 * (Cursor) where the session id is captured from a hook event rather than
 * minted up front.
 *
 * 1. If conversationId is provided, try exact match on
 *    (hook_token, harness_session_id).
 * 2. If step 1 misses (or conversationId was absent), find the most-recent
 *    agent with this token and NULL harness_session_id; if conversationId is
 *    provided, bind it to that row before returning.
 * 3. Otherwise return null.
 */
export function findAgentByTokenAndSession(
  token: string,
  conversationId?: string | null,
): { id: string; task_id: string } | null {
  if (!token) return null;

  if (conversationId) {
    const exact = findAgentByTokenAndExactSession(token, conversationId);
    if (exact) return exact;
  }

  const nullSessionRow = findAgentByTokenWithNullSession(token);

  if (!nullSessionRow) return null;

  if (conversationId) {
    setAgentHarnessSessionId(nullSessionRow.id, conversationId);
  }

  return nullSessionRow;
}

const SUMMARY_FIELD_PRIORITY = [
  'command', // Bash (Claude) / run_terminal_cmd (Cursor)
  'file_path', // Read / Write / Edit / NotebookEdit (Claude) / synthesized afterFileEdit
  'target_file', // edit_file / read_file (Cursor)
  'notebook_path',
  'pattern', // Grep / Glob (Claude)
  'url', // WebFetch
  'query', // WebSearch (Claude) / grep_search (Cursor)
  'search_term', // web_search (Cursor)
  'description', // Task (Agent)
  'path',
];

const SUMMARY_MAX_LEN = 100;

export function deriveSummaryFromToolUse(toolName: unknown, toolInput: unknown): string | null {
  if (typeof toolName !== 'string' || !toolName.trim()) return null;
  const name = toolName.trim();

  let detail = '';
  if (toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)) {
    const obj = toolInput as Record<string, unknown>;
    for (const key of SUMMARY_FIELD_PRIORITY) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim()) {
        detail = v.replace(/\s+/g, ' ').trim();
        break;
      }
    }
  }

  if (!detail) return name;
  const room = SUMMARY_MAX_LEN - name.length - 2;
  if (room <= 1) return name;
  const truncated = detail.length > room ? detail.slice(0, room - 1) + '…' : detail;
  return `${name}: ${truncated}`;
}

/**
 * Express middleware: authorize a hook request by its `?token=...` query param.
 *
 * The token is the per-task secret octomux bakes into the worktree's hook
 * config; possessing it proves the request originates from a managed worktree.
 * Authorization is deliberately decoupled from *attribution*: we accept any
 * request whose token matches a known agent's `hook_token`, even when the
 * body's session id can't be mapped to a specific agent. A live Claude session
 * id routinely drifts from the one we recorded (resume / compaction / manual
 * relaunch); treating that as an auth failure produced a flood of 401s that
 * spammed the agent's terminal. Unresolvable attribution is now the handler's
 * concern (it no-ops via `resolveHookAgent`), not a 401.
 *
 * 401 only when the token is absent or matches no agent.
 */
function requireHookToken(req: Request, res: Response, next: NextFunction) {
  const provided = (req.query.token ?? '') as string;
  if (!provided) {
    logger.warn({ path: req.path, ip: req.ip }, 'hook request missing token');
    return res.status(401).send();
  }
  if (!checkAgentTokenExists(provided)) {
    // The orchestrator conductor is not an `agents` row — its gate hook token
    // lives on orchestrator_conversations. Accept it here so the PreToolUse
    // gate can authenticate the conductor's callbacks.
    if (!conversationIdForHookToken(provided)) {
      logger.warn({ path: req.path, ip: req.ip }, 'hook token not recognized');
      return res.status(401).send();
    }
  }
  next();
}

/**
 * Resolve which agent a hook should update.
 *
 * Prefers an exact, live `harness_session_id` match. When the live session id
 * has drifted from what we recorded the exact match misses; if the request's
 * token maps to exactly one non-stopped agent the sender is unambiguous, so we
 * attribute to it and rebind `harness_session_id` to the live id — subsequent
 * hooks then exact-match and dashboard telemetry resumes. Ambiguous
 * (multi-agent) tokens, or a missing session id, return undefined and the
 * caller no-ops (still HTTP 200).
 */
export function resolveHookAgent(
  token: string,
  sessionId?: string | null,
): { id: string; task_id: string } | undefined {
  if (!sessionId) return undefined;
  const exact = findAgentBySessionId(sessionId);
  if (exact) return exact;
  if (!token) return undefined;

  const live = findActiveAgentsByToken(token);
  if (live.length !== 1) return undefined;

  const only = live[0];
  setAgentHarnessSessionId(only.id, sessionId);
  logger.info(
    { agent_id: only.id, task_id: only.task_id, session_id: sessionId },
    'hook session-id drift: rebound sole agent to live session',
  );
  return only;
}

// POST /api/hooks/user-prompt-submit
// Fires when the user submits a prompt — agent resumes working
router.post('/user-prompt-submit', requireHookToken, (req, res) => {
  const { session_id, conversation_id } = req.body;
  const sid = (session_id ?? conversation_id) as string | undefined;
  if (!sid) {
    res.status(200).send();
    return;
  }

  const agent = resolveHookAgent((req.query.token ?? '') as string, sid);
  if (!agent) {
    res.status(200).send();
    return;
  }

  setAgentHookActivity(agent.id, 'active');

  // Inverse of B4: auto-transition human_review → in_progress when the user resumes the agent
  const task = getTaskWorkflowStatus(agent.task_id);

  if (task && task.workflow_status === 'human_review') {
    setWorkflowStatus(task.id, 'in_progress');
    addTaskUpdate({
      task_id: task.id,
      kind: 'transition',
      from_status: 'human_review',
      to_status: 'in_progress',
      body: 'auto: user replied',
    });

    logger.info(
      { task_id: task.id, agent_id: agent.id, operation: 'auto_in_progress' },
      'auto-transitioned to in_progress',
    );

    fireHook('workflow_status_changed', {
      event: 'workflow_status_changed',
      task: { id: task.id, workflow_status: 'in_progress' as const },
      data: { from: 'human_review', to: 'in_progress', note: 'auto: user replied' },
    });
  }

  broadcast({ type: 'task:updated', payload: { taskId: agent.task_id } });
  res.status(200).send();
});

// POST /api/hooks/permission-request
router.post('/permission-request', requireHookToken, (req, res) => {
  const { session_id, conversation_id, tool_name, tool_input } = req.body;
  const sid = (session_id ?? conversation_id) as string | undefined;
  if (!sid || !tool_name) {
    res.status(200).send();
    return;
  }

  const agent = resolveHookAgent((req.query.token ?? '') as string, sid);
  if (!agent) {
    res.status(200).send();
    return;
  }

  inTransaction(() => {
    insertPermissionPrompt({
      task_id: agent.task_id,
      agent_id: agent.id,
      session_id: sid,
      tool_name,
      tool_input: tool_input || {},
    });
    setAgentHookActivity(agent.id, 'waiting');
  });

  broadcast({ type: 'task:updated', payload: { taskId: agent.task_id } });
  res.status(200).send();
});

// POST /api/hooks/post-tool-use
router.post('/post-tool-use', requireHookToken, (req, res) => {
  const { session_id, conversation_id, tool_name, tool_input } = req.body;
  const sid = (session_id ?? conversation_id) as string | undefined;
  if (!sid) {
    res.status(200).send();
    return;
  }

  const agent = resolveHookAgent((req.query.token ?? '') as string, sid);
  if (!agent) {
    res.status(200).send();
    return;
  }

  const summary = deriveSummaryFromToolUse(tool_name, tool_input);

  inTransaction(() => {
    // Resolve oldest pending prompt (FIFO)
    resolveOldestPendingByAgent(agent.id);

    // Only set active if not already idle (Stop hook may have fired first)
    setAgentHookActivityIfNotIdle(agent.id);

    if (summary) {
      setCurrentSummary(agent.task_id, summary);
    }
  });

  broadcast({ type: 'task:updated', payload: { taskId: agent.task_id } });
  res.status(200).send();
});

// POST /api/hooks/stop
router.post(
  '/stop',
  // Subagent stops (agent_id present) are silently ignored — bypass token check.
  (req, res, next) => {
    if (req.body?.agent_id) {
      res.status(200).send();
      return;
    }
    next();
  },
  requireHookToken,
  (req, res) => {
    const { session_id, conversation_id } = req.body;
    const sid = (session_id ?? conversation_id) as string | undefined;
    if (!sid) {
      res.status(200).send();
      return;
    }

    const agent = resolveHookAgent((req.query.token ?? '') as string, sid);
    if (!agent) {
      res.status(200).send();
      return;
    }

    inTransaction(() => {
      // Resolve ALL pending prompts for this agent
      resolveAgentPermissionPrompts(agent.id);

      setAgentHookActivity(agent.id, 'idle');
    });

    // Loop harness: a looping task's Stop hook marks an iteration boundary, not
    // a normal turn end — bypass human_review/task_updates/fireHook/summarizer
    // entirely and hand off to the loop engine instead.
    if (getTaskRuntimeState(agent.task_id)?.runtime_state === 'looping') {
      void handleLoopIterationBoundary(agent.task_id, agent.id).catch((err) => {
        logger.error(
          { task_id: agent.task_id, agent_id: agent.id, operation: 'loop_iteration_boundary', err },
          'loop: iteration boundary handler failed',
        );
      });
      res.status(200).send();
      return;
    }

    // B4: Auto-transition in_progress → human_review when the last agent stops.
    // SUPPRESSED for orchestrator-managed tasks (§6.5, R3-I1): managed_tasks.phase
    // is authoritative; workflow_status is set only via set_workflow_status tool.
    const task = getTaskWorkflowStatus(agent.task_id);

    if (task && task.workflow_status === 'in_progress' && !isOrchestratorManaged(task.id)) {
      const otherRunning = countRunningAgentsExcept(agent.task_id, agent.id);
      const pendingPrompts = countPendingByTask(agent.task_id);

      if (otherRunning === 0 && pendingPrompts === 0) {
        setWorkflowStatus(task.id, 'human_review');
        addTaskUpdate({
          task_id: task.id,
          kind: 'transition',
          from_status: 'in_progress',
          to_status: 'human_review',
          body: 'auto: agent stopped',
        });

        logger.info(
          { task_id: task.id, agent_id: agent.id, operation: 'auto_human_review' },
          'auto-transitioned to human_review',
        );

        fireHook('workflow_status_changed', {
          event: 'workflow_status_changed',
          task: { id: task.id, workflow_status: 'human_review' as const },
          data: { from: 'in_progress', to: 'human_review', note: 'auto: agent stopped' },
        });
      }
    } else if (task && task.workflow_status === 'in_progress' && isOrchestratorManaged(task.id)) {
      logger.info(
        { task_id: task.id, agent_id: agent.id, operation: 'stop_suppressed_managed' },
        'Stop hook: suppressed auto-human_review for orchestrator-managed task',
      );
    }

    // Orchestrator phase-complete detection (spec §6.5). A managed task signals
    // phase-complete by writing a marker file and ending its turn — we detect it
    // here via the worker's already-authenticated Stop hook, so the worker needs
    // no extra env/command. Dispatches on managed_tasks.phase:
    //   speccing    + spec.md        → spec phase complete
    //   planning    + plan.json      → plan phase complete (awaiting_approval)
    //   implementing + .octomux/implement-done → implement done
    maybeSignalPhaseComplete(agent.task_id);

    // C3: fire-and-forget Haiku summarizer (only when builtin is enabled + API key set)
    void summarizeAgentProgress(agent.task_id, agent.id);

    broadcast({ type: 'task:updated', payload: { taskId: agent.task_id } });
    res.status(200).send();
  },
);

/**
 * Backstop: detect phase completion from marker files on the Stop hook.
 *
 * When the worker uses the explicit report_complete MCP tool, advancePhaseForLabel
 * has already run before the Stop hook fires (idempotent). When the tool is not
 * called (e.g. old workers, failures), this backstop detects the marker files and
 * calls advancePhaseForLabel — producing identical results to the explicit path.
 *
 *   phase 'speccing'     + spec.md present          → advancePhaseForLabel('spec')
 *   phase 'planning'     + plan.json present         → advancePhaseForLabel('plan')
 *   phase 'implementing' + .octomux/implement-done   → advancePhaseForLabel('implement')
 *
 * NOTE: managed_tasks.phase COLUMN values ('speccing'/'planning'/...) are
 * DISTINCT from the broadcast payload.phase LABEL ('spec'/'plan'/'implement').
 * The supervisor switches on the LABEL.
 */
function maybeSignalPhaseComplete(taskId: string): void {
  const managed = getManagedTask(taskId);
  if (!managed) return;

  const row = getWorktreePathForTask(taskId);
  const worktree = row?.worktree;
  if (!worktree) return;

  if (managed.phase === 'speccing') {
    const specPath = path.join(worktree, 'spec.md');
    if (!fs.existsSync(specPath)) return;

    logger.info(
      { task_id: taskId, operation: 'spec_complete_detected' },
      'Stop hook backstop: spec.md present for managed speccing task — advancing via advancePhaseForLabel',
    );
    advancePhaseForLabel(taskId, 'spec', ['spec.md']);
    return;
  }

  if (managed.phase === 'planning') {
    const planPath = path.join(worktree, 'plan.json');
    if (!fs.existsSync(planPath)) return;

    logger.info(
      { task_id: taskId, operation: 'plan_complete_detected' },
      'Stop hook backstop: plan.json present for managed planning task — advancing via advancePhaseForLabel',
    );
    advancePhaseForLabel(taskId, 'plan', ['plan.json']);
    return;
  }

  if (managed.phase === 'implementing') {
    const sentinelPath = path.join(worktree, '.octomux', 'implement-done');
    if (!fs.existsSync(sentinelPath)) return;

    logger.info(
      { task_id: taskId, operation: 'implement_complete_detected' },
      'Stop hook backstop: implement-done sentinel present for managed implementing task — advancing via advancePhaseForLabel',
    );
    advancePhaseForLabel(taskId, 'implement');
    return;
  }
}

/**
 * Map a phase LABEL (from the MCP tool / broadcast payload) to the managed_tasks
 * COLUMN value to advance to. This is the single source of truth for the
 * label → column mapping.
 *
 *   label 'spec'      → column 'planning'
 *   label 'plan'      → column 'awaiting_approval'
 *   label 'implement' → column 'done'
 *
 * Unknown labels are passed through unchanged (forward-compat).
 */
function phaseColumnForLabel(label: string): string {
  switch (label) {
    case 'spec':
      return 'planning';
    case 'plan':
      return 'awaiting_approval';
    case 'implement':
      return 'done';
    default:
      return label;
  }
}

/**
 * Advance a managed task's phase column based on a broadcast LABEL and emit the
 * task:phase_complete event. This is the shared transition used by both:
 *   - The explicit MCP tool (POST /api/hooks/phase-complete)
 *   - The marker-file backstop (maybeSignalPhaseComplete)
 *
 * Idempotent: if the task is already past the target phase column (or not managed),
 * this is a no-op and does NOT double-fire the broadcast.
 *
 * For 'implement', also deletes <worktree>/.octomux/implement-done if present.
 */
export function advancePhaseForLabel(taskId: string, label: string, artifacts?: unknown): void {
  const managed = getManagedTask(taskId);
  if (!managed) return;

  const targetColumn = phaseColumnForLabel(label);

  // Idempotency: only advance if we are still in the expected "current" phase
  // (the phase BEFORE the target). If we are already at or past the target, skip.
  const alreadyAdvanced = managed.phase === targetColumn;
  if (alreadyAdvanced) {
    logger.debug(
      { task_id: taskId, label, phase: managed.phase, operation: 'advancePhaseForLabel' },
      'advancePhaseForLabel: already at target phase — no-op',
    );
    return;
  }

  // Additional idempotency: for implement → done, only fire from 'implementing'.
  // For other phases the column name is already the guard.
  if (label === 'implement' && managed.phase !== 'implementing') {
    logger.debug(
      { task_id: taskId, label, phase: managed.phase, operation: 'advancePhaseForLabel' },
      'advancePhaseForLabel: not in implementing phase — skipping implement advance',
    );
    return;
  }

  // For 'spec', only fire from 'speccing'.
  if (label === 'spec' && managed.phase !== 'speccing') {
    logger.debug(
      { task_id: taskId, label, phase: managed.phase, operation: 'advancePhaseForLabel' },
      'advancePhaseForLabel: not in speccing phase — skipping spec advance',
    );
    return;
  }

  // For 'plan', only fire from 'planning'.
  if (label === 'plan' && managed.phase !== 'planning') {
    logger.debug(
      { task_id: taskId, label, phase: managed.phase, operation: 'advancePhaseForLabel' },
      'advancePhaseForLabel: not in planning phase — skipping plan advance',
    );
    return;
  }

  // Advance synchronously BEFORE broadcast so a rapid second call cannot double-fire.
  const artifactsJson = artifacts !== undefined ? JSON.stringify(artifacts) : undefined;
  upsertManagedTask({
    conversation_id: managed.conversation_id,
    task_id: taskId,
    phase: targetColumn,
    ...(artifactsJson !== undefined ? { artifacts: artifactsJson } : {}),
  });

  logger.info(
    { task_id: taskId, label, phase_column: targetColumn, operation: 'advancePhaseForLabel' },
    'advancePhaseForLabel: phase advanced',
  );

  // For implement, delete the sentinel so it never appears in the diff.
  if (label === 'implement') {
    const row = getWorktreePathForTask(taskId);
    const worktree = row?.worktree;
    if (worktree) {
      const sentinelPath = path.join(worktree, '.octomux', 'implement-done');
      try {
        fs.rmSync(sentinelPath, { force: true });
      } catch {
        // Non-fatal
      }
    }
  }

  broadcast({
    type: 'task:phase_complete',
    payload: {
      taskId,
      phase: label,
      ...(artifacts !== undefined ? { artifacts } : {}),
    },
  });
}

// POST /api/hooks/phase-complete
// Worker agents POST this at a phase boundary (§6.5, R2-F2).
// Body: { task_id, phase, artifacts? }
// Authenticated by the worker's existing per-agent hook_token.
// Persists + emits a typed task:phase_complete event and advances
// managed_tasks.phase. The phase field here is the BROADCAST LABEL ('spec',
// 'plan', 'implement') — advancePhaseForLabel maps it to the column value.
router.post('/phase-complete', requireHookToken, (req, res) => {
  const { task_id, phase, artifacts } = req.body as {
    task_id?: string;
    phase?: string;
    artifacts?: unknown;
  };

  if (!task_id || !phase) {
    logger.warn({ path: req.path }, 'phase-complete: missing task_id or phase');
    res.status(200).send();
    return;
  }

  const managed = getManagedTask(task_id);
  if (managed) {
    advancePhaseForLabel(task_id, phase, artifacts);
    logger.info(
      { task_id, phase, operation: 'phase_complete' },
      'phase-complete: advancePhaseForLabel called',
    );
  } else {
    // Not managed — still emit the event so supervisor can observe it.
    logger.info(
      { task_id, phase },
      'phase-complete: task not orchestrator-managed, emitting event only',
    );
    broadcast({
      type: 'task:phase_complete',
      payload: {
        taskId: task_id,
        phase,
        ...(artifacts !== undefined ? { artifacts } : {}),
      },
    });
  }

  res.status(200).send();
});

// POST /api/hooks/session-start
// Cursor (harness-issued) fires this on chat creation. Used to bind a
// conversation id to the agent row when harness_session_id is still NULL.
// Always responds 200 with `{}` on success (Cursor's sessionStart expects
// a JSON body), 401 on missing/invalid token.
router.post('/session-start', (req: Request, res: Response) => {
  const token = (req.query.token ?? '') as string;
  if (!token) {
    logger.warn({ path: req.path, ip: req.ip }, 'session-start: missing token');
    res.status(401).send();
    return;
  }

  const { conversation_id, session_id } = req.body ?? {};
  const resolvedId = (conversation_id ?? session_id ?? null) as string | null;

  const agent = findAgentByTokenAndSession(token, resolvedId);
  if (!agent) {
    logger.warn(
      { path: req.path, ip: req.ip, has_session: !!resolvedId },
      'session-start: no matching agent',
    );
    res.status(401).send();
    return;
  }

  broadcast({ type: 'task:updated', payload: { taskId: agent.task_id } });
  res.status(200).json({});
});

// POST /api/hooks/pre-tool-use
// Called by the orchestrator's PreToolUse HTTP hook (matcher: "Bash(octomux *)").
// Classifies the tool call via the policy engine and returns an allow/deny decision
// in the hookSpecificOutput format Claude Code expects (Phase-0 finding: §Spike 3).
//
// Body: { hook_event_name, tool_name, tool_input, ... }
// Query: ?token=<hook_token>&conversation_id=<conv_id>
//
// Response format (Phase-0 verified):
//   { hookSpecificOutput: { hookEventName: 'PreToolUse',
//                           permissionDecision: 'allow' | 'deny',
//                           permissionDecisionReason?: string } }
router.post('/pre-tool-use', requireHookToken, (req: Request, res: Response) => {
  const { tool_name, tool_input } = req.body as {
    tool_name?: string;
    tool_input?: Record<string, unknown>;
  };
  const conversationId = (req.query.conversation_id ?? '') as string | undefined;
  // Generate a synthetic tool_use_id when the hook payload doesn't carry one
  const toolUseId = (req.body.tool_use_id as string | undefined) ?? nanoid(12);

  if (!tool_name) {
    // No tool_name → can't classify; fail open
    res.status(200).json({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    });
    return;
  }

  handlePreToolUse({
    conversation_id: conversationId || undefined,
    tool_name,
    tool_input: tool_input ?? {},
    tool_use_id: toolUseId,
  })
    .then((result) => {
      if (result.decision === 'allow') {
        res.status(200).json({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
          },
        });
      } else {
        res.status(200).json({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              result.reason ?? `queued for approval — card ${result.card_id ?? 'unknown'}`,
          },
        });
      }
    })
    .catch((err: unknown) => {
      logger.error({ err, path: req.path }, 'pre-tool-use: unexpected error — failing open');
      // Fail open on unexpected errors so the orchestrator isn't permanently blocked
      res.status(200).json({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
        },
      });
    });
});

// POST /api/hooks/orchestrator-action
// The conductor's MCP write tools (mcp__octomux__create_task, …) RPC here to
// perform a write action with STRUCTURED args (no Bash, no gate) — SHR-142.
// Query: ?token=<conductor hook_token>&conversation_id=<conv_id>
// Body:  { action: 'create-task'|'send-message'|…, input: {…structured…} }
// Runs in the main process so the task lifecycle + supervisor relay stay here.
router.post('/orchestrator-action', requireHookToken, (req: Request, res: Response) => {
  const conversationId = ((req.query.conversation_id ?? '') as string) || undefined;
  const idempotencyKey = ((req.query.idempotency_key ?? '') as string) || undefined;
  const { action, input } = req.body as {
    action?: string;
    input?: Record<string, unknown>;
  };

  if (!action || !ORCHESTRATOR_ACTIONS.has(action)) {
    res.status(400).json({ error: `unknown or missing action: ${action ?? '(none)'}` });
    return;
  }

  runOrchestratorAction(conversationId, action as OrchestratorAction, input ?? {}, idempotencyKey)
    .then((result) => {
      res.status(200).json({ ok: true, result });
    })
    .catch((err: unknown) => {
      const message = (err as Error).message ?? String(err);
      logger.error({ err, action, conversation_id: conversationId }, 'orchestrator-action failed');
      res.status(200).json({ ok: false, error: message });
    });
});

export { router as hookRoutes };
