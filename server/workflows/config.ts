import Ajv from 'ajv';
import type { JsonSchema } from '../services/output-contract.js';
import { validateAgainstSchema } from '../services/output-contract.js';
import type { WorkflowType } from './types.js';

const ajv = new Ajv({ allErrors: true, strict: true, useDefaults: true });

export function validateWorkflowConfig(
  wf: WorkflowType,
  config: unknown,
): { valid: boolean; errors?: string[] } {
  if (!wf.config) return { valid: true };
  return validateAgainstSchema(`${wf.kind}:config`, wf.config, config);
}

/** Parse stored config_json and apply schema defaults. Returns `{}` when no schema. */
export function resolveWorkflowConfig(wf: WorkflowType, configJson: string | null): unknown {
  const raw = configJson ? JSON.parse(configJson) : {};
  if (!wf.config) return raw;
  const data = structuredClone(raw) as Record<string, unknown>;
  const validate = ajv.compile(wf.config as JsonSchema);
  validate(data);
  return data;
}
