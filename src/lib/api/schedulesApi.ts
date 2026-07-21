/**
 * src/lib/api/schedulesApi.ts
 *
 * Schedules API surface: list/create/update/delete cron schedules and their
 * fired runs. Mirrors `server/routes/schedules.ts`.
 */

import type { WorkflowRunRow } from './workflowsApi';
import { request } from './client';

export interface ScheduleRow {
  id: string;
  kind: string;
  repo_path: string;
  cron: string;
  enabled: number;
  last_run_at: string | null;
  config_json: string | null;
  prompt: string | null;
}

export interface ScheduleKindInfo {
  kind: string;
  displayName: string;
  configSchema: Record<string, unknown> | null;
}

export interface CreateScheduleInput {
  kind: string;
  repoPath: string;
  cron: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  prompt?: string | null;
}

export interface UpdateScheduleInput {
  cron?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  prompt?: string | null;
}

export const schedulesApi = {
  listSchedules: () => request<ScheduleRow[]>('/schedules'),
  getScheduleKinds: () => request<{ kinds: ScheduleKindInfo[] }>('/schedules/kinds'),
  getDefaultPrompt: (kind: string, repoPath?: string) => {
    const params = new URLSearchParams({ kind });
    if (repoPath) params.set('repo_path', repoPath);
    return request<{ content: string }>(`/schedules/prompt-default?${params}`);
  },
  createSchedule: (data: CreateScheduleInput) =>
    request<ScheduleRow>('/schedules', { method: 'POST', body: JSON.stringify(data) }),
  updateSchedule: (id: string, data: UpdateScheduleInput) =>
    request<ScheduleRow>(`/schedules/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteSchedule: (id: string) => request<void>(`/schedules/${id}`, { method: 'DELETE' }),
  runScheduleNow: (id: string) =>
    request<{ ok: boolean }>(`/schedules/${id}/run`, { method: 'POST' }),
  getScheduleRuns: (id: string) => request<{ runs: WorkflowRunRow[] }>(`/schedules/${id}/runs`),
};
