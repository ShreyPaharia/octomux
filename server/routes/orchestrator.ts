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

const apiLogger = childLogger('api');

export const router = express.Router();

// POST /api/orchestrator/conversations — create a new orchestrator conversation
router.post('/api/orchestrator/conversations', async (req: Request, res: Response) => {
  const { title, cwd } = req.body as { title?: string; cwd?: string };
  if (!title?.trim()) {
    res.status(400).json({ error: 'title is required' });
    return;
  }
  try {
    const id = createConversation({ title: title.trim() });
    // The conductor runs in a trusted cwd (default: the server's repo root).
    const convCwd = cwd?.trim() || process.cwd();
    // Launch the interactive claude session for this conversation (tmux + transcript).
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
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/orchestrator/conversations — list all conversations
router.get('/api/orchestrator/conversations', (_req: Request, res: Response) => {
  try {
    res.json(listConversations());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/orchestrator/conversations/:id — get a single conversation
router.get('/api/orchestrator/conversations/:id', (req: Request, res: Response) => {
  try {
    const conv = getConversation((req.params as Record<string, string>).id);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json(conv);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/orchestrator/conversations/:id/messages — list messages for a conversation
router.get('/api/orchestrator/conversations/:id/messages', (req: Request, res: Response) => {
  try {
    const convId = (req.params as Record<string, string>).id;
    const conv = getConversation(convId);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    res.json(listOrchestratorMessages(convId));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/orchestrator/conversations/:id/global-monitor — toggle global-monitor mode
// Exactly one conversation may be in global-monitor mode at a time.
// If the conversation is already the global monitor, clears it.
// Otherwise, designates it as the global monitor (clearing the previous one).
router.post('/api/orchestrator/conversations/:id/global-monitor', (req: Request, res: Response) => {
  try {
    const convId = (req.params as Record<string, string>).id;
    const conv = getConversation(convId);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    // Toggle: if already global-monitor, clear; otherwise set
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
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/orchestrator/conversations/:id/usage — conductor-leanness stats (§6.7)
// Returns tasks_spawned, tool_calls, started_at, last_activity_at.
// Returns zeros when no usage row exists yet (conversation was created but no
// write-actions have been dispatched).
router.get('/api/orchestrator/conversations/:id/usage', (req: Request, res: Response) => {
  try {
    const convId = (req.params as Record<string, string>).id;
    const conv = getConversation(convId);
    if (!conv) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    const usage = getConversationUsage(convId);
    if (!usage) {
      // No usage row yet — return zeros so the UI always gets a valid shape.
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
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
