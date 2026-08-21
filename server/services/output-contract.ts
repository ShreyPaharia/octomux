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

/**
 * Drops a cached validator so the next `validateAgainstSchema(key, ...)` call
 * recompiles.
 *
 * The cache is keyed on `key` alone and never notices that `schema` changed, on
 * the assumption that a key identifies one fixed schema for process lifetime.
 * That assumption breaks the moment anything can be redefined at runtime: a
 * plugin reload (SHR-254) unregisters its fact types and re-runs `apply()`,
 * which may redefine the same qualified type with a DIFFERENT schema — and
 * without this, every later write would be validated against the old one,
 * silently, with no error and no log.
 */
export function forgetCompiledSchema(key: string): void {
  compiled.delete(key);
}
