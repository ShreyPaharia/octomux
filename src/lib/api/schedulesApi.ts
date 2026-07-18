/**
 * src/lib/api/schedulesApi.ts
 *
 * Schedules API surface: list/create/update/delete cron schedules and their
 * fired runs. Mirrors `server/routes/schedules.ts`.
 */

import type { Task } from '@octomux/types';
import { request } from './client';

export interface ScheduleRow {
  id: string;
  kind: string;
  repo_path: string;
  cron: string;
  enabled: number;
  last_run_at: string | null;
  config_json: string | null;
}

export interface CreateScheduleInput {
  kind: string;
  repoPath: string;
  cron: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export interface UpdateScheduleInput {
  cron?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

export const schedulesApi = {
  listSchedules: () => request<ScheduleRow[]>('/schedules'),
  getScheduleKinds: () => request<{ kinds: string[] }>('/schedules/kinds'),
  createSchedule: (data: CreateScheduleInput) =>
    request<ScheduleRow>('/schedules', { method: 'POST', body: JSON.stringify(data) }),
  updateSchedule: (id: string, data: UpdateScheduleInput) =>
    request<ScheduleRow>(`/schedules/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteSchedule: (id: string) => request<void>(`/schedules/${id}`, { method: 'DELETE' }),
  getScheduleRuns: (id: string) => request<{ runs: Task[] }>(`/schedules/${id}/runs`),
};
