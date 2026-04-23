import fs from 'fs';
import path from 'path';
import os from 'os';

export type EditorChoice = 'nvim' | 'vscode' | 'cursor';

export interface OctomuxSettings {
  editor: EditorChoice;
  useOrchestratorAgent: boolean;
  dangerouslySkipPermissions: boolean;
  claudeFlags: string;
}

export const DEFAULT_SETTINGS: OctomuxSettings = {
  editor: 'nvim',
  useOrchestratorAgent: false,
  dangerouslySkipPermissions: false,
  claudeFlags: '',
};

const VALID_EDITORS: EditorChoice[] = ['nvim', 'vscode', 'cursor'];

function settingsPath(): string {
  return path.join(os.homedir(), '.octomux', 'settings.json');
}

function validateClaudeFlags(flags: unknown): string {
  if (typeof flags !== 'string') {
    throw new Error('Invalid claudeFlags: must be a string');
  }
  const trimmed = flags.trim();
  if (trimmed.includes('`')) {
    throw new Error('Invalid claudeFlags: backticks are not allowed');
  }
  if (trimmed.includes('$(')) {
    throw new Error('Invalid claudeFlags: $(...) command substitution is not allowed');
  }
  const singleQuotes = (trimmed.match(/'/g) || []).length;
  const doubleQuotes = (trimmed.match(/"/g) || []).length;
  if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) {
    throw new Error('Invalid claudeFlags: unbalanced quotes');
  }
  return trimmed;
}

export async function getSettings(): Promise<OctomuxSettings> {
  try {
    const raw = await fs.promises.readFile(settingsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (err: any) {
    if (err.code === 'ENOENT') return { ...DEFAULT_SETTINGS };
    throw err;
  }
}

export async function updateSettings(patch: Partial<OctomuxSettings>): Promise<OctomuxSettings> {
  if (patch.editor && !VALID_EDITORS.includes(patch.editor)) {
    throw new Error(`Invalid editor: ${patch.editor}. Must be one of: ${VALID_EDITORS.join(', ')}`);
  }

  let normalizedFlags: string | undefined;
  if (patch.claudeFlags !== undefined) {
    normalizedFlags = validateClaudeFlags(patch.claudeFlags);
  }

  const current = await getSettings();
  const merged: OctomuxSettings = {
    ...current,
    ...patch,
    ...(normalizedFlags !== undefined ? { claudeFlags: normalizedFlags } : {}),
  };

  const filePath = settingsPath();
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(merged, null, 2), 'utf-8');

  return merged;
}

/**
 * Compose the claude launch flag string. Precedence:
 *   1. `OCTOMUX_CLAUDE_FLAGS` env var (verbatim), if set.
 *   2. Settings composition: dangerouslySkipPermissions toggle + trimmed claudeFlags.
 *
 * Returns a string with a leading space, or '' when no flags apply. The leading
 * space lets callers append the result directly to the base claude command.
 */
export function resolveClaudeFlags(settings: OctomuxSettings): string {
  const envFlags = process.env.OCTOMUX_CLAUDE_FLAGS?.trim();
  if (envFlags) return ` ${envFlags}`;

  const parts: string[] = [];
  if (settings.dangerouslySkipPermissions) parts.push('--dangerously-skip-permissions');
  const trimmed = settings.claudeFlags.trim();
  if (trimmed) parts.push(trimmed);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}
