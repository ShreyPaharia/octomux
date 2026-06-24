/**
 * Pure localStorage helpers for the review diff-tree's per-task persisted state.
 *
 * Extracted out of `DiffFileTree.tsx` so non-review consumers (the sidebar's
 * task-delete cleanup, BoardCard, TaskDetail) can drop stale keys without
 * dragging the whole review-diff component into their import graph.
 */

export function ignoredGroupKey(taskId: string): string {
  return `octomux:diff-ignored-open:${taskId}`;
}

export function diffTreeExpandedKey(taskId: string): string {
  return `octomux:diff-tree-expanded:${taskId}`;
}

/**
 * Read the persisted folder open-state overrides for a task. Returns a map of
 * folder path → open/closed; absent folders fall back to the default behaviour.
 * Returns `{}` when nothing is stored, the value is malformed, or localStorage
 * is unavailable (SSR, privacy mode, etc.).
 */
export function loadExpandedState(taskId: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(diffTreeExpandedKey(taskId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'boolean') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveExpandedState(taskId: string, state: Record<string, boolean>): void {
  try {
    localStorage.setItem(diffTreeExpandedKey(taskId), JSON.stringify(state));
  } catch {
    // ignore — persistence is best-effort
  }
}

/** Best-effort cleanup of a task's persisted diff-tree state (e.g. on delete). */
export function clearDiffTreeExpandedState(taskId: string): void {
  try {
    localStorage.removeItem(diffTreeExpandedKey(taskId));
    localStorage.removeItem(ignoredGroupKey(taskId));
  } catch {
    // ignore — stale keys are harmless
  }
}
