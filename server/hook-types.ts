import type { Task } from './types.js';

export type HookEventName =
  | 'workflow_status_changed'
  | 'summary_updated'
  | 'note_added'
  | 'ref_added'
  | 'ref_removed'
  | 'task_created'
  | 'runtime_state_changed';

export interface HookEnvelope {
  event: HookEventName;
  /** Snapshot of the task at the time of the event. */
  task: Partial<Task>;
  /** Event-specific payload. */
  data?: Record<string, unknown>;
}
