/**
 * src/lib/api/agentsApi.ts
 *
 * Agents-feature API surface: CRUD for long-running conductor agents plus the
 * derived live status and the endpoint that ensures/opens an agent's
 * persistent conductor session. Mirrors `server/routes/agents-crud.ts`.
 *
 * The REST base is `/api/agents`. Agent *role* definitions
 * (orchestrator/planner/reviewer) live at `/api/agent-roles`
 * (`routes/agent-defs.ts`); the per-task tmux-window worker hop lives at
 * `/api/workers/:id/task` (`routes/chats.ts`).
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
  list: () => request<AgentWithStatus[]>('/agents'),
  create: (data: CreateAgentInput) =>
    request<AgentWithStatus>('/agents', { method: 'POST', body: JSON.stringify(data) }),
  get: (id: string) => request<AgentWithStatus>(`/agents/${id}`),
  update: (id: string, data: UpdateAgentInput) =>
    request<AgentWithStatus>(`/agents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  remove: (id: string) => request<void>(`/agents/${id}`, { method: 'DELETE' }),
  ensureSession: (id: string) => request<AgentSession>(`/agents/${id}/session`, { method: 'POST' }),
  /** Find-or-create the Advisor agent and ensure its persistent session. */
  advisorSession: () => request<AgentSession>('/advisor/session', { method: 'POST' }),
};
