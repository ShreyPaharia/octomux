import fs from 'fs';
import path from 'path';
import { childLogger } from './logger.js';
import { octomuxRoot } from './octomux-root.js';

const logger = childLogger('settings');

export type EditorChoice = 'nvim' | 'vscode' | 'cursor';

export type DefaultTracker = 'jira' | 'linear';

export interface OctomuxSettings {
  editor: EditorChoice;
  defaultHarnessId: string;
  harnesses: Record<string, Record<string, unknown>>;

  defaultTracker?: DefaultTracker;
  defaultJiraBaseUrl?: string;
  defaultJiraProjectKey?: string;
  defaultLinearTeamKey?: string;
  defaultBaseBranch?: string;
  onboardingCompletedAt?: string;

  /** Hours a soft-deleted task waits before permanent purge. Default 6 when absent. */
  deleteGraceHours?: number;

  /**
   * Per-card approval timeout (ms). Overridden by OCTOMUX_APPROVAL_TIMEOUT_MS.
   * Default 30 minutes (DEFAULT_APPROVAL_TIMEOUT_MS in orchestrator/approval-timeout.ts) when absent.
   */
  approvalTimeoutMs?: number;
  /**
   * Hook script / integration-provider handler timeout (ms). Overridden by
   * OCTOMUX_HOOK_TIMEOUT_MS. Default 30000 (hook-dispatcher.ts) when absent.
   */
  hookTimeoutMs?: number;
  /**
   * When true, task creation polishes an omitted title/description via the
   * Claude CLI. Overridden by OCTOMUX_AI_TASK_NAMING. Default false.
   */
  aiTaskNaming?: boolean;
  /**
   * KILL SWITCH for the capability registry's ask/always-ask gate
   * (server/orchestrator/mcp/gate.ts). When false, every `ask`/`always-ask`
   * MCP capability call (task.create/start/move/close/delete, ask_owner) runs
   * immediately with no card and no human decision — same as before this gate
   * existed. Overridden by OCTOMUX_CAPABILITY_GATE_ENABLED. Default true
   * (gating ON) when absent.
   */
  capabilityGateEnabled?: boolean;

  /** @deprecated promoted into harnesses['claude-code'] on next save */
  claudeFlags?: string;
  /** @deprecated */
  dangerouslySkipPermissions?: boolean;
}

/** A finite, positive number — the shape required of *TimeoutMs settings. */
function parsePositiveIntSetting(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export const DEFAULT_SETTINGS: OctomuxSettings = {
  editor: 'nvim',
  defaultHarnessId: 'claude-code',
  harnesses: {},
};

const VALID_EDITORS: EditorChoice[] = ['nvim', 'vscode', 'cursor'];

function settingsPath(): string {
  return path.join(octomuxRoot(), 'settings.json');
}

let _deprecatedWarnEmitted = false;

export async function getSettings(): Promise<OctomuxSettings> {
  let parsed: Record<string, unknown>;
  try {
    const raw = await fs.promises.readFile(settingsPath(), 'utf-8');
    parsed = JSON.parse(raw);
  } catch (err: any) {
    if (err.code === 'ENOENT') return { ...DEFAULT_SETTINGS };
    throw err;
  }

  const harnesses = (parsed.harnesses as Record<string, Record<string, unknown>>) ?? {};
  const cc = { ...(harnesses['claude-code'] ?? {}) };
  let deprecatedSeen = false;
  if (parsed.claudeFlags !== undefined && cc.flags === undefined) {
    cc.flags = parsed.claudeFlags;
    deprecatedSeen = true;
  }
  if (
    parsed.dangerouslySkipPermissions !== undefined &&
    cc.dangerouslySkipPermissions === undefined
  ) {
    cc.dangerouslySkipPermissions = parsed.dangerouslySkipPermissions;
    deprecatedSeen = true;
  }
  const mergedHarnesses: Record<string, Record<string, unknown>> = {
    ...harnesses,
    'claude-code': cc,
  };

  // Validate registered harnesses' blobs (drop invalid blob keys with a warn).
  const { listHarnesses } = await import('./harnesses/index.js');
  for (const h of listHarnesses()) {
    if (mergedHarnesses[h.id]) {
      try {
        mergedHarnesses[h.id] = h.validateSettings(mergedHarnesses[h.id]);
      } catch (err) {
        logger.warn(
          { harness: h.id, err: (err as Error).message },
          'invalid harness settings; ignoring blob',
        );
        delete mergedHarnesses[h.id];
      }
    }
  }

  if (deprecatedSeen && !_deprecatedWarnEmitted) {
    logger.warn(
      'settings.json contains deprecated top-level keys (claudeFlags, dangerouslySkipPermissions); they will be removed on next save',
    );
    _deprecatedWarnEmitted = true;
  }

  return {
    editor: (parsed.editor as EditorChoice) ?? DEFAULT_SETTINGS.editor,
    defaultHarnessId: (parsed.defaultHarnessId as string) ?? DEFAULT_SETTINGS.defaultHarnessId,
    harnesses: mergedHarnesses,
    defaultTracker:
      parsed.defaultTracker === 'jira' || parsed.defaultTracker === 'linear'
        ? parsed.defaultTracker
        : undefined,
    defaultJiraBaseUrl:
      typeof parsed.defaultJiraBaseUrl === 'string' ? parsed.defaultJiraBaseUrl : undefined,
    defaultJiraProjectKey:
      typeof parsed.defaultJiraProjectKey === 'string' ? parsed.defaultJiraProjectKey : undefined,
    defaultLinearTeamKey:
      typeof parsed.defaultLinearTeamKey === 'string' ? parsed.defaultLinearTeamKey : undefined,
    defaultBaseBranch:
      typeof parsed.defaultBaseBranch === 'string' ? parsed.defaultBaseBranch : undefined,
    onboardingCompletedAt:
      typeof parsed.onboardingCompletedAt === 'string' ? parsed.onboardingCompletedAt : undefined,
    deleteGraceHours:
      typeof parsed.deleteGraceHours === 'number' ? parsed.deleteGraceHours : undefined,
    approvalTimeoutMs: parsePositiveIntSetting(parsed.approvalTimeoutMs),
    hookTimeoutMs: parsePositiveIntSetting(parsed.hookTimeoutMs),
    aiTaskNaming: typeof parsed.aiTaskNaming === 'boolean' ? parsed.aiTaskNaming : undefined,
    capabilityGateEnabled:
      typeof parsed.capabilityGateEnabled === 'boolean' ? parsed.capabilityGateEnabled : undefined,
  };
}

/**
 * Synchronous, single-field read of the stored settings.json, for the
 * capability gate's kill switch (server/orchestrator/mcp/gate.ts), which —
 * like the approval-timeout sweep — resolves its setting synchronously from
 * the MCP subprocess and can't await getSettings(). Mirrors
 * getStoredApprovalTimeoutMs()'s shape for this field only.
 */
export function getStoredCapabilityGateEnabled(): boolean | undefined {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.capabilityGateEnabled === 'boolean'
      ? parsed.capabilityGateEnabled
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Synchronous, single-field read of the stored settings.json, for the one
 * caller (the approval-timeout sweep) that resolves its timeout as a
 * synchronous default-parameter expression and can't await getSettings().
 * Mirrors getSettings()'s parsing for this field only — no harness
 * validation, no promotion of deprecated keys.
 */
export function getStoredApprovalTimeoutMs(): number | undefined {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsePositiveIntSetting(parsed.approvalTimeoutMs);
  } catch {
    return undefined;
  }
}

export async function updateSettings(patch: Partial<OctomuxSettings>): Promise<OctomuxSettings> {
  if (patch.editor && !VALID_EDITORS.includes(patch.editor)) {
    throw new Error(`Invalid editor: ${patch.editor}. Must be one of: ${VALID_EDITORS.join(', ')}`);
  }

  if (patch.deleteGraceHours !== undefined) {
    if (!Number.isFinite(patch.deleteGraceHours) || patch.deleteGraceHours < 0) {
      throw new Error(
        `Invalid deleteGraceHours: ${patch.deleteGraceHours}. Must be a number >= 0.`,
      );
    }
  }

  if (
    patch.defaultTracker !== undefined &&
    patch.defaultTracker !== 'jira' &&
    patch.defaultTracker !== 'linear'
  ) {
    throw new Error(`Invalid defaultTracker: ${patch.defaultTracker}. Must be 'jira' or 'linear'.`);
  }

  if (
    patch.approvalTimeoutMs !== undefined &&
    parsePositiveIntSetting(patch.approvalTimeoutMs) === undefined
  ) {
    throw new Error(
      `Invalid approvalTimeoutMs: ${patch.approvalTimeoutMs}. Must be a positive number.`,
    );
  }

  if (
    patch.hookTimeoutMs !== undefined &&
    parsePositiveIntSetting(patch.hookTimeoutMs) === undefined
  ) {
    throw new Error(`Invalid hookTimeoutMs: ${patch.hookTimeoutMs}. Must be a positive number.`);
  }

  if (patch.aiTaskNaming !== undefined && typeof patch.aiTaskNaming !== 'boolean') {
    throw new Error(`Invalid aiTaskNaming: ${patch.aiTaskNaming}. Must be a boolean.`);
  }

  if (
    patch.capabilityGateEnabled !== undefined &&
    typeof patch.capabilityGateEnabled !== 'boolean'
  ) {
    throw new Error(
      `Invalid capabilityGateEnabled: ${patch.capabilityGateEnabled}. Must be a boolean.`,
    );
  }

  const current = await getSettings();
  const mergedHarnesses = { ...current.harnesses };
  const { listHarnesses, getHarness } = await import('./harnesses/index.js');

  if (patch.harnesses) {
    const registered = new Set(listHarnesses().map((h) => h.id));
    for (const [id, blob] of Object.entries(patch.harnesses)) {
      if (registered.has(id)) {
        mergedHarnesses[id] = getHarness(id).validateSettings(blob);
      } else {
        // Unknown harness blob — preserve verbatim, do not validate.
        mergedHarnesses[id] = blob;
      }
    }
  }

  if (patch.claudeFlags !== undefined || patch.dangerouslySkipPermissions !== undefined) {
    const prev = mergedHarnesses['claude-code'] ?? {};
    const candidate = { ...prev } as Record<string, unknown>;
    if (patch.claudeFlags !== undefined) {
      candidate.flags = patch.claudeFlags;
    }
    if (patch.dangerouslySkipPermissions !== undefined) {
      candidate.dangerouslySkipPermissions = patch.dangerouslySkipPermissions;
    }
    mergedHarnesses['claude-code'] = getHarness('claude-code').validateSettings(candidate);
  }

  const merged: OctomuxSettings = {
    editor: patch.editor ?? current.editor,
    defaultHarnessId: patch.defaultHarnessId ?? current.defaultHarnessId,
    harnesses: mergedHarnesses,
    defaultTracker:
      patch.defaultTracker !== undefined ? patch.defaultTracker : current.defaultTracker,
    defaultJiraBaseUrl:
      patch.defaultJiraBaseUrl !== undefined
        ? patch.defaultJiraBaseUrl
        : current.defaultJiraBaseUrl,
    defaultJiraProjectKey:
      patch.defaultJiraProjectKey !== undefined
        ? patch.defaultJiraProjectKey
        : current.defaultJiraProjectKey,
    defaultLinearTeamKey:
      patch.defaultLinearTeamKey !== undefined
        ? patch.defaultLinearTeamKey
        : current.defaultLinearTeamKey,
    defaultBaseBranch:
      patch.defaultBaseBranch !== undefined ? patch.defaultBaseBranch : current.defaultBaseBranch,
    onboardingCompletedAt:
      patch.onboardingCompletedAt !== undefined
        ? patch.onboardingCompletedAt
        : current.onboardingCompletedAt,
    deleteGraceHours:
      patch.deleteGraceHours !== undefined ? patch.deleteGraceHours : current.deleteGraceHours,
    approvalTimeoutMs:
      patch.approvalTimeoutMs !== undefined ? patch.approvalTimeoutMs : current.approvalTimeoutMs,
    hookTimeoutMs: patch.hookTimeoutMs !== undefined ? patch.hookTimeoutMs : current.hookTimeoutMs,
    aiTaskNaming: patch.aiTaskNaming !== undefined ? patch.aiTaskNaming : current.aiTaskNaming,
    capabilityGateEnabled:
      patch.capabilityGateEnabled !== undefined
        ? patch.capabilityGateEnabled
        : current.capabilityGateEnabled,
  };

  const filePath = settingsPath();
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

/**
 * @deprecated use claudeCodeHarness.resolveFlags instead.
 * Kept until Tasks 14-17 update the callers (task-runner.ts, chats.ts).
 *
 * Reads flags from the new harnesses['claude-code'] sub-object. Falls back
 * gracefully to an empty string for settings that have neither key set.
 */
export function resolveClaudeFlags(settings: OctomuxSettings): string {
  const envFlagsRaw = process.env.OCTOMUX_CLAUDE_FLAGS?.trim();
  if (envFlagsRaw) return ` ${envFlagsRaw}`;

  const sub = (settings.harnesses?.['claude-code'] ?? {}) as {
    flags?: string;
    dangerouslySkipPermissions?: boolean;
  };

  const parts: string[] = [];
  if (sub.dangerouslySkipPermissions) parts.push('--dangerously-skip-permissions');
  const trimmed = (sub.flags ?? '').trim();
  if (trimmed) parts.push(trimmed);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}
