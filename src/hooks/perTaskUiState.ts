export type TaskMode = 'agents' | 'editor' | 'diff' | 'info';

/** Per-task UI state preserved across task switches (session-only, not persisted to disk). */
export interface PerTaskUiState {
  activeWindow: number | null;
  mode: TaskMode;
}

const perTaskUiState = new Map<string, PerTaskUiState>();

export function getPerTaskUiState(taskId: string): PerTaskUiState | undefined {
  return perTaskUiState.get(taskId);
}

export function setPerTaskUiState(taskId: string, state: PerTaskUiState): void {
  perTaskUiState.set(taskId, state);
}

/** Reset per-task UI state — exposed for tests only. */
export function _resetPerTaskUiState(): void {
  perTaskUiState.clear();
}
