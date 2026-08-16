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
  // Side-effect only: the barrel is what actually registers claude-code and
  // cursor into the bare registry above. Importing only `registry.js` left it
  // permanently empty unless some other module happened to load the barrel
  // first — `getHarness(null)` would then throw "Unknown harness: claude-code".
  // Best-effort: harmless to skip (e.g. under a test mock that stubs the bare
  // registry directly) since the barrel would have nothing new to add there.
  try {
    await import('../harnesses/index.js');
  } catch {
    /* barrel unavailable — registry.js above still has whatever registered */
  }
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
