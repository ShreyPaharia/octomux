/**
 * Deliberate asymmetry: `registerWorkflow` has NO redefinition guard, while
 * providers (`server/integrations/registry.ts`) and harnesses
 * (`server/harnesses/registry.ts`) both warn-and-keep-first on a duplicate.
 *
 * `server/workflows/presets.ts` calls `registerWorkflow` on kinds that are
 * ALREADY registered, on purpose, to overlay preset metadata onto the code
 * handler (two call sites, ~line 195 and ~line 218) — and `reloadPresets()`
 * re-runs that overlay on every UI kind write. A duplicate guard here would
 * make `Map.set` a no-op on the second call and silently break kind editing.
 * Do NOT "fix" this to match the other two registries.
 *
 * Plugins don't get this door: `registerPluginWorkflow` below is the only path
 * a plugin uses, and it rejects outright (throws) rather than warn-and-ignore.
 * That's fine here because the failure is a plugin's own programming error at
 * registration time (unqualified id, or squatting a core kind) — a bug for the
 * plugin author to fix before their plugin ships, not a boot-time upgrade
 * hazard for an already-running server. Core code path (`presets.ts`)
 * stays warn-free because it's the trusted, expected-duplicate case.
 */
import { QUALIFIED_KIND_RE } from '../plugins/qualify.js';
import { childLogger } from '../logger.js';
import type { WorkflowType } from './types.js';

const logger = childLogger('workflows/registry');

const workflows = new Map<string, WorkflowType>();

export function registerWorkflow(wf: WorkflowType): void {
  workflows.set(wf.kind, wf);
}

/**
 * Registration path for plugin-supplied workflows. `qualifiedKind` must be
 * `<pkg>:<local>` (see `qualify()`) — core kinds are always bare (no `:`), so
 * the one format check below rejects both an unqualified id AND any attempt to
 * register under a core kind's literal name in a single guard.
 *
 * The stored object's `kind` is overwritten with the qualified id rather than
 * trusted: a plugin declares a LOCAL kind and never sees the qualified form, so
 * `wf.kind` arrives bare. Storing it as-is would leave the map key and the
 * workflow's own `kind` disagreeing, and `getWorkflow()` callers read both.
 */
export function registerPluginWorkflow(qualifiedKind: string, wf: WorkflowType): void {
  if (!QUALIFIED_KIND_RE.test(qualifiedKind)) {
    throw new Error(
      `registerPluginWorkflow: "${qualifiedKind}" must be a qualified "<pkg>:<kind>" id (core kinds are never allowed here)`,
    );
  }
  workflows.set(qualifiedKind, { ...wf, kind: qualifiedKind });
}

/**
 * Removes one workflow kind. Refuses (logs a warn, no-op) on anything that
 * isn't a qualified `<pkg>:<kind>` id — every core, home, and built-in kind is
 * always bare, so this guard alone makes it structurally impossible for a
 * plugin unmount to delete a kind the UI still needs (ruling R4, plan
 * `2026-08-20-plugin-runtime-p0.md`). No duplicate-registration guard is
 * added here to match — see the module doc for why one would break kind
 * editing.
 */
export function unregisterWorkflow(kind: string): boolean {
  if (!QUALIFIED_KIND_RE.test(kind)) {
    logger.warn({ kind }, 'refusing to unregister a bare (core/home/built-in) workflow kind');
    return false;
  }
  return workflows.delete(kind);
}

export function getWorkflow(kind: string): WorkflowType | undefined {
  return workflows.get(kind);
}

export function listWorkflows(): WorkflowType[] {
  return Array.from(workflows.values());
}

/** Kinds with a cron trigger and a `run` handler — backs schedule creation and the poller. */
export function listCronWorkflowKinds(): string[] {
  return listWorkflows()
    .filter((w) => w.trigger?.kind === 'cron' && w.run)
    .map((w) => w.kind);
}
