import { getSettings } from '../settings.js';
import { resolveEnvVars } from '../integrations/resolve-env.js';
import { resolveSecrets } from '../secrets/store.js';

/**
 * Sets an own data property keyed by a caller-controlled string. Plain
 * `obj[key] = value` is unsafe here: a secret key like `__proto__` would
 * mutate the prototype instead of the object.
 */
function setOwn(target: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Per-compute-provider config with `${env:VAR}` placeholders expanded.
 * Returned to `provider.create()` only — see the invariant on
 * `ComputeCreateContext.secrets` (server/compute/types.ts): secrets must be
 * resolved in the server process and must never reach the agent.
 *
 * Rule: keys under `settings.compute[kind].secrets` come back as `secrets`
 * (env-expanded, string-valued, and stripped out of `config` entirely).
 * Everything else in the blob is `config` (also env-expanded). Reuses
 * `resolveEnvVars()` — the same `${env:VAR_NAME}` convention integration
 * providers already use to keep a real secret out of the DB.
 *
 * `Object.hasOwn` guard mirrors `getPluginSettings()`'s: `kind` is a
 * caller/plugin-controlled string, and plain `settings.compute[kind]` would
 * walk the prototype chain for a key like `constructor`.
 */
export async function computeConfigFor(
  kind: string,
): Promise<{ config: Record<string, unknown>; secrets: Record<string, string> }> {
  const settings = await getSettings();
  // `settings.compute` is defaulted by getSettings() in production, but a
  // partially-mocked getSettings() in tests may omit it — and a provider
  // with no configured block is a legitimate state anyway.
  const all = settings.compute ?? {};
  const raw = Object.hasOwn(all, kind) ? all[kind] : {};
  const { secrets: rawSecrets, ...rawConfig } = raw as Record<string, unknown> & {
    secrets?: Record<string, unknown>;
  };

  // `config` is env-only, deliberately: it is NOT resolved through
  // `resolveSecrets()`. `config` is the half of this split that the file's
  // own invariant (above) says can reach the agent's environment — resolving
  // `${secret:NAME}` here would hand a credential straight to the agent,
  // which is exactly the egress path this store exists to avoid. `secrets`
  // is the one the invariant says never reaches the agent, so it's the only
  // side that gets both placeholder conventions.
  const config = resolveEnvVars(rawConfig) as Record<string, unknown>;

  const secrets: Record<string, string> = {};
  if (rawSecrets && typeof rawSecrets === 'object') {
    for (const [secretKey, value] of Object.entries(rawSecrets)) {
      setOwn(secrets, secretKey, String(resolveSecrets(resolveEnvVars(value)) ?? ''));
    }
  }

  return { config, secrets };
}
