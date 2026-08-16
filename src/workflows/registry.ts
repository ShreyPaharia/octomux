import type { WorkflowUI } from './types';

const workflowUIs = new Map<string, WorkflowUI>();

export function registerWorkflowUI(kind: string, ui: WorkflowUI): void {
  workflowUIs.set(kind, ui);
}

export function getWorkflowUI(kind: string): WorkflowUI | undefined {
  return workflowUIs.get(kind);
}

export function listWorkflowUIs(): Array<{ kind: string } & WorkflowUI> {
  return Array.from(workflowUIs.entries()).map(([kind, ui]) => ({ kind, ...ui }));
}
