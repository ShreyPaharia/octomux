import { describe, it, expect } from 'vitest';
import { toTrackerDefaults } from './list-integrations.js';
import type { IntegrationRow } from '../client.js';

function makeRow(kind: string, config: Record<string, unknown>): IntegrationRow {
  return {
    id: `${kind}-1`,
    kind,
    name: `My ${kind}`,
    config,
    enabled: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

describe('toTrackerDefaults', () => {
  it('extracts Jira base_url and default_project', () => {
    const out = toTrackerDefaults(
      makeRow('jira', {
        base_url: 'https://acme.atlassian.net',
        default_project: 'PROJ',
        api_token: '••••',
      }),
    );
    expect(out).toMatchObject({
      kind: 'jira',
      base_url: 'https://acme.atlassian.net',
      default_project: 'PROJ',
    });
    expect(out.default_team_key).toBeUndefined();
  });

  it('extracts Linear default_team_key', () => {
    const out = toTrackerDefaults(makeRow('linear', { default_team_key: 'ENG', api_key: '••••' }));
    expect(out).toMatchObject({ kind: 'linear', default_team_key: 'ENG' });
    expect(out.base_url).toBeUndefined();
  });

  it('never surfaces secret fields', () => {
    const out = toTrackerDefaults(
      makeRow('jira', { base_url: 'https://x.atlassian.net', api_token: 'super-secret' }),
    );
    expect(JSON.stringify(out)).not.toContain('super-secret');
    expect(out).not.toHaveProperty('api_token');
    expect(out).not.toHaveProperty('api_key');
  });

  it('treats empty strings as absent', () => {
    const out = toTrackerDefaults(makeRow('jira', { base_url: '', default_project: '' }));
    expect(out.base_url).toBeUndefined();
    expect(out.default_project).toBeUndefined();
  });
});
