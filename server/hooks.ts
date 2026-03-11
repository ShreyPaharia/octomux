import { Router } from 'express';
import { nanoid } from 'nanoid';
import { getDb } from './db.js';
import { broadcast } from './events.js';

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
  });
  txn();

  broadcast({ type: 'task:updated', payload: { taskId: agent.task_id } });
  res.status(200).send();
});

// POST /api/hooks/stop
router.post('/stop', (req, res) => {
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

  broadcast({ type: 'task:updated', payload: { taskId: agent.task_id } });
  res.status(200).send();
});

export { router as hookRoutes };
