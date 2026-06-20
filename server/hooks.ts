import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { nanoid } from 'nanoid';
import { getDb } from './db.js';
import { broadcast } from './events.js';
import { fireHook } from './hook-dispatcher.js';
import { childLogger } from './logger.js';
import { summarizeAgentProgress } from './summarize.js';
import { isOrchestratorManaged, upsertManagedTask, getManagedTask } from './orchestrator/store.js';
import { handlePreToolUse } from './orchestrator/gate.js';

const logger = childLogger('hooks');

const router = Router();

function findAgentBySessionId(sessionId: string) {
  return getDb()
    .prepare(
      `SELECT a.id, a.task_id FROM agents a
       WHERE a.harness_session_id = ? AND a.status != 'stopped'
       LIMIT 1`,
    )
    .get(sessionId) as { id: string; task_id: string } | undefined;
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
  const db = getDb();

  if (conversationId) {
    const exact = db
      .prepare(
        `SELECT id, task_id FROM agents
         WHERE hook_token = ? AND harness_session_id = ?
         LIMIT 1`,
      )
      .get(token, conversationId) as { id: string; task_id: string } | undefined;
    if (exact) return exact;
  }

  const nullSessionRow = db
    .prepare(
      `SELECT id, task_id FROM agents
       WHERE hook_token = ? AND harness_session_id IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(token) as { id: string; task_id: string } | undefined;

  if (!nullSessionRow) return null;

  if (conversationId) {
    db.prepare(`UPDATE agents SET harness_session_id = ? WHERE id = ?`).run(
      conversationId,
      nullSessionRow.id,
    );
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
  const row = getDb()
    .prepare(`SELECT 1 AS ok FROM agents WHERE hook_token = ? AND hook_token != '' LIMIT 1`)
    .get(provided) as { ok: number } | undefined;
  if (!row) {
    logger.warn({ path: req.path, ip: req.ip }, 'hook token not recognized');
    return res.status(401).send();
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

  const live = getDb()
    .prepare(
      `SELECT id, task_id FROM agents
       WHERE hook_token = ? AND hook_token != '' AND status != 'stopped'`,
    )
    .all(token) as { id: string; task_id: string }[];
  if (live.length !== 1) return undefined;

  const only = live[0];
  getDb().prepare(`UPDATE agents SET harness_session_id = ? WHERE id = ?`).run(sessionId, only.id);
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

  const db = getDb();

  db.prepare(
    `UPDATE agents SET hook_activity = 'active', hook_activity_updated_at = datetime('now')
       WHERE id = ?`,
  ).run(agent.id);

  // Inverse of B4: auto-transition human_review → in_progress when the user resumes the agent
  const task = db
    .prepare(`SELECT id, workflow_status FROM tasks WHERE id = ?`)
    .get(agent.task_id) as { id: string; workflow_status: string } | undefined;

  if (task && task.workflow_status === 'human_review') {
    const updateId = nanoid(12);
    db.prepare(
      `UPDATE tasks SET workflow_status = 'in_progress', updated_at = datetime('now') WHERE id = ?`,
    ).run(task.id);
    db.prepare(
      `INSERT INTO task_updates (id, task_id, kind, from_status, to_status, body) VALUES (?, ?, 'transition', 'human_review', 'in_progress', ?)`,
    ).run(updateId, task.id, 'auto: user replied');

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

  const txn = getDb().transaction(() => {
    getDb()
      .prepare(
        `INSERT INTO permission_prompts (id, task_id, agent_id, session_id, tool_name, tool_input, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`,
      )
      .run(nanoid(12), agent.task_id, agent.id, sid, tool_name, JSON.stringify(tool_input || {}));

    getDb()
      .prepare(
        `UPDATE agents SET hook_activity = 'waiting', hook_activity_updated_at = datetime('now')
           WHERE id = ?`,
      )
      .run(agent.id);
  });
  txn();

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

  const txn = getDb().transaction(() => {
    // Resolve oldest pending prompt (FIFO)
    getDb()
      .prepare(
        `UPDATE permission_prompts SET status = 'resolved', resolved_at = datetime('now')
           WHERE id = (
             SELECT id FROM permission_prompts
             WHERE agent_id = ? AND status = 'pending'
             ORDER BY created_at ASC LIMIT 1
           )`,
      )
      .run(agent.id);

    // Only set active if not already idle (Stop hook may have fired first)
    getDb()
      .prepare(
        `UPDATE agents SET hook_activity = 'active', hook_activity_updated_at = datetime('now')
           WHERE id = ? AND hook_activity != 'idle'`,
      )
      .run(agent.id);

    if (summary) {
      getDb()
        .prepare(
          `UPDATE tasks SET current_summary = ?, current_summary_updated_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ?`,
        )
        .run(summary, agent.task_id);
    }
  });
  txn();

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

    const txn = getDb().transaction(() => {
      // Resolve ALL pending prompts for this agent
      getDb()
        .prepare(
          `UPDATE permission_prompts SET status = 'resolved', resolved_at = datetime('now')
           WHERE agent_id = ? AND status = 'pending'`,
        )
        .run(agent.id);

      getDb()
        .prepare(
          `UPDATE agents SET hook_activity = 'idle', hook_activity_updated_at = datetime('now')
           WHERE id = ?`,
        )
        .run(agent.id);
    });
    txn();

    // B4: Auto-transition in_progress → human_review when the last agent stops.
    // SUPPRESSED for orchestrator-managed tasks (§6.5, R3-I1): managed_tasks.phase
    // is authoritative; workflow_status is set only via set_workflow_status tool.
    const db = getDb();
    const task = db
      .prepare(`SELECT id, workflow_status FROM tasks WHERE id = ?`)
      .get(agent.task_id) as { id: string; workflow_status: string } | undefined;

    if (task && task.workflow_status === 'in_progress' && !isOrchestratorManaged(task.id)) {
      const otherRunning = db
        .prepare(
          `SELECT COUNT(*) AS n FROM agents WHERE task_id = ? AND status = 'running' AND id != ?`,
        )
        .get(agent.task_id, agent.id) as { n: number };

      const pendingPrompts = db
        .prepare(
          `SELECT COUNT(*) AS n FROM permission_prompts WHERE task_id = ? AND status = 'pending'`,
        )
        .get(agent.task_id) as { n: number };

      if (otherRunning.n === 0 && pendingPrompts.n === 0) {
        const updateId = nanoid(12);
        db.prepare(
          `UPDATE tasks SET workflow_status = 'human_review', updated_at = datetime('now') WHERE id = ?`,
        ).run(task.id);
        db.prepare(
          `INSERT INTO task_updates (id, task_id, kind, from_status, to_status, body) VALUES (?, ?, 'transition', 'in_progress', 'human_review', ?)`,
        ).run(updateId, task.id, 'auto: agent stopped');

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

    // C3: fire-and-forget Haiku summarizer (only when builtin is enabled + API key set)
    void summarizeAgentProgress(agent.task_id, agent.id);

    broadcast({ type: 'task:updated', payload: { taskId: agent.task_id } });
    res.status(200).send();
  },
);

// POST /api/hooks/phase-complete
// Worker agents POST this at a phase boundary (§6.5, R2-F2).
// Body: { task_id, phase, artifacts? }
// Authenticated by the worker's existing per-agent hook_token.
// Persists + emits a typed task:phase_complete event and advances
// managed_tasks.phase. Suppresses the Stop auto-human_review for managed tasks.
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

  // Only advance phase if this task is orchestrator-managed.
  const managed = getManagedTask(task_id);
  if (managed) {
    const artifactsJson = artifacts !== undefined ? JSON.stringify(artifacts) : null;
    upsertManagedTask({
      conversation_id: managed.conversation_id,
      task_id,
      phase,
      ...(artifactsJson !== null ? { artifacts: artifactsJson } : {}),
    });

    logger.info(
      { task_id, phase, operation: 'phase_complete' },
      'phase-complete: advanced managed_tasks.phase',
    );
  } else {
    logger.info(
      { task_id, phase },
      'phase-complete: task not orchestrator-managed, no-op on phase',
    );
  }

  // Always emit the typed event and broadcast (so supervisor can observe it
  // whether or not the task is managed).
  broadcast({
    type: 'task:phase_complete',
    payload: {
      taskId: task_id,
      phase,
      ...(artifacts !== undefined ? { artifacts } : {}),
    },
  });

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

export { router as hookRoutes };
