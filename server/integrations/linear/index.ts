import { childLogger } from '../../logger.js';
import type { IntegrationProvider, ValidationResult, JsonSchema } from '../types.js';
import type { HookEnvelope } from '../../hook-types.js';
import { registerProvider } from '../registry.js';
import { linearGraphql, LinearApiError } from './graphql.js';

const logger = childLogger('integrations:linear');

const OCTOMUX_COLUMNS = [
  'backlog',
  'planned',
  'in_progress',
  'human_review',
  'pr',
  'done',
] as const;
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

const ISSUE_LOOKUP_QUERY = `
  query Issue($id: String!) {
    issue(id: $id) {
      id
      team { id key }
    }
  }
`;

const ISSUE_UPDATE_MUTATION = `
  mutation IssueUpdate($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) { success }
  }
`;

const COMMENT_CREATE_MUTATION = `
  mutation CommentCreate($id: String!, $body: String!) {
    commentCreate(input: { issueId: $id, body: $body }) { success }
  }
`;

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

  // Resolve team_key from metadata or by parsing the ref string.
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
  const stateId = OCTOMUX_COLUMNS.includes(toStatus as OctomuxColumn)
    ? teamMap?.[toStatus as OctomuxColumn]
    : undefined;
  if (!stateId) {
    logger.debug(
      { task_id: task.id, team_key: teamKey, to_status: toStatus },
      'linear handler: no mapping for status, skipping',
    );
    return;
  }

  // Resolve issue UUID if we don't have it cached.
  if (!issueId) {
    try {
      const resp = await linearGraphql<{
        issue: { id: string; team: { key: string } } | null;
      }>(cfg.api_key, ISSUE_LOOKUP_QUERY, { id: linearRef.ref });
      if (!resp.issue) {
        logger.warn({ task_id: task.id, ref: linearRef.ref }, 'linear handler: issue not found');
        return;
      }
      issueId = resp.issue.id;
    } catch (err) {
      logger.warn(
        { task_id: task.id, ref: linearRef.ref, err: (err as Error).message },
        'linear handler: issue lookup failed',
      );
      return;
    }
  }

  // State change.
  try {
    await linearGraphql(cfg.api_key, ISSUE_UPDATE_MUTATION, { id: issueId, stateId });
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

  // Comment-back, unless we're resetting to backlog.
  if (toStatus === 'backlog') return;

  const prUrl = typeof data?.pr_url === 'string' ? data.pr_url : '';
  const body = `octomux task moved to **${toStatus}**${prUrl ? ` — PR: ${prUrl}` : ''}.`;

  try {
    await linearGraphql(cfg.api_key, COMMENT_CREATE_MUTATION, { id: issueId, body });
  } catch (err) {
    // Comment failure shouldn't block the integration; log and move on.
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
