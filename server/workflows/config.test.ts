import { describe, it, expect } from 'vitest';
import {
  validateWorkflowConfig,
  resolveWorkflowConfig,
  applyConfigDefaults,
  applyJsonSchemaDefaults,
  isValidJsonSchema,
} from './config.js';
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
  // Defaults are materialized at write time now (applyConfigDefaults, called
  // from the schedules routes) — resolveWorkflowConfig is a plain parse.
  it('returns {} for a null config_json — no schema defaults applied at read time', () => {
    expect(resolveWorkflowConfig(null)).toEqual({});
  });

  it('parses stored config_json verbatim', () => {
    expect(resolveWorkflowConfig(JSON.stringify({ maxIterations: 2 }))).toEqual({
      maxIterations: 2,
    });
  });
});

describe('applyConfigDefaults', () => {
  it('materializes schema defaults for a workflow with a config schema', () => {
    const config = applyConfigDefaults(wf, {}) as { maxIterations: number; verify: string };
    expect(config.maxIterations).toBe(4);
    expect(config.verify).toContain('--head');
  });

  it('preserves caller-supplied values over defaults', () => {
    const config = applyConfigDefaults(wf, { maxIterations: 9 }) as { maxIterations: number };
    expect(config.maxIterations).toBe(9);
  });

  it('returns {} for a workflow with no config schema', () => {
    const noConfigWf: WorkflowType = { kind: 'daily-plan', displayName: 'x', surfaces: [] };
    expect(applyConfigDefaults(noConfigWf, undefined)).toEqual({});
  });
});

describe('applyJsonSchemaDefaults', () => {
  it('materializes defaults directly against a raw JSON Schema (schema-agnostic, no WorkflowType wrapper)', () => {
    const result = applyJsonSchemaDefaults(DOC_DRIFT_CONFIG_SCHEMA, {}) as {
      maxIterations: number;
    };
    expect(result.maxIterations).toBe(4);
  });

  it('returns {} when schema is undefined', () => {
    expect(applyJsonSchemaDefaults(undefined, undefined)).toEqual({});
  });
});

describe('isValidJsonSchema', () => {
  it('accepts a valid schema', () => {
    expect(isValidJsonSchema(DOC_DRIFT_CONFIG_SCHEMA)).toBe(true);
  });

  it('rejects a malformed schema', () => {
    expect(isValidJsonSchema({ type: 'not-a-real-type' })).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(isValidJsonSchema('not a schema')).toBe(false);
  });
});
