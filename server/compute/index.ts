import { childLogger } from '../logger.js';
import { computeConfigFor } from './config.js';
import type { Task } from '../types.js';
import type { ComputeCreateContext, ComputeSession } from './types.js';
import { DEFAULT_COMPUTE_KIND, getCompute, freezeCoreCompute } from './registry.js';
import { execBackedFiles } from './exec-files.js';

// Also registers the core provider as a side effect.
import { localSession } from './local.js';

// Lock the core kinds against redefinition now that `local` has registered,
// and before any plugin compute provider gets a chance to load.
freezeCoreCompute();

export * from './types.js';
export {
  registerCompute,
  getCompute,
  listCompute,
  DEFAULT_COMPUTE_KIND,
  CORE_COMPUTE_KINDS,
  freezeCoreCompute,
  resetCompute,
  unregisterCompute,
} from './registry.js';
export { localCompute, localSession, localFiles, localExec } from './local.js';
export { execBackedFiles } from './exec-files.js';
export { computeConfigFor } from './config.js';

/**
 * Resolves the per-provider context.
 *
 * `computeConfigFor` splits `settings.compute[kind]` into the plain `config`
 * and the `secrets` sub-object, expanding `${env:VAR}` placeholders in both.
 * That expansion happens HERE, in the server process, and the result is handed
 * to `provider.create()` and nowhere else — the agent's environment, its
 * launched command, and its worktree never see it. That boundary is the whole
 * point of brokering: a provider needs a key to reach its box; the agent
 * running on that box has no business holding one.
 */
async function resolveComputeContext(kind: string): Promise<ComputeCreateContext> {
  const { config, secrets } = await computeConfigFor(kind);
  return {
    config,
    secrets,
    logger: childLogger(`compute/${kind}`),
    // Bound so a provider can pass these around without losing `this`.
    host: {
      exec: localSession.exec.bind(localSession),
      spawnPty: localSession.spawn.bind(localSession),
    },
    execBackedFiles,
  };
}

const sessions = new Map<string, Promise<ComputeSession>>();

/**
 * Create-or-reattach the compute session for a task. Cached by task.id so
 * any code already holding a Task gets a session in one await — no
 * threading a session parameter up through call stacks.
 */
export async function sessionFor(task: Task): Promise<ComputeSession> {
  const cached = sessions.get(task.id);
  if (cached) return cached;

  // `tasks.compute` doesn't exist yet either — same later wave. Cast rather
  // than adding the column early.
  const kind = (task as { compute?: string | null }).compute ?? DEFAULT_COMPUTE_KIND;
  const provider = getCompute(kind);

  const promise = (async () => {
    const ctx = await resolveComputeContext(kind);
    // Prefer resume() when the provider offers it. We can't yet tell
    // "a session for this task existed before this process" apart from
    // "first ever create" — that discrimination arrives with the
    // restart-reconcile wave — so for now: resume ?? create.
    const fn = provider.resume ?? provider.create;
    return fn.call(provider, task, ctx);
  })();

  sessions.set(task.id, promise);
  promise.catch(() => {
    sessions.delete(task.id);
  });
  return promise;
}

/** Drop the cached session. `destroy: true` also tears down remote compute. */
export async function releaseSession(taskId: string, opts?: { destroy?: boolean }): Promise<void> {
  const promise = sessions.get(taskId);
  if (!promise) return;
  sessions.delete(taskId);
  const session = await promise;
  await session.dispose(opts);
}

/** Test-only: clear the cache without disposing. */
export function _resetSessions(): void {
  sessions.clear();
}
