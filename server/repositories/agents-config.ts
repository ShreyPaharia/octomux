/**
 * Repository layer for the `agent_configs` table — long-running "Agents
 * feature" config rows (name, system prompt, channel binding). Not to be
 * confused with the `agents` table (per-task tmux-window workers).
 * Plain exported functions — no base class, no ORM.
 */
import { nanoid } from 'nanoid';
import { getDb } from '../db.js';
import { childLogger } from '../logger.js';

const logger = childLogger('repositories/agents-config');

export interface AgentConfig {
  id: string;
  name: string;
  system_prompt: string;
  channel: string | null;
  channel_config: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateAgentInput {
  name: string;
  system_prompt: string;
  channel?: string | null;
  channel_config?: string | null;
}

const AGENT_CONFIG_COLUMNS =
  'id, name, system_prompt, channel, channel_config, created_at, updated_at';

/** Create an agent config row. Returns the new agent's id. */
export function createAgent(input: CreateAgentInput): string {
  const id = nanoid(12);
  getDb()
    .prepare(
      `INSERT INTO agent_configs (id, name, system_prompt, channel, channel_config)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, input.name, input.system_prompt, input.channel ?? null, input.channel_config ?? null);

  logger.info({ agent_id: id, name: input.name }, 'agent config created');
  return id;
}

/** Fetch a single agent config by id (returns undefined if not found). */
export function getAgent(id: string): AgentConfig | undefined {
  return getDb()
    .prepare(`SELECT ${AGENT_CONFIG_COLUMNS} FROM agent_configs WHERE id = ?`)
    .get(id) as AgentConfig | undefined;
}

/** All agent configs, newest first. */
export function listAgents(): AgentConfig[] {
  return getDb()
    .prepare(`SELECT ${AGENT_CONFIG_COLUMNS} FROM agent_configs ORDER BY created_at DESC`)
    .all() as AgentConfig[];
}

export type UpdateAgentInput = Partial<
  Pick<AgentConfig, 'name' | 'system_prompt' | 'channel' | 'channel_config'>
>;

/** Partially update an agent config's name/system_prompt/channel binding. Bumps updated_at. */
export function updateAgent(id: string, patch: UpdateAgentInput): void {
  const existing = getAgent(id);
  if (!existing) return;

  const name = patch.name ?? existing.name;
  const systemPrompt = patch.system_prompt ?? existing.system_prompt;
  const channel = patch.channel !== undefined ? patch.channel : existing.channel;
  const channelConfig =
    patch.channel_config !== undefined ? patch.channel_config : existing.channel_config;

  getDb()
    .prepare(
      `UPDATE agent_configs
       SET name = ?, system_prompt = ?, channel = ?, channel_config = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .run(name, systemPrompt, channel, channelConfig, id);

  logger.info({ agent_id: id }, 'agent config updated');
}

/** Delete an agent config by id. No-op if it doesn't exist. */
export function deleteAgent(id: string): void {
  getDb().prepare(`DELETE FROM agent_configs WHERE id = ?`).run(id);
  logger.info({ agent_id: id }, 'agent config deleted');
}

/**
 * Find the agent bound to an inbound (channel, threadKey), if any.
 *
 * `channel_config` is a JSON blob shaped `{ threadKey?: string }`. An agent
 * bound with no `threadKey` matches ANY thread on that channel (channel-wide
 * binding); an agent bound with a specific `threadKey` matches only that
 * thread. A specific-thread match wins over a channel-wide one. The config
 * table is small (a handful of agents) so filtering in JS after one indexed
 * lookup is simpler than JSON1 SQL predicates.
 */
export function getAgentByChannel(channel: string, threadKey: string): AgentConfig | undefined {
  const candidates = getDb()
    .prepare(`SELECT ${AGENT_CONFIG_COLUMNS} FROM agent_configs WHERE channel = ?`)
    .all(channel) as AgentConfig[];

  let channelWide: AgentConfig | undefined;
  for (const agent of candidates) {
    const config = agent.channel_config
      ? (JSON.parse(agent.channel_config) as { threadKey?: string })
      : {};
    if (config.threadKey === threadKey) return agent;
    if (!config.threadKey && !channelWide) channelWide = agent;
  }
  return channelWide;
}
