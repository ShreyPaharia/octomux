import { describe, it, expect } from 'vitest';
import { inferRefs, parseRefInferenceRules } from './ref-inference.js';
import type { RepoConfigWithInference } from './ref-inference.js';

const TASK_ID = 'task-abc123';

function makeConfig(rules: object | null): RepoConfigWithInference {
  return {
    repo_path: '/some/repo',
    ref_inference_json: rules === null ? null : JSON.stringify(rules),
  };
}

describe('parseRefInferenceRules', () => {
  it('returns empty array for null', () => {
    expect(parseRefInferenceRules(null)).toEqual([]);
  });

  it('returns empty array for undefined', () => {
    expect(parseRefInferenceRules(undefined)).toEqual([]);
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseRefInferenceRules('not-json')).toEqual([]);
  });

  it('returns empty array when JSON is not an array', () => {
    expect(parseRefInferenceRules('{"integration":"jira"}')).toEqual([]);
  });

  it('filters out entries missing required fields', () => {
    const rules = JSON.stringify([
      { integration: 'jira', pattern: '^IN-\\d+' },
      { integration: 'jira' }, // missing pattern
      { pattern: '^PROJ-\\d+' }, // missing integration
    ]);
    const result = parseRefInferenceRules(rules);
    expect(result).toHaveLength(1);
    expect(result[0].integration).toBe('jira');
  });
});

describe('inferRefs', () => {
  it('returns empty when no rules configured', () => {
    const config = makeConfig(null);
    expect(inferRefs('agents/IN-123', config, TASK_ID)).toEqual([]);
  });

  it('returns empty when branch does not match', () => {
    const config = makeConfig([
      { integration: 'jira', pattern: '^(?:agents/)?(IN-\\d+)' },
    ]);
    expect(inferRefs('feature/my-feature', config, TASK_ID)).toEqual([]);
  });

  it('matches branch and extracts capture group', () => {
    const config = makeConfig([
      { integration: 'jira', pattern: '^(?:agents/)?(IN-\\d+)' },
    ]);
    const refs = inferRefs('agents/IN-456', config, TASK_ID);
    expect(refs).toHaveLength(1);
    expect(refs[0].integration).toBe('jira');
    expect(refs[0].ref).toBe('IN-456');
    expect(refs[0].task_id).toBe(TASK_ID);
  });

  it('uses full match when no capture group', () => {
    const config = makeConfig([
      { integration: 'custom', pattern: 'TICKET-\\d+' },
    ]);
    const refs = inferRefs('fix/TICKET-789-some-bug', config, TASK_ID);
    expect(refs).toHaveLength(1);
    expect(refs[0].ref).toBe('TICKET-789');
  });

  it('substitutes {ref} in url_template', () => {
    const config = makeConfig([
      {
        integration: 'jira',
        pattern: '^(?:agents/)?(IN-\\d+)',
        url_template: 'https://acme.atlassian.net/browse/{ref}',
      },
    ]);
    const refs = inferRefs('agents/IN-100', config, TASK_ID);
    expect(refs[0].url).toBe('https://acme.atlassian.net/browse/IN-100');
  });

  it('leaves url null when no url_template', () => {
    const config = makeConfig([
      { integration: 'jira', pattern: '^(?:agents/)?(IN-\\d+)' },
    ]);
    const refs = inferRefs('agents/IN-100', config, TASK_ID);
    expect(refs[0].url).toBeNull();
  });

  it('only uses first match per integration', () => {
    const config = makeConfig([
      { integration: 'jira', pattern: 'IN-\\d+' },
      { integration: 'jira', pattern: 'PROJ-\\d+' }, // same integration — should be skipped
    ]);
    const refs = inferRefs('IN-111-PROJ-222', config, TASK_ID);
    expect(refs).toHaveLength(1);
    expect(refs[0].ref).toBe('IN-111');
  });

  it('supports multiple integrations in one config', () => {
    const config = makeConfig([
      { integration: 'jira', pattern: '(IN-\\d+)' },
      { integration: 'linear', pattern: '(ENG-\\d+)' },
    ]);
    const refs = inferRefs('IN-555/ENG-333-branch', config, TASK_ID);
    expect(refs).toHaveLength(2);
    const jiraRef = refs.find((r) => r.integration === 'jira');
    const linearRef = refs.find((r) => r.integration === 'linear');
    expect(jiraRef?.ref).toBe('IN-555');
    expect(linearRef?.ref).toBe('ENG-333');
  });

  it('skips rules with invalid regex patterns', () => {
    const config = makeConfig([
      { integration: 'jira', pattern: '[invalid(' }, // invalid regex
      { integration: 'linear', pattern: '(ENG-\\d+)' },
    ]);
    const refs = inferRefs('ENG-001', config, TASK_ID);
    expect(refs).toHaveLength(1);
    expect(refs[0].integration).toBe('linear');
  });
});
