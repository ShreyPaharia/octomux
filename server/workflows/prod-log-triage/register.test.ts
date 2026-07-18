import { describe, it, expect } from 'vitest';
import { getWorkflow } from '../registry.js';
import { SCHEDULE_HANDLERS } from '../../schedules/handlers.js';
import './register.js';

describe('prod-log-triage workflow registration', () => {
  it('registers the prod-log-triage kind with feed+artifact surfaces and no output/sink', () => {
    const wf = getWorkflow('prod-log-triage');
    expect(wf).toBeDefined();
    expect(wf?.displayName).toBe('Prod Log Triage');
    expect(wf?.surfaces).toEqual(['feed', 'artifact']);
    expect(wf?.output).toBeUndefined();
  });

  it('registers a schedule handler for prod-log-triage', () => {
    expect(typeof SCHEDULE_HANDLERS['prod-log-triage']).toBe('function');
  });
});
