import { describe, it, expect } from 'vitest';
import { validateWorkflowConfig, resolveWorkflowConfig } from './config.js';
import { DOC_DRIFT_CONFIG_SCHEMA } from './doc-drift/schema.js';
import type { WorkflowType } from './types.js';

const wf: WorkflowType = {
  kind: 'doc-drift',
  displayName: 'Doc Drift',
  surfaces: ['feed'],
  config: DOC_DRIFT_CONFIG_SCHEMA,
};

describe('validateWorkflowConfig', () => {
  it('rejects invalid maxIterations', () => {
    const result = validateWorkflowConfig(wf, { maxIterations: 0 });
    expect(result.valid).toBe(false);
  });

  it('accepts a valid config object', () => {
    const result = validateWorkflowConfig(wf, { verify: 'true', maxIterations: 2 });
    expect(result.valid).toBe(true);
  });
});

describe('resolveWorkflowConfig', () => {
  it('applies schema defaults from null config_json', () => {
    const config = resolveWorkflowConfig(wf, null) as { maxIterations: number; verify: string };
    expect(config.maxIterations).toBe(4);
    expect(config.verify).toContain('--head');
  });
});
