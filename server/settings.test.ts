import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getSettings, updateSettings, resolveClaudeFlags, DEFAULT_SETTINGS } from './settings.js';
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

  describe('DEFAULT_SETTINGS', () => {
    it('has expected defaults for new flag-related fields', () => {
      expect(DEFAULT_SETTINGS.dangerouslySkipPermissions).toBe(false);
      expect(DEFAULT_SETTINGS.claudeFlags).toBe('');
    });
  });

  describe('getSettings', () => {
    it('returns default settings when file does not exist', async () => {
      mockFs.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const settings = await getSettings();
      expect(settings).toEqual(DEFAULT_SETTINGS);
    });

    it('returns saved settings when file exists', async () => {
      const saved: OctomuxSettings = {
        editor: 'cursor',
        useOrchestratorAgent: false,
        dangerouslySkipPermissions: true,
        claudeFlags: '--model opus',
      };
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
    beforeEach(() => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(DEFAULT_SETTINGS));
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);
    });

    it('merges new settings with existing', async () => {
      const result = await updateSettings({ editor: 'vscode' });
      expect(result.editor).toBe('vscode');
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('settings.json'),
        JSON.stringify({ ...DEFAULT_SETTINGS, editor: 'vscode' }, null, 2),
        'utf-8',
      );
    });

    it('rejects invalid editor values', async () => {
      await expect(updateSettings({ editor: 'emacs' as any })).rejects.toThrow('Invalid editor');
    });

    it('persists dangerouslySkipPermissions toggle', async () => {
      const result = await updateSettings({ dangerouslySkipPermissions: true });
      expect(result.dangerouslySkipPermissions).toBe(true);
    });

    it('trims claudeFlags on save', async () => {
      const result = await updateSettings({ claudeFlags: '  --model opus   ' });
      expect(result.claudeFlags).toBe('--model opus');
    });

    const invalidFlagCases = [
      { name: 'backticks', value: '--foo `whoami`' },
      { name: 'command substitution', value: '--foo $(rm -rf /)' },
      { name: 'unbalanced single quote', value: "--foo 'bar" },
      { name: 'unbalanced double quote', value: '--foo "bar' },
      { name: 'not a string', value: 42 as any },
    ];

    it.each(invalidFlagCases)('rejects claudeFlags with $name', async ({ value }) => {
      await expect(updateSettings({ claudeFlags: value })).rejects.toThrow('Invalid claudeFlags');
    });

    it('roundtrips settings through write+read', async () => {
      const result = await updateSettings({
        dangerouslySkipPermissions: true,
        claudeFlags: '--model opus',
      });
      expect(result).toEqual({
        ...DEFAULT_SETTINGS,
        dangerouslySkipPermissions: true,
        claudeFlags: '--model opus',
      });
      const writtenJson = mockFs.writeFile.mock.calls[0][1] as string;
      expect(JSON.parse(writtenJson)).toEqual(result);
    });
  });
});

describe('resolveClaudeFlags', () => {
  const baseSettings: OctomuxSettings = { ...DEFAULT_SETTINGS };

  afterEach(() => {
    delete process.env.OCTOMUX_CLAUDE_FLAGS;
  });

  it('returns empty string when nothing configured', () => {
    expect(resolveClaudeFlags(baseSettings)).toBe('');
  });

  it('prefixes with a single space when flags present', () => {
    expect(resolveClaudeFlags({ ...baseSettings, dangerouslySkipPermissions: true })).toBe(
      ' --dangerously-skip-permissions',
    );
  });

  it('composes dangerouslySkipPermissions before claudeFlags', () => {
    expect(
      resolveClaudeFlags({
        ...baseSettings,
        dangerouslySkipPermissions: true,
        claudeFlags: '--model opus',
      }),
    ).toBe(' --dangerously-skip-permissions --model opus');
  });

  it('appends only claudeFlags when dangerouslySkipPermissions is false', () => {
    expect(resolveClaudeFlags({ ...baseSettings, claudeFlags: '--model opus' })).toBe(
      ' --model opus',
    );
  });

  it('uses OCTOMUX_CLAUDE_FLAGS env var verbatim when set', () => {
    process.env.OCTOMUX_CLAUDE_FLAGS = '--env-only';
    expect(
      resolveClaudeFlags({
        ...baseSettings,
        dangerouslySkipPermissions: true,
        claudeFlags: '--from-settings',
      }),
    ).toBe(' --env-only');
  });

  it('treats whitespace-only env var as unset', () => {
    process.env.OCTOMUX_CLAUDE_FLAGS = '   ';
    expect(resolveClaudeFlags({ ...baseSettings, claudeFlags: '--from-settings' })).toBe(
      ' --from-settings',
    );
  });
});
