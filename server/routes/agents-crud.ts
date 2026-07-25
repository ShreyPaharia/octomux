/**
 * `/api/agents` — CRUD for the `agents` table (persistent conductor agents),
 * plus derived live status and the endpoint that ensures/opens an agent's
 * persistent conductor session.
 *
 * The three-way "agent" naming collision this used to route around is gone:
 * the per-task tmux worker now lives at `/api/workers` (`routes/task-agents.ts`,
 * `routes/chats.ts`), and agent *role* definitions (orchestrator/planner/
 * reviewer) live at `/api/agent-roles` (`routes/agent-defs.ts`).
 */
import express from 'express';
import type { Request, Response } from 'express';
import {
  createAgent,
  getAgent,
  listAgents,
  updateAgent,
  deleteAgent,
  type AgentConfig,
  type UpdateAgentInput,
} from '../repositories/agents.js';
import { createConversation, getPrimaryAgentConversation } from '../repositories/orchestrator.js';
import {
  startConversation,
  stopConversation,
  isConversationSessionAlive,
} from '../orchestrator/runner.js';
import { badRequest, notFound } from '../services/errors.js';
import { childLogger } from '../logger.js';

const logger = childLogger('routes/agents-crud');

export const router = express.Router();

export type AgentStatus = 'stopped' | 'idle' | 'working';

export interface AgentWithStatus extends AgentConfig {
  status: AgentStatus;
  session_id: string | null;
}

/**
 * Derive an agent's live status from its primary conversation.
 *
 * No conversation, or its tmux session is gone → 'stopped'. Session alive →
 * 'idle' (v1 does not attempt to detect "actively generating" — that needs a
 * pane-content heuristic that isn't cheap/reliable enough yet; 'working' is
 * reserved for a later pass). Never throws: a tmux probe failure is treated as
 * 'stopped' so `GET /api/agents` can't be taken down by a flaky tmux call.
 */
export async function deriveAgentStatus(
  agentId: string,
): Promise<{ status: AgentStatus; session_id: string | null }> {
  const conv = getPrimaryAgentConversation(agentId);
  if (!conv) return { status: 'stopped', session_id: null };

  let alive = false;
  try {
    alive = await isConversationSessionAlive(conv);
  } catch (err) {
    logger.warn(
      { agent_id: agentId, conversation_id: conv.id, err },
      'agents: liveness probe failed',
    );
    alive = false;
  }
  return { status: alive ? 'idle' : 'stopped', session_id: conv.id };
}

async function withStatus(agent: AgentConfig): Promise<AgentWithStatus> {
  const { status, session_id } = await deriveAgentStatus(agent.id);
  return { ...agent, status, session_id };
}

/** JSON-stringify an incoming channel_config value that may already be a JSON string, an object, or absent. */
function normalizeChannelConfig(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

// GET /api/agents — list all agents with derived status + session_id
router.get('/api/agents', async (_req: Request, res: Response) => {
  const agents = listAgents();
  res.json(await Promise.all(agents.map(withStatus)));
});

// POST /api/agents — create an agent config
router.post('/api/agents', async (req: Request, res: Response) => {
  const body = req.body as {
    name?: unknown;
    system_prompt?: unknown;
    channel?: unknown;
    channel_config?: unknown;
  };

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw badRequest('name is required');

  const systemPrompt = typeof body.system_prompt === 'string' ? body.system_prompt.trim() : '';
  if (!systemPrompt) throw badRequest('system_prompt is required');

  const channel = typeof body.channel === 'string' ? body.channel : null;
  const channelConfig = normalizeChannelConfig(body.channel_config);

  const id = createAgent({
    name,
    system_prompt: systemPrompt,
    channel,
    channel_config: channelConfig,
  });
  logger.info({ agent_id: id, name }, 'agents: created');

  res.status(201).json(await withStatus(getAgent(id)!));
});

// GET /api/agents/:id — a single agent with derived status + session_id
router.get('/api/agents/:id', async (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  const agent = getAgent(id);
  if (!agent) throw notFound('Agent not found');
  res.json(await withStatus(agent));
});

// PATCH /api/agents/:id — update name/system_prompt/channel/channel_config
router.patch('/api/agents/:id', async (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  const agent = getAgent(id);
  if (!agent) throw notFound('Agent not found');

  const body = req.body as {
    name?: unknown;
    system_prompt?: unknown;
    channel?: unknown;
    channel_config?: unknown;
  };
  const patch: UpdateAgentInput = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw badRequest('name must be a non-empty string');
    }
    patch.name = body.name.trim();
  }
  if (body.system_prompt !== undefined) {
    if (typeof body.system_prompt !== 'string' || !body.system_prompt.trim()) {
      throw badRequest('system_prompt must be a non-empty string');
    }
    patch.system_prompt = body.system_prompt.trim();
  }
  if (body.channel !== undefined) {
    patch.channel = body.channel === null ? null : String(body.channel);
  }
  if (body.channel_config !== undefined) {
    patch.channel_config = normalizeChannelConfig(body.channel_config);
  }

  updateAgent(id, patch);
  logger.info({ agent_id: id }, 'agents: updated');

  res.json(await withStatus(getAgent(id)!));
});

// DELETE /api/agents/:id — delete the agent, stopping its session first
router.delete('/api/agents/:id', async (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  const agent = getAgent(id);
  if (!agent) throw notFound('Agent not found');

  const conv = getPrimaryAgentConversation(id);
  if (conv) {
    await stopConversation(conv.id);
  }
  deleteAgent(id);
  logger.info({ agent_id: id, had_session: !!conv }, 'agents: deleted');

  res.status(204).end();
});

// POST /api/agents/:id/session — ensure + return the agent's persistent conversation
router.post('/api/agents/:id/session', async (req: Request, res: Response) => {
  const { id } = req.params as Record<string, string>;
  const agent = getAgent(id);
  if (!agent) throw notFound('Agent not found');

  let conv = getPrimaryAgentConversation(id);
  if (!conv) {
    const convId = createConversation({ title: agent.name, agent_id: id });
    const cwd = process.env.OCTOMUX_GATEWAY_CWD || process.cwd();
    await startConversation(convId, cwd, { systemPrompt: agent.system_prompt });
    conv = getPrimaryAgentConversation(id);
    logger.info({ agent_id: id, conversation_id: convId }, 'agents: session started');
  }

  res.status(200).json(conv);
});
