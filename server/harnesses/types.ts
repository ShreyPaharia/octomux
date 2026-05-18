// server/harnesses/types.ts
import type { OctomuxSettings } from '../settings.js';

const AGENT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FLAG_FORBIDDEN_RE = /[`;|&><\n\r]|\$\(/;

/**
 * Validate a custom agent name. Returns the input unchanged if valid;
 * throws with a stable message otherwise. Used at the API boundary AND in
 * harness implementations (defense in depth).
 */
export function validateAgentName(name: string): string {
  if (!AGENT_NAME_RE.test(name)) {
    throw new Error(`Invalid agent name: ${JSON.stringify(name)}. Must match ${AGENT_NAME_RE}`);
  }
  return name;
}

/**
 * Validate a flag string for shell-injection metacharacters. Reuses the
 * existing rules from `server/settings.ts::validateClaudeFlags` and adds
 * `;`, `|`, `&`, `>`, `<`, `\n`, `\r`.
 */
export function validateFlagString(flags: string, fieldName: string): string {
  if (typeof flags !== 'string') {
    throw new Error(`Invalid ${fieldName}: must be a string`);
  }
  const trimmed = flags.trim();
  if (FLAG_FORBIDDEN_RE.test(trimmed)) {
    throw new Error(
      `Invalid ${fieldName}: contains forbidden shell metacharacter (one of \` ; | & > < $( or newline)`,
    );
  }
  const singleQuotes = (trimmed.match(/'/g) ?? []).length;
  const doubleQuotes = (trimmed.match(/"/g) ?? []).length;
  if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) {
    throw new Error(`Invalid ${fieldName}: unbalanced quotes`);
  }
  return trimmed;
}

export interface HarnessLaunchOpts {
  sessionId: string;
  agent?: string | null;
  flags?: string;
}

export interface HarnessResumeOpts {
  sessionId: string;
  flags?: string;
}

export interface Harness {
  readonly id: string;
  readonly displayName: string;
  readonly sessionIdMode: 'orchestrator-assigned' | 'harness-issued';

  newSessionId(): string;
  buildLaunchCommand(opts: HarnessLaunchOpts): string;
  buildResumeCommand(opts: HarnessResumeOpts): string;
  buildContinueCommand(opts: HarnessResumeOpts): string | null;
  installHooks(worktreePath: string, baseUrl: string, hookToken: string): Promise<void>;
  syncAgents(worktreePath: string): Promise<void>;
  resolveFlags(settings: OctomuxSettings): string;
  validateSettings(blob: unknown): Record<string, unknown>;
  validateAgentName(name: string): string;
}
