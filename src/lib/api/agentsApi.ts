/**
 * src/lib/api/agentsApi.ts
 *
 * Agents-feature API surface: CRUD for long-running agent configs plus the
 * derived live status and the endpoint that ensures/opens an agent's
 * persistent conductor session. Mirrors `server/routes/agents-crud.ts`.
 *
 * NAMING: the REST base is `/api/agent-configs`, not `/api/agents` — that path
 * is already taken by agent *role* definitions (`routes/agent-defs.ts`) and the
 * per-task tmux-window worker hop (`routes/chats.ts`). See
 * `plans/2026-07-24-agents-feature.md` ("Naming correction").
 */

import type { OrchestratorConversation } from '../orchestrator-api';
import { request } from './client';

export interface AgentConfig {
  id: string;
  name: string;
  system_prompt: string;
  channel: string | null;
  channel_config: string | null;
  created_at: string;
  updated_at: string;
}

export type AgentStatus = 'stopped' | 'idle' | 'working';

export interface AgentWithStatus extends AgentConfig {
  status: AgentStatus;
  session_id: string | null;
}

export interface CreateAgentInput {
  name: string;
  system_prompt: string;
  channel?: string | null;
  channel_config?: string | null;
}

export interface UpdateAgentInput {
  name?: string;
  system_prompt?: string;
  channel?: string | null;
  channel_config?: string | null;
}

/** The agent's persistent conductor session, tagged with the owning agent_id. */
export interface AgentSession extends OrchestratorConversation {
  agent_id: string | null;
}

export const agentsApi = {
  list: () => request<AgentWithStatus[]>('/agent-configs'),
  create: (data: CreateAgentInput) =>
    request<AgentWithStatus>('/agent-configs', { method: 'POST', body: JSON.stringify(data) }),
  get: (id: string) => request<AgentWithStatus>(`/agent-configs/${id}`),
  update: (id: string, data: UpdateAgentInput) =>
    request<AgentWithStatus>(`/agent-configs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  remove: (id: string) => request<void>(`/agent-configs/${id}`, { method: 'DELETE' }),
  ensureSession: (id: string) =>
    request<AgentSession>(`/agent-configs/${id}/session`, { method: 'POST' }),
};
