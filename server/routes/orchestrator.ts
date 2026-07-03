import express from 'express';
import type { Request, Response } from 'express';
import {
  createConversation,
  getConversation,
  listConversations,
  listMessages as listOrchestratorMessages,
  setGlobalMonitor,
  clearGlobalMonitor,
  getGlobalMonitorConversation,
  getConversationUsage,
} from '../orchestrator/store.js';
import { startConversation } from '../orchestrator/runner.js';
import { childLogger } from '../logger.js';
import { badRequest, notFound } from '../services/errors.js';

const apiLogger = childLogger('api');

export const router = express.Router();

// POST /api/orchestrator/conversations — create a new orchestrator conversation
router.post('/api/orchestrator/conversations', async (req: Request, res: Response) => {
  const { title, cwd } = req.body as { title?: string; cwd?: string };
  if (!title?.trim()) {
    throw badRequest('title is required');
  }
  try {
    const id = createConversation({ title: title.trim() });
    const convCwd = cwd?.trim() || process.cwd();
    await startConversation(id, convCwd);
    apiLogger.info(
      { conversation_id: id, operation: 'createConversation', cwd: convCwd },
      'orchestrator conversation created + session launched',
    );
    const conv = getConversation(id);
    res.status(201).json(conv);
  } catch (err) {
    apiLogger.error(
      { err, operation: 'createConversation' },
      'failed to create orchestrator conversation',
    );
    throw err;
  }
});

// GET /api/orchestrator/conversations — list all conversations
router.get('/api/orchestrator/conversations', (_req: Request, res: Response) => {
  res.json(listConversations());
});

// GET /api/orchestrator/conversations/:id — get a single conversation
router.get('/api/orchestrator/conversations/:id', (req: Request, res: Response) => {
  const conv = getConversation((req.params as Record<string, string>).id);
  if (!conv) {
    throw notFound('Conversation not found');
  }
  res.json(conv);
});

// GET /api/orchestrator/conversations/:id/messages — list messages for a conversation
router.get('/api/orchestrator/conversations/:id/messages', (req: Request, res: Response) => {
  const convId = (req.params as Record<string, string>).id;
  const conv = getConversation(convId);
  if (!conv) {
    throw notFound('Conversation not found');
  }
  res.json(listOrchestratorMessages(convId));
});

// POST /api/orchestrator/conversations/:id/global-monitor — toggle global-monitor mode
router.post('/api/orchestrator/conversations/:id/global-monitor', (req: Request, res: Response) => {
  const convId = (req.params as Record<string, string>).id;
  const conv = getConversation(convId);
  if (!conv) {
    throw notFound('Conversation not found');
  }
  const currentMonitor = getGlobalMonitorConversation();
  let isMonitor: boolean;
  if (currentMonitor === convId) {
    clearGlobalMonitor();
    isMonitor = false;
  } else {
    setGlobalMonitor(convId);
    isMonitor = true;
  }
  apiLogger.info(
    { conversation_id: convId, is_global_monitor: isMonitor },
    'orchestrator: global-monitor toggled',
  );
  res.json({ is_global_monitor: isMonitor });
});

// GET /api/orchestrator/conversations/:id/usage — conductor-leanness stats (§6.7)
router.get('/api/orchestrator/conversations/:id/usage', (req: Request, res: Response) => {
  const convId = (req.params as Record<string, string>).id;
  const conv = getConversation(convId);
  if (!conv) {
    throw notFound('Conversation not found');
  }
  const usage = getConversationUsage(convId);
  if (!usage) {
    res.json({
      conversation_id: convId,
      tasks_spawned: 0,
      tool_calls: 0,
      started_at: conv.created_at,
      last_activity_at: conv.updated_at,
    });
    return;
  }
  res.json(usage);
});
