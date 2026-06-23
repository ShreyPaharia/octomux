/**
 * src/lib/api/configApi.ts
 *
 * Configuration-domain API surface: settings, setup status, hook templates,
 * harnesses, skills, agent definitions, repo configs, integrations, and the hook
 * registry. Mirrors the per-domain routers under `server/routes/` (settings,
 * setup, skills, agent-defs, integrations, hooks-registry, plus repo-config).
 */

import { request } from './client';

export interface Skill {
  name: string;
  description: string;
}

export interface SkillDetail {
  name: string;
  content: string;
}

export interface AgentDefinition {
  name: string;
  description: string;
  isCustom: boolean;
}

export interface AgentDetail {
  name: string;
  content: string;
  defaultContent: string;
  isCustom: boolean;
}

export interface OctomuxSettings {
  editor: 'nvim' | 'vscode' | 'cursor';
  dangerouslySkipPermissions: boolean;
  claudeFlags: string;
  defaultHarnessId?: string;
  harnesses?: Record<string, Record<string, unknown>>;
  defaultJiraBaseUrl?: string;
  defaultJiraProjectKey?: string;
  defaultBaseBranch?: string;
  onboardingCompletedAt?: string;
  deleteGraceHours?: number;
  envOverrides?: {
    claudeFlags: string | null;
  };
  defaultTracker?: 'jira' | 'linear';
  defaultLinearTeamKey?: string;
}

export type SetupItemStatus = 'ok' | 'missing' | 'outdated' | 'unconfigured' | 'optional_missing';

export interface SetupItem {
  id: string;
  label: string;
  category: 'required' | 'recommended' | 'optional';
  status: SetupItemStatus;
  version?: string;
  detail?: string;
  install?: {
    kind: 'brew' | 'copy' | 'template' | 'sync' | 'shell' | string;
    id: string;
    label: string;
  };
  configureUrl?: string;
  docsUrl?: string;
}

export interface HookTemplate {
  id: string;
  installed: boolean;
}

export interface SetupStatusResponse {
  items: SetupItem[];
  summary: { ready: boolean; blockerCount: number; attentionCount: number };
  platform: string;
  hasBrew: boolean;
}

export interface HarnessSummary {
  id: string;
  displayName: string;
  sessionIdMode: 'orchestrator-assigned' | 'harness-issued';
}

export interface RepoConfig {
  repo_path: string;
  base_branch: string | null;
  test_command: string;
  format_command: string;
  lint_command: string;
  /** JSON array of RefInferenceRule — opt-in per-repo branch→ref auto-inference. */
  ref_inference_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface RefInferenceRule {
  integration: string;
  pattern: string;
  url_template?: string;
}

// ─── Hook registry types (C4) ────────────────────────────────────────────────

export interface HookRegistryEntry {
  scope: 'global' | `repo:${string}` | 'builtin';
  key: string;
  event: string | null;
  script_path: string | null;
  description: string | null;
  enabled: boolean;
  requires_env: string | null;
  last_run_at: string | null;
  last_exit_code: number | null;
}

// ─── Integrations types (Wave 2B) ────────────────────────────────────────────

export interface IntegrationProvider {
  kind: string;
  displayName: string;
  configSchema: Record<string, unknown>;
  events: string[];
}

export interface IntegrationRow {
  id: string;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export const configApi = {
  getSettings: () => request<OctomuxSettings>('/settings'),
  updateSettings: (data: Partial<OctomuxSettings>) =>
    request<OctomuxSettings>('/settings', { method: 'PATCH', body: JSON.stringify(data) }),

  getSetupStatus: () => request<SetupStatusResponse>('/setup/status'),
  setupInstall: (id: string) =>
    request<{ ok: boolean; message: string }>('/setup/install', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  applyRecommendedDefaults: () =>
    request<OctomuxSettings>('/setup/apply-recommended-defaults', { method: 'POST' }),
  listHookTemplates: () => request<HookTemplate[]>('/hooks/templates'),
  installHookTemplate: (template: string) =>
    request<{ ok: boolean; files: string[] }>('/hooks/install', {
      method: 'POST',
      body: JSON.stringify({ template }),
    }),

  // Harnesses (coding agent runtimes — Claude Code, Cursor, ...)
  listHarnesses: () => request<HarnessSummary[]>('/harnesses'),

  // Skills
  listSkills: () => request<Skill[]>('/skills'),
  getSkill: (name: string) => request<SkillDetail>(`/skills/${encodeURIComponent(name)}`),
  createSkill: (data: { name: string; content: string }) =>
    request<SkillDetail>('/skills', { method: 'POST', body: JSON.stringify(data) }),
  updateSkill: (name: string, data: { content: string }) =>
    request<SkillDetail>(`/skills/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteSkill: (name: string) =>
    request<void>(`/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  // Agents
  listAgents: () => request<AgentDefinition[]>('/agents'),
  getAgent: (name: string) => request<AgentDetail>(`/agents/${encodeURIComponent(name)}`),
  saveAgent: (name: string, content: string) =>
    request<AgentDetail>(`/agents/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),
  resetAgent: (name: string) =>
    request<{ ok: boolean }>(`/agents/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  createAgent: (data: { name: string; content: string }) =>
    request<AgentDetail>('/agents', { method: 'POST', body: JSON.stringify(data) }),
  deleteAgent: (name: string) =>
    request<{ ok: boolean }>(`/agents/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  // Repo Config
  listRepoConfigs: () => request<RepoConfig[]>('/repo-configs'),
  getRepoConfig: (repoPath: string) =>
    request<RepoConfig>(`/repo-config?repo_path=${encodeURIComponent(repoPath)}`),
  updateRepoConfig: (repoPath: string, updates: Partial<RepoConfig>) =>
    request<RepoConfig>('/repo-config', {
      method: 'PATCH',
      body: JSON.stringify({ repo_path: repoPath, ...updates }),
    }),

  // ─── Integrations (Wave 2B) ──────────────────────────────────────────────────

  listProviders: () => request<IntegrationProvider[]>('/integrations/providers'),
  listIntegrations: () => request<IntegrationRow[]>('/integrations'),
  createIntegration: (kind: string, name: string, config: Record<string, unknown>) =>
    request<IntegrationRow>('/integrations', {
      method: 'POST',
      body: JSON.stringify({ kind, name, config }),
    }),
  updateIntegration: (
    id: string,
    patch: { name?: string; config?: Record<string, unknown>; enabled?: boolean },
  ) =>
    request<IntegrationRow>(`/integrations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  deleteIntegration: (id: string) =>
    request<void>(`/integrations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testIntegration: (id: string) =>
    request<{ ok: boolean; message: string }>(`/integrations/${encodeURIComponent(id)}/test`, {
      method: 'POST',
    }),

  async prefillLinear(apiKey: string): Promise<{
    teams: Array<{
      id: string;
      key: string;
      name: string;
      states: Array<{ id: string; name: string; type: string }>;
    }>;
    status_map_by_team: Record<
      string,
      Partial<
        Record<'backlog' | 'planned' | 'in_progress' | 'human_review' | 'pr' | 'done', string>
      >
    >;
    default_team_suggestion: string | null;
  }> {
    const res = await fetch('/api/integrations/linear/prefill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error ?? `prefill failed: ${res.status}`);
    }
    return res.json();
  },

  // ─── Hooks registry (C4) ─────────────────────────────────────────────────────
  getHooksRegistry: () => request<{ hooks: HookRegistryEntry[] }>('/hooks/registry'),
  updateHookEnabled: (scope: string, key: string, enabled: boolean) =>
    request<{ scope: string; key: string; enabled: boolean }>(
      `/hooks/registry/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`,
      { method: 'PATCH', body: JSON.stringify({ enabled }) },
    ),
};
