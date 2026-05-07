import { childLogger } from '../../logger.js';
import type { IntegrationProvider, ValidationResult, JsonSchema } from '../types.js';
import type { HookEnvelope } from '../../hook-types.js';
import { registerProvider } from '../registry.js';

const logger = childLogger('integrations:jira');

export interface JiraConfig {
  base_url: string;
  email: string;
  api_token: string;
  default_project?: string;
  status_map: Record<string, string>;
}

const CONFIG_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['base_url', 'email', 'api_token', 'status_map'],
  properties: {
    base_url: {
      type: 'string',
      format: 'uri',
      title: 'Base URL',
      description: 'e.g. https://acme.atlassian.net',
    },
    email: { type: 'string', format: 'email', title: 'Email' },
    api_token: { type: 'string', title: 'API token', secret: true },
    default_project: { type: 'string', title: 'Default project key (optional)' },
    status_map: {
      type: 'object',
      title: 'Workflow → Jira transition ID map',
      description: 'Map octomux workflow_status values to Jira transition IDs.',
      additionalProperties: { type: 'string' },
      properties: {
        backlog: { type: 'string' },
        planned: { type: 'string' },
        in_progress: { type: 'string' },
        human_review: { type: 'string' },
        pr: { type: 'string' },
        done: { type: 'string' },
      },
    },
  },
};

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function validate(config: unknown): ValidationResult {
  if (typeof config !== 'object' || config === null) {
    return { ok: false, errors: ['config must be an object'] };
  }
  const cfg = config as Record<string, unknown>;
  const errors: string[] = [];

  if (!cfg.base_url || typeof cfg.base_url !== 'string' || !cfg.base_url.trim()) {
    errors.push('base_url is required');
  } else if (!isValidUrl(cfg.base_url)) {
    errors.push('base_url must be a valid HTTP/HTTPS URL');
  }

  if (!cfg.email || typeof cfg.email !== 'string' || !cfg.email.trim()) {
    errors.push('email is required');
  } else if (!isValidEmail(cfg.email)) {
    errors.push('email must be a valid email address');
  }

  if (!cfg.api_token || typeof cfg.api_token !== 'string' || !cfg.api_token.trim()) {
    errors.push('api_token is required');
  }

  if (!cfg.status_map || typeof cfg.status_map !== 'object' || Array.isArray(cfg.status_map)) {
    errors.push('status_map is required and must be an object');
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

async function testConnection(config: unknown): Promise<{ ok: boolean; message: string }> {
  const cfg = config as JiraConfig;
  try {
    const credentials = Buffer.from(`${cfg.email}:${cfg.api_token}`).toString('base64');
    const res = await fetch(`${cfg.base_url}/rest/api/3/myself`, {
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: 'application/json',
      },
    });
    if (res.ok) {
      const data = (await res.json()) as { displayName?: string; emailAddress?: string };
      return {
        ok: true,
        message: `Connected as ${data.displayName ?? data.emailAddress ?? 'unknown user'}`,
      };
    }
    return { ok: false, message: `Jira returned ${res.status}: ${res.statusText}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Connection failed: ${msg}` };
  }
}

async function handler(envelope: HookEnvelope, config: unknown): Promise<void> {
  const cfg = config as JiraConfig;
  const task = envelope.task;

  // Find a matching external ref for Jira
  const refs = (task.external_refs ?? []) as Array<{ integration: string; ref: string }>;
  const jiraRef = refs.find(
    (r) => r.integration === 'jira' || r.integration.startsWith('jira:'),
  );

  if (!jiraRef) {
    logger.debug(
      { task_id: task.id, event: envelope.event },
      'jira handler: no jira ref found, skipping',
    );
    return;
  }

  const issueKey = jiraRef.ref;
  const data = envelope.data as Record<string, unknown> | undefined;
  const toStatus = (data?.to_status ?? data?.to ?? '') as string;

  if (!toStatus) {
    logger.debug(
      { task_id: task.id, event: envelope.event },
      'jira handler: no to_status in envelope, skipping',
    );
    return;
  }

  const statusMap = cfg.status_map ?? {};
  const transitionId = statusMap[toStatus];
  if (!transitionId) {
    logger.debug(
      { task_id: task.id, event: envelope.event, to_status: toStatus },
      'jira handler: no transition mapping for status, skipping',
    );
    return;
  }

  const credentials = Buffer.from(`${cfg.email}:${cfg.api_token}`).toString('base64');
  try {
    const res = await fetch(`${cfg.base_url}/rest/api/3/issue/${issueKey}/transitions`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ transition: { id: transitionId } }),
    });
    if (res.ok || res.status === 204) {
      logger.info(
        { task_id: task.id, issue_key: issueKey, to_status: toStatus, transition_id: transitionId },
        'jira handler: transitioned issue',
      );
    } else {
      const body = await res.text().catch(() => '');
      logger.warn(
        {
          task_id: task.id,
          issue_key: issueKey,
          to_status: toStatus,
          transition_id: transitionId,
          status: res.status,
          body,
        },
        'jira handler: transition request failed',
      );
    }
  } catch (err) {
    logger.warn(
      {
        task_id: task.id,
        issue_key: issueKey,
        to_status: toStatus,
        err: err instanceof Error ? err.message : String(err),
      },
      'jira handler: fetch error',
    );
  }
}

export const jiraProvider: IntegrationProvider = {
  kind: 'jira',
  displayName: 'Jira',
  configSchema: CONFIG_SCHEMA,
  events: ['workflow_status_changed'],
  validate,
  test: testConnection,
  handler,
};

// Register the provider
registerProvider(jiraProvider);
