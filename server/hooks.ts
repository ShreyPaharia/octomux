import { Router } from 'express';
import { nanoid } from 'nanoid';
import { getDb } from './db.js';
import { broadcast } from './events.js';
import { fireHook } from './hook-dispatcher.js';
import { childLogger } from './logger.js';

const hooksLogger = childLogger('hooks');

const router = Router();

function findAgentBySessionId(sessionId: string) {
  return getDb()
    .prepare(
      `SELECT a.id, a.task_id FROM agents a
       WHERE a.claude_session_id = ? AND a.status != 'stopped'
       LIMIT 1`,
    )
    .get(sessionId) as { id: string; task_id: string } | undefined;
}

const SUMMARY_FIELD_PRIORITY = [
  'command', // Bash
  'file_path', // Read / Write / Edit / NotebookEdit
  'notebook_path',
  'pattern', // Grep / Glob
  'url', // WebFetch
  'query', // WebSearch
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

// POST /api/hooks/user-prompt-submit
// Fires when the user submits a prompt — agent resumes working
router.post('/user-prompt-submit', (req, res) => {
  const { session_id } = req.body;
  if (!session_id) {
    res.status(200).send();
    return;
  }

  const agent = findAgentBySessionId(session_id);
  if (!agent) {
    res.status(200).send();
    return;
  }

  getDb()
    .prepare(
      `UPDATE agents SET hook_activity = 'active', hook_activity_updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(agent.id);

  broadcast({ type: 'task:updated', payload: { taskId: agent.task_id } });
  res.status(200).send();
});

// POST /api/hooks/permission-request
router.post('/permission-request', (req, res) => {
  const { session_id, tool_name, tool_input } = req.body;
  if (!session_id || !tool_name) {
    res.status(200).send();
    return;
  }

  const agent = findAgentBySessionId(session_id);
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
      .run(
        nanoid(12),
        agent.task_id,
        agent.id,
        session_id,
        tool_name,
        JSON.stringify(tool_input || {}),
      );

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
router.post('/post-tool-use', (req, res) => {
  const { session_id, tool_name, tool_input } = req.body;
  if (!session_id) {
    res.status(200).send();
    return;
  }

  const agent = findAgentBySessionId(session_id);
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
router.post('/stop', (req, res) => {
  const { session_id, agent_id: subagentId } = req.body;
  if (!session_id) {
    res.status(200).send();
    return;
  }

  // Ignore subagent stops — agent_id is only present when a Claude Code
  // subagent (spawned via the Agent tool) finishes, not the main session.
  if (subagentId) {
    res.status(200).send();
    return;
  }

  const agent = findAgentBySessionId(session_id);
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

  // B4: Auto-transition in_progress → human_review when the last agent stops
  const db = getDb();
  const task = db
    .prepare(`SELECT id, workflow_status FROM tasks WHERE id = ?`)
    .get(agent.task_id) as { id: string; workflow_status: string } | undefined;

  if (task && task.workflow_status === 'in_progress') {
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

      hooksLogger.info(
        { task_id: task.id, agent_id: agent.id, operation: 'auto_human_review' },
        'auto-transitioned to human_review',
      );

      fireHook('workflow_status_changed', {
        event: 'workflow_status_changed',
        task: { id: task.id, workflow_status: 'human_review' as const },
        data: { from: 'in_progress', to: 'human_review', note: 'auto: agent stopped' },
      });
    }
  }

  broadcast({ type: 'task:updated', payload: { taskId: agent.task_id } });
  res.status(200).send();
});

export { router as hookRoutes };
