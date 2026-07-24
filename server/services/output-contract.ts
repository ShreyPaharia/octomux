import Ajv, { type ValidateFunction } from 'ajv';
import { childLogger } from '../logger.js';

const logger = childLogger('output-contract');

export type JsonSchema = Record<string, unknown>;

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

const ajv = new Ajv({ allErrors: true, strict: true });
// 'single-line' is a UI rendering hint on workflow config schemas, not a
// validation format — register it as always-valid so strict mode accepts it.
ajv.addFormat('single-line', true);
const compiled = new Map<string, ValidateFunction>();

/**
 * Validate `payload` against `schema`, compiling (and caching) the ajv validator
 * once per `key`. `key` identifies the schema (e.g. a workflow kind) — callers
 * must pass the same key every time for the same schema so the cache stays
 * consistent.
 */
export function validateAgainstSchema(
  key: string,
  schema: JsonSchema,
  payload: unknown,
): ValidationResult {
  let validate = compiled.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(key, validate);
  }

  const valid = validate(payload) as boolean;
  if (valid) return { valid: true };

  const errors = (validate.errors ?? []).map(
    (e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`,
  );
  logger.debug({ schema_key: key, errors }, 'output contract validation failed');
  return { valid: false, errors };
}
