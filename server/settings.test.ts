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

// Mock the harnesses index so tests don't depend on the full harness chain.
vi.mock('./harnesses/index.js', () => ({
  listHarnesses: vi.fn(() => [
    {
      id: 'claude-code',
      validateSettings: vi.fn((blob: unknown) => {
        // Simple pass-through: accept objects with optional flags (string) and
        // dangerouslySkipPermissions (boolean); reject otherwise.
        if (typeof blob !== 'object' || blob === null || Array.isArray(blob)) {
          throw new Error('Invalid claude-code settings: expected object');
        }
        const obj = blob as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        if (obj.flags !== undefined) {
          if (typeof obj.flags !== 'string')
            throw new Error('Invalid harnesses.claude-code.flags: must be a string');
          const trimmed = (obj.flags as string).trim();
          if (/[`;|&><\n\r]|\$\(/.test(trimmed))
            throw new Error(
              'Invalid harnesses.claude-code.flags: contains forbidden shell metacharacter',
            );
          out.flags = trimmed;
        }
        if (obj.dangerouslySkipPermissions !== undefined) {
          if (typeof obj.dangerouslySkipPermissions !== 'boolean') {
            throw new Error('Invalid claude-code.dangerouslySkipPermissions: expected boolean');
          }
          out.dangerouslySkipPermissions = obj.dangerouslySkipPermissions;
        }
        return out;
      }),
    },
  ]),
  getHarness: vi.fn((id: string) => {
    if (id === 'claude-code') {
      return {
        validateSettings: vi.fn((blob: unknown) => {
          if (typeof blob !== 'object' || blob === null || Array.isArray(blob)) {
            throw new Error('Invalid claude-code settings: expected object');
          }
          const obj = blob as Record<string, unknown>;
          const out: Record<string, unknown> = {};
          if (obj.flags !== undefined) {
            if (typeof obj.flags !== 'string')
              throw new Error('Invalid harnesses.claude-code.flags: must be a string');
            const trimmed = (obj.flags as string).trim();
            if (/[`;|&><\n\r]|\$\(/.test(trimmed))
              throw new Error(
                'Invalid harnesses.claude-code.flags: contains forbidden shell metacharacter',
              );
            out.flags = trimmed;
          }
          if (obj.dangerouslySkipPermissions !== undefined) {
            if (typeof obj.dangerouslySkipPermissions !== 'boolean') {
              throw new Error('Invalid claude-code.dangerouslySkipPermissions: expected boolean');
            }
            out.dangerouslySkipPermissions = obj.dangerouslySkipPermissions;
          }
          return out;
        }),
      };
    }
    throw new Error(`Unknown harness: ${id}`);
  }),
}));

import fs from 'fs';
const mockFs = vi.mocked(fs.promises);

describe('settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('DEFAULT_SETTINGS', () => {
    it('has expected shape', () => {
      expect(DEFAULT_SETTINGS.editor).toBe('nvim');
      expect(DEFAULT_SETTINGS.defaultHarnessId).toBe('claude-code');
      expect(DEFAULT_SETTINGS.harnesses).toEqual({});
    });
  });

  describe('getSettings', () => {
    it('returns default settings when file does not exist', async () => {
      mockFs.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      const settings = await getSettings();
      expect(settings).toEqual(DEFAULT_SETTINGS);
    });

    it('returns saved editor when file exists', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ editor: 'cursor', harnesses: {} }));
      const settings = await getSettings();
      expect(settings.editor).toBe('cursor');
    });

    it('returns defaults merged with partial settings', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({}));
      const settings = await getSettings();
      expect(settings.editor).toBe('nvim');
      expect(settings.defaultHarnessId).toBe('claude-code');
    });

    it('promotes legacy claudeFlags into harnesses["claude-code"]', async () => {
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ claudeFlags: '--verbose', dangerouslySkipPermissions: true }),
      );
      const s = await getSettings();
      expect(s.harnesses['claude-code']).toEqual({
        flags: '--verbose',
        dangerouslySkipPermissions: true,
      });
    });

    it('preserves unknown harness blobs verbatim', async () => {
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ harnesses: { cursor: { flags: '--model x' } } }),
      );
      const s = await getSettings();
      expect(s.harnesses['cursor']).toEqual({ flags: '--model x' });
    });

    it('does not overwrite existing harnesses["claude-code"] values with legacy keys', async () => {
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({
          claudeFlags: '--old',
          harnesses: { 'claude-code': { flags: '--new' } },
        }),
      );
      const s = await getSettings();
      // existing value wins over deprecated key
      expect(s.harnesses['claude-code'].flags).toBe('--new');
    });
  });

  describe('updateSettings', () => {
    beforeEach(() => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(DEFAULT_SETTINGS));
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);
    });

    it('merges new editor with existing', async () => {
      const result = await updateSettings({ editor: 'vscode' });
      expect(result.editor).toBe('vscode');
    });

    it('rejects invalid editor values', async () => {
      await expect(updateSettings({ editor: 'emacs' as any })).rejects.toThrow('Invalid editor');
    });

    it('saves to settings.json path', async () => {
      await updateSettings({ editor: 'vscode' });
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('settings.json'),
        expect.any(String),
        'utf-8',
      );
    });

    it('strips deprecated top-level keys on save', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ claudeFlags: '--verbose' }));
      await updateSettings({ editor: 'vscode' });
      const writtenJson = mockFs.writeFile.mock.calls[0][1] as string;
      const written = JSON.parse(writtenJson);
      expect(written.claudeFlags).toBeUndefined();
      expect(written.harnesses['claude-code'].flags).toBe('--verbose');
    });

    it('writes harnesses sub-settings when provided', async () => {
      await updateSettings({ harnesses: { 'claude-code': { dangerouslySkipPermissions: true } } });
      const writtenJson = mockFs.writeFile.mock.calls[0][1] as string;
      const written = JSON.parse(writtenJson);
      expect(written.harnesses['claude-code'].dangerouslySkipPermissions).toBe(true);
    });

    it('merges PATCH dangerouslySkipPermissions into harnesses.claude-code', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ harnesses: {} }));
      await updateSettings({ dangerouslySkipPermissions: true });
      const writtenJson = mockFs.writeFile.mock.calls[0][1] as string;
      const written = JSON.parse(writtenJson);
      expect(written.harnesses['claude-code'].dangerouslySkipPermissions).toBe(true);
    });

    it('merges PATCH claudeFlags into harnesses.claude-code', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ harnesses: {} }));
      await updateSettings({ claudeFlags: '--verbose' });
      const writtenJson = mockFs.writeFile.mock.calls[0][1] as string;
      const written = JSON.parse(writtenJson);
      expect(written.harnesses['claude-code'].flags).toBe('--verbose');
    });

    it('rejects malicious flags via validateSettings', async () => {
      await expect(
        updateSettings({ harnesses: { 'claude-code': { flags: '`whoami`' } } }),
      ).rejects.toThrow(/Invalid/);
    });

    it('preserves unknown harness blobs verbatim on update', async () => {
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ harnesses: { unknown: { custom: 'value' } } }),
      );
      await updateSettings({ editor: 'cursor' });
      const writtenJson = mockFs.writeFile.mock.calls[0][1] as string;
      const written = JSON.parse(writtenJson);
      // unknown harness is preserved but not in the update patch — it comes from current
      expect(written.harnesses['unknown']).toEqual({ custom: 'value' });
    });

    it('roundtrips harnesses settings through write', async () => {
      const result = await updateSettings({
        harnesses: { 'claude-code': { dangerouslySkipPermissions: true, flags: '--model opus' } },
      });
      expect(result.harnesses['claude-code']).toEqual({
        dangerouslySkipPermissions: true,
        flags: '--model opus',
      });
    });
  });
});

describe('resolveClaudeFlags', () => {
  afterEach(() => {
    delete process.env.OCTOMUX_CLAUDE_FLAGS;
  });

  it('returns empty string when nothing configured', () => {
    const settings: OctomuxSettings = { ...DEFAULT_SETTINGS };
    expect(resolveClaudeFlags(settings)).toBe('');
  });

  it('prefixes with a single space when dangerouslySkipPermissions is set in harness', () => {
    const settings: OctomuxSettings = {
      ...DEFAULT_SETTINGS,
      harnesses: { 'claude-code': { dangerouslySkipPermissions: true } },
    };
    expect(resolveClaudeFlags(settings)).toBe(' --dangerously-skip-permissions');
  });

  it('composes dangerouslySkipPermissions before flags', () => {
    const settings: OctomuxSettings = {
      ...DEFAULT_SETTINGS,
      harnesses: { 'claude-code': { dangerouslySkipPermissions: true, flags: '--model opus' } },
    };
    expect(resolveClaudeFlags(settings)).toBe(' --dangerously-skip-permissions --model opus');
  });

  it('appends only flags when dangerouslySkipPermissions is false', () => {
    const settings: OctomuxSettings = {
      ...DEFAULT_SETTINGS,
      harnesses: { 'claude-code': { flags: '--model opus' } },
    };
    expect(resolveClaudeFlags(settings)).toBe(' --model opus');
  });

  it('uses OCTOMUX_CLAUDE_FLAGS env var verbatim when set', () => {
    process.env.OCTOMUX_CLAUDE_FLAGS = '--env-only';
    const settings: OctomuxSettings = {
      ...DEFAULT_SETTINGS,
      harnesses: { 'claude-code': { dangerouslySkipPermissions: true, flags: '--from-settings' } },
    };
    expect(resolveClaudeFlags(settings)).toBe(' --env-only');
  });

  it('treats whitespace-only env var as unset', () => {
    process.env.OCTOMUX_CLAUDE_FLAGS = '   ';
    const settings: OctomuxSettings = {
      ...DEFAULT_SETTINGS,
      harnesses: { 'claude-code': { flags: '--from-settings' } },
    };
    expect(resolveClaudeFlags(settings)).toBe(' --from-settings');
  });
});
