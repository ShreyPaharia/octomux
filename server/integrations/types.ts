import type { HookEnvelope, HookEventName } from '../hook-types.js';

export type JsonSchema = Record<string, unknown>;
export interface ValidationResult {
  ok: boolean;
  errors?: string[];
}

export interface IntegrationProvider {
  kind: string; // 'jira'
  displayName: string; // 'Jira'
  configSchema: JsonSchema; // form schema for UI
  events: HookEventName[]; // events handler reacts to
  validate(config: unknown): ValidationResult;
  test?(config: unknown): Promise<{ ok: boolean; message: string }>;
  handler(envelope: HookEnvelope, config: unknown): Promise<void>;
}

export interface Integration {
  id: string;
  kind: string;
  name: string;
  config: unknown; // parsed JSON
  enabled: boolean;
  created_at: string;
  updated_at: string;
}
