import type { HookEnvelope, HookEventName } from '../hook-types.js';

/** Octomux workflow board columns — shared by Jira/Linear status maps. */
export const OCTOMUX_COLUMNS = [
  'backlog',
  'planned',
  'in_progress',
  'human_review',
  'pr',
  'done',
] as const;

export type OctomuxColumn = (typeof OCTOMUX_COLUMNS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isOctomuxColumn(value: string): value is OctomuxColumn {
  return (OCTOMUX_COLUMNS as readonly string[]).includes(value);
}

/** Ensure status_map is a plain object (Jira — no column-key validation). */
export function validateStatusMapObject(
  statusMap: unknown,
  pathPrefix: string,
  errors: string[],
): void {
  if (!statusMap || typeof statusMap !== 'object' || Array.isArray(statusMap)) {
    errors.push(`${pathPrefix} is required and must be an object`);
  }
}

/** Validate flat status_map keys (optional strict mode for integrations). */
export function validateFlatStatusMap(
  statusMap: unknown,
  pathPrefix: string,
  errors: string[],
): void {
  validateStatusMapObject(statusMap, pathPrefix, errors);
  if (!statusMap || typeof statusMap !== 'object' || Array.isArray(statusMap)) return;
  for (const col of Object.keys(statusMap as Record<string, unknown>)) {
    if (!isOctomuxColumn(col)) {
      errors.push(`${pathPrefix}: invalid column "${col}"`);
    }
  }
}

/** Validate per-team status maps with UUID values (Linear). */
export function validateStatusMapByTeam(
  statusMapByTeam: unknown,
  pathPrefix: string,
  errors: string[],
): void {
  if (
    !statusMapByTeam ||
    typeof statusMapByTeam !== 'object' ||
    Array.isArray(statusMapByTeam)
  ) {
    errors.push(`${pathPrefix} must be an object`);
    return;
  }
  for (const [teamKey, teamMap] of Object.entries(statusMapByTeam)) {
    if (typeof teamMap !== 'object' || teamMap === null || Array.isArray(teamMap)) {
      errors.push(`${pathPrefix}.${teamKey} must be an object`);
      continue;
    }
    for (const [col, uuid] of Object.entries(teamMap as Record<string, unknown>)) {
      if (!isOctomuxColumn(col)) {
        errors.push(`${pathPrefix}.${teamKey}: invalid column "${col}"`);
        continue;
      }
      if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) {
        errors.push(`${pathPrefix}.${teamKey}.${col}: not a valid uuid`);
      }
    }
  }
}

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
