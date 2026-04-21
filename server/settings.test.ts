import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSettings, updateSettings, DEFAULT_SETTINGS } from './settings.js';
import type { OctomuxSettings } from './settings.js';

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      promises: {
        ...actual.promises,
        readFile: vi.fn(),
        writeFile: vi.fn(),
        mkdir: vi.fn(),
      },
    },
    promises: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
    },
  };
});

import fs from 'fs';
const mockFs = vi.mocked(fs.promises);

describe('settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getSettings', () => {
    it('returns default settings when file does not exist', async () => {
      mockFs.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const settings = await getSettings();
      expect(settings).toEqual(DEFAULT_SETTINGS);
    });

    it('returns saved settings when file exists', async () => {
      const saved: OctomuxSettings = { editor: 'cursor', useOrchestratorAgent: false };
      mockFs.readFile.mockResolvedValue(JSON.stringify(saved));
      const settings = await getSettings();
      expect(settings).toEqual({ ...DEFAULT_SETTINGS, ...saved });
    });

    it('returns defaults merged with partial settings', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({}));
      const settings = await getSettings();
      expect(settings).toEqual(DEFAULT_SETTINGS);
    });
  });

  describe('updateSettings', () => {
    it('merges new settings with existing', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ editor: 'nvim' }));
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      const result = await updateSettings({ editor: 'vscode' });
      expect(result.editor).toBe('vscode');
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('settings.json'),
        JSON.stringify({ editor: 'vscode', useOrchestratorAgent: false }, null, 2),
        'utf-8',
      );
    });

    it('rejects invalid editor values', async () => {
      await expect(updateSettings({ editor: 'emacs' as any })).rejects.toThrow('Invalid editor');
    });
  });
});
