/**
 * src/lib/api/kindsApi.ts
 *
 * Schedule-kind preset API surface (spec/schedule-kinds-as-presets.md §5).
 * A preset is metadata + default cron + prompt + optional config/output JSON
 * Schemas, read only when the UI builds a create form or the Settings → Kinds
 * editor. Mirrors `server/routes/kinds.ts`.
 */

import { request } from './client';

export interface Preset {
  kind: string;
  displayName: string;
  execution: 'session' | 'task' | 'chat';
  defaultCron?: string;
  prompt?: string;
  config?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

export interface PresetWithSource extends Preset {
  source: 'builtin' | 'home';
}

export const kindsApi = {
  listKinds: () => request<{ kinds: PresetWithSource[] }>('/kinds'),
  savePreset: (kind: string, data: Preset) =>
    request<PresetWithSource>(`/kinds/${kind}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePreset: (kind: string) => request<void>(`/kinds/${kind}`, { method: 'DELETE' }),
};
