import Ajv from 'ajv';
import type { JsonSchema } from '../services/output-contract.js';
import { validateAgainstSchema } from '../services/output-contract.js';
import type { WorkflowType } from './types.js';

const ajv = new Ajv({ allErrors: true, strict: true, useDefaults: true });
// 'single-line' is a UI rendering hint (SchemaConfigForm renders Input vs Textarea),
// not a validation format — register it as always-valid so strict mode accepts it.
ajv.addFormat('single-line', true);

export function validateWorkflowConfig(
  wf: WorkflowType,
  config: unknown,
): { valid: boolean; errors?: string[] } {
  if (!wf.config) return { valid: true };
  return validateAgainstSchema(`${wf.kind}:config`, wf.config, config);
}

/**
 * Parse stored `config_json` verbatim — defaults are materialized at write
 * time (`applyConfigDefaults`, called from the schedules routes on
 * create/update) so this is a plain parse, never a read-time ajv pass.
 */
export function resolveWorkflowConfig(configJson: string | null): unknown {
  return configJson ? JSON.parse(configJson) : {};
}

/**
 * Apply a JSON Schema's defaults (ajv `useDefaults`) to a config object at
 * write time, so the stored value is always fully materialized. Returns the
 * input (defaulted to `{}`) unchanged when there's no schema. Schema-agnostic
 * so it's usable both from a `WorkflowType` (`applyConfigDefaults`) and
 * directly against a shipped preset's `config` schema (the migration in
 * `db/migrations.ts`, which can't import the workflow registry — see its
 * comment for why).
 */
export function applyJsonSchemaDefaults(schema: JsonSchema | undefined, config: unknown): unknown {
  const raw = (config ?? {}) as Record<string, unknown>;
  if (!schema) return raw;
  const data = structuredClone(raw);
  const validate = ajv.compile(schema);
  validate(data);
  return data;
}

/**
 * Apply a workflow's `config` schema defaults (ajv `useDefaults`) to a config
 * object at write time, so `config_json` is always fully materialized in the
 * DB. Returns the input unchanged when the workflow has no config schema.
 */
export function applyConfigDefaults(wf: WorkflowType, config: unknown): unknown {
  return applyJsonSchemaDefaults(wf.config as JsonSchema | undefined, config);
}

/**
 * Whether `schema` is a valid JSON Schema, compiled with the same ajv
 * instance (and `single-line` format registration) used for workflow config
 * validation. Used by the preset loader (§3.2) to reject a `config`/`output`
 * schema that fails to compile — never throws.
 */
export function isValidJsonSchema(schema: unknown): boolean {
  try {
    ajv.compile(schema as JsonSchema);
    return true;
  } catch {
    return false;
  }
}
