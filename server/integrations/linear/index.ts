import { childLogger } from '../../logger.js';
import type { IntegrationProvider, ValidationResult, JsonSchema } from '../types.js';
import type { HookEnvelope } from '../../hook-types.js';
import { registerProvider } from '../registry.js';
import { linearGraphql, LinearApiError } from './graphql.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const logger = childLogger('integrations:linear');

const OCTOMUX_COLUMNS = ['backlog', 'planned', 'in_progress', 'human_review', 'pr', 'done'] as const;
type OctomuxColumn = (typeof OCTOMUX_COLUMNS)[number];

export interface LinearConfig {
  api_key: string;
  workspace_url?: string;
  default_team_key?: string;
  status_map_by_team: Record<string, Partial<Record<OctomuxColumn, string>>>;
}

const CONFIG_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['api_key', 'status_map_by_team'],
  properties: {
    api_key: { type: 'string', title: 'API key', secret: true },
    workspace_url: { type: 'string', format: 'uri', title: 'Workspace URL (display only)' },
    default_team_key: { type: 'string', title: 'Default team key' },
    status_map_by_team: {
      type: 'object',
      title: 'Per-team status maps',
      description: 'Map octomux workflow_status values to Linear state UUIDs, keyed by team key.',
    },
  },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validate(config: unknown): ValidationResult {
  if (typeof config !== 'object' || config === null) {
    return { ok: false, errors: ['config must be an object'] };
  }
  const cfg = config as Record<string, unknown>;
  const errors: string[] = [];

  if (!cfg.api_key || typeof cfg.api_key !== 'string' || !cfg.api_key.trim()) {
    errors.push('api_key is required');
  }

  if (
    !cfg.status_map_by_team ||
    typeof cfg.status_map_by_team !== 'object' ||
    Array.isArray(cfg.status_map_by_team)
  ) {
    errors.push('status_map_by_team must be an object');
  } else {
    for (const [teamKey, teamMap] of Object.entries(cfg.status_map_by_team)) {
      if (typeof teamMap !== 'object' || teamMap === null || Array.isArray(teamMap)) {
        errors.push(`status_map_by_team.${teamKey} must be an object`);
        continue;
      }
      for (const [col, uuid] of Object.entries(teamMap as Record<string, unknown>)) {
        if (!OCTOMUX_COLUMNS.includes(col as OctomuxColumn)) {
          errors.push(`status_map_by_team.${teamKey}: invalid column "${col}"`);
          continue;
        }
        if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) {
          errors.push(`status_map_by_team.${teamKey}.${col}: not a valid uuid`);
        }
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

async function testConnection(config: unknown): Promise<{ ok: boolean; message: string }> {
  const cfg = config as LinearConfig;
  try {
    const data = await linearGraphql<{ viewer: { id: string; name: string; email: string } }>(
      cfg.api_key,
      'query { viewer { id name email } }',
    );
    return { ok: true, message: `Connected as ${data.viewer.name ?? data.viewer.email}` };
  } catch (err) {
    const msg = err instanceof LinearApiError ? err.message : (err as Error).message;
    return { ok: false, message: `Connection failed: ${msg}` };
  }
}

// Handler implemented in Task 5 — placeholder for now so the provider object compiles.
async function handler(_envelope: HookEnvelope, _config: unknown): Promise<void> {
  // implemented in Task 5
}

export const linearProvider: IntegrationProvider = {
  kind: 'linear',
  displayName: 'Linear',
  configSchema: CONFIG_SCHEMA,
  events: ['workflow_status_changed'],
  validate,
  test: testConnection,
  handler,
};

registerProvider(linearProvider);
