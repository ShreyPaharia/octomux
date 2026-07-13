import type { WorkflowType } from './types.js';

const workflows = new Map<string, WorkflowType>();

export function registerWorkflow(wf: WorkflowType): void {
  workflows.set(wf.kind, wf);
}

export function getWorkflow(kind: string): WorkflowType | undefined {
  return workflows.get(kind);
}

export function listWorkflows(): WorkflowType[] {
  return Array.from(workflows.values());
}
