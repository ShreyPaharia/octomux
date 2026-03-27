import fs from 'fs';
import path from 'path';
import os from 'os';

export type EditorChoice = 'nvim' | 'vscode' | 'cursor';

export interface OctomuxSettings {
  editor: EditorChoice;
}

export const DEFAULT_SETTINGS: OctomuxSettings = {
  editor: 'nvim',
};

const VALID_EDITORS: EditorChoice[] = ['nvim', 'vscode', 'cursor'];

function settingsPath(): string {
  return path.join(os.homedir(), '.octomux', 'settings.json');
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

  const current = await getSettings();
  const merged = { ...current, ...patch };

  const filePath = settingsPath();
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(merged, null, 2), 'utf-8');

  return merged;
}
