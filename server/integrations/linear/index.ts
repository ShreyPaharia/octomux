import { childLogger } from '../../logger.js';
import type { IntegrationProvider, ValidationResult, JsonSchema, OctomuxColumn } from '../types.js';
import { isOctomuxColumn, validateStatusMapByTeam } from '../types.js';
import type { HookEnvelope } from '../../hook-types.js';
import { registerProvider } from '../registry.js';
import { invokeLinear, LinearApiError } from './graphql.js';

const logger = childLogger('integrations:linear');

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

function validate(config: unknown): ValidationResult {
  if (typeof config !== 'object' || config === null) {
    return { ok: false, errors: ['config must be an object'] };
  }
  const cfg = config as Record<string, unknown>;
  const errors: string[] = [];

  if (!cfg.api_key || typeof cfg.api_key !== 'string' || !cfg.api_key.trim()) {
    errors.push('api_key is required');
  }

  validateStatusMapByTeam(cfg.status_map_by_team, 'status_map_by_team', errors);

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

async function testConnection(config: unknown): Promise<{ ok: boolean; message: string }> {
  const cfg = config as LinearConfig;
  try {
    const viewer = await invokeLinear(cfg.api_key, (client) => client.viewer);
    return { ok: true, message: `Connected as ${viewer.name ?? viewer.email}` };
  } catch (err) {
    const msg = err instanceof LinearApiError ? err.message : (err as Error).message;
    return { ok: false, message: `Connection failed: ${msg}` };
  }
}

async function handler(envelope: HookEnvelope, config: unknown): Promise<void> {
  const cfg = config as LinearConfig;
  const task = envelope.task;

  const refs = (task.external_refs ?? []) as Array<{
    integration: string;
    ref: string;
    metadata?: Record<string, unknown> | null;
  }>;
  const linearRef = refs.find(
    (r) => r.integration === 'linear' || r.integration.startsWith('linear:'),
  );
  if (!linearRef) {
    logger.debug({ task_id: task.id }, 'linear handler: no linear ref, skipping');
    return;
  }

  const data = envelope.data as Record<string, unknown> | undefined;
  const toStatus = (data?.to_status ?? data?.to ?? '') as string;
  if (!toStatus) {
    logger.debug({ task_id: task.id }, 'linear handler: no to_status, skipping');
    return;
  }

  const metadata = (linearRef.metadata ?? {}) as Record<string, unknown>;
  let teamKey = typeof metadata.team_key === 'string' ? metadata.team_key : '';
  let issueId = typeof metadata.issue_id === 'string' ? metadata.issue_id : '';

  if (!teamKey) {
    const m = linearRef.ref.match(/^([A-Z][A-Z0-9]+)-\d+$/);
    if (m) teamKey = m[1];
  }

  if (!teamKey) {
    logger.debug(
      { task_id: task.id, ref: linearRef.ref },
      'linear handler: cannot derive team_key, skipping',
    );
    return;
  }

  const teamMap = cfg.status_map_by_team[teamKey];
  const stateId = isOctomuxColumn(toStatus) ? teamMap?.[toStatus] : undefined;
  if (!stateId) {
    logger.debug(
      { task_id: task.id, team_key: teamKey, to_status: toStatus },
      'linear handler: no mapping for status, skipping',
    );
    return;
  }

  if (!issueId) {
    try {
      const issue = await invokeLinear(cfg.api_key, (client) => client.issue(linearRef.ref));
      if (!issue) {
        logger.warn({ task_id: task.id, ref: linearRef.ref }, 'linear handler: issue not found');
        return;
      }
      issueId = issue.id;
    } catch (err) {
      logger.warn(
        { task_id: task.id, ref: linearRef.ref, err: (err as Error).message },
        'linear handler: issue lookup failed',
      );
      return;
    }
  }

  try {
    await invokeLinear(cfg.api_key, (client) => client.updateIssue(issueId, { stateId }));
    logger.info(
      {
        task_id: task.id,
        issue_id: issueId,
        team_key: teamKey,
        to_status: toStatus,
        state_id: stateId,
      },
      'linear handler: state updated',
    );
  } catch (err) {
    logger.warn(
      { task_id: task.id, issue_id: issueId, err: (err as Error).message },
      'linear handler: issueUpdate failed',
    );
    return;
  }

  if (toStatus === 'backlog') return;

  const prUrl = typeof data?.pr_url === 'string' ? data.pr_url : '';
  const body = `octomux task moved to **${toStatus}**${prUrl ? ` — PR: ${prUrl}` : ''}.`;

  try {
    await invokeLinear(cfg.api_key, (client) => client.createComment({ issueId, body }));
  } catch (err) {
    logger.warn(
      { task_id: task.id, issue_id: issueId, err: (err as Error).message },
      'linear handler: commentCreate failed',
    );
  }
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
