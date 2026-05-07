import type { JsonSchema, Integration } from './types.js';

const MASKED_SENTINEL = '••••';

/**
 * Given a config object and a JSON Schema (with `secret: true` on sensitive fields),
 * return a new config object with all secret fields replaced by MASKED_SENTINEL
 * (or "" if the field was empty/absent).
 */
export function maskConfig(config: unknown, schema: JsonSchema): Record<string, unknown> {
  if (typeof config !== 'object' || config === null) return {};
  const cfg = config as Record<string, unknown>;
  const result: Record<string, unknown> = { ...cfg };

  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return result;

  for (const [key, fieldSchema] of Object.entries(properties)) {
    if (fieldSchema.secret === true) {
      const val = cfg[key];
      result[key] = val && String(val).length > 0 ? MASKED_SENTINEL : '';
    } else if (fieldSchema.type === 'object' && fieldSchema.properties) {
      // Recurse into nested objects
      const nested = cfg[key];
      if (typeof nested === 'object' && nested !== null) {
        result[key] = maskConfig(nested, fieldSchema as JsonSchema);
      }
    }
  }

  return result;
}

/**
 * Merge an incoming config (possibly containing masked sentinels) with the
 * existing stored config. If a secret field comes in as MASKED_SENTINEL, keep
 * the stored value instead of overwriting.
 */
export function mergeMaskedConfig(
  existing: unknown,
  incoming: unknown,
  schema: JsonSchema,
): Record<string, unknown> {
  if (typeof incoming !== 'object' || incoming === null) return {};
  const existingObj =
    typeof existing === 'object' && existing !== null
      ? (existing as Record<string, unknown>)
      : {};
  const incomingObj = incoming as Record<string, unknown>;
  const result: Record<string, unknown> = { ...incomingObj };

  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return result;

  for (const [key, fieldSchema] of Object.entries(properties)) {
    if (fieldSchema.secret === true) {
      if (incomingObj[key] === MASKED_SENTINEL) {
        // Keep the stored value unchanged
        result[key] = existingObj[key] ?? '';
      }
    } else if (fieldSchema.type === 'object' && fieldSchema.properties) {
      const existingNested = existingObj[key];
      const incomingNested = incomingObj[key];
      if (typeof incomingNested === 'object' && incomingNested !== null) {
        result[key] = mergeMaskedConfig(existingNested, incomingNested, fieldSchema as JsonSchema);
      }
    }
  }

  return result;
}

/**
 * Mask secret fields in an Integration object for API responses.
 */
export function maskIntegration(integration: Integration, schema: JsonSchema): Integration {
  return {
    ...integration,
    config: maskConfig(integration.config, schema),
  };
}
