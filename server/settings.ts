import fs from 'fs';
import path from 'path';
import os from 'os';
import { childLogger } from './logger.js';

const logger = childLogger('settings');

export type EditorChoice = 'nvim' | 'vscode' | 'cursor';

export interface OctomuxSettings {
  editor: EditorChoice;
  defaultHarnessId: string;
  harnesses: Record<string, Record<string, unknown>>;

  /** @deprecated promoted into harnesses['claude-code'] on next save */
  claudeFlags?: string;
  /** @deprecated */
  dangerouslySkipPermissions?: boolean;
}

export const DEFAULT_SETTINGS: OctomuxSettings = {
  editor: 'nvim',
  defaultHarnessId: 'claude-code',
  harnesses: {},
};

const VALID_EDITORS: EditorChoice[] = ['nvim', 'vscode', 'cursor'];

function settingsPath(): string {
  return path.join(os.homedir(), '.octomux', 'settings.json');
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
  const mergedHarnesses = { ...harnesses, 'claude-code': cc };

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
  };
}

export async function updateSettings(patch: Partial<OctomuxSettings>): Promise<OctomuxSettings> {
  if (patch.editor && !VALID_EDITORS.includes(patch.editor)) {
    throw new Error(`Invalid editor: ${patch.editor}. Must be one of: ${VALID_EDITORS.join(', ')}`);
  }

  const current = await getSettings();
  const mergedHarnesses = { ...current.harnesses };
  if (patch.harnesses) {
    const { listHarnesses, getHarness } = await import('./harnesses/index.js');
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

  const merged: OctomuxSettings = {
    editor: patch.editor ?? current.editor,
    defaultHarnessId: patch.defaultHarnessId ?? current.defaultHarnessId,
    harnesses: mergedHarnesses,
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
