/**
 * server/services/session-vertical-service.ts
 *
 * Thin wrapper around `runAgentSession` for headless workflow verticals: fixed
 * to the default harness + pty substrate, cron-triggered, with a `runs` row
 * persisted per call. Verticals (e.g. overnight-log-summary) build the prompt
 * and outputSchema, then call this instead of driving runAgentSession directly.
 */
import { runAgentSession } from '../agent-session/session.js';
import { ptySubstrate } from '../agent-session/substrate-pty.js';
import { getHarness } from '../harnesses/registry.js';

export interface RunSessionVerticalInput {
  kind: string;
  scheduleId?: string | null;
  workspaceDir: string;
  input: string;
  outputSchema: object;
  model?: string | null;
  timeoutMs?: number | null;
  trigger?: 'cron' | 'manual';
}

export async function runSessionVertical<T = unknown>(
  i: RunSessionVerticalInput,
): Promise<{ result: T }> {
  return runAgentSession<T>({
    workspaceDir: i.workspaceDir,
    harness: getHarness(null),
    input: i.input,
    substrate: ptySubstrate,
    outputSchema: i.outputSchema,
    model: i.model ?? null,
    timeoutMs: i.timeoutMs ?? undefined,
    run: {
      workflowKind: i.kind,
      trigger: i.trigger ?? 'cron',
      scheduleId: i.scheduleId ?? undefined,
    },
  });
}
