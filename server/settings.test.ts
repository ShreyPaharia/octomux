import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('deleteGraceHours', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
  });

  describe('getSettings', () => {
    it('returns undefined for deleteGraceHours when field is absent from disk', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ editor: 'nvim', harnesses: {} }));
      const settings = await getSettings();
      expect(settings.deleteGraceHours).toBeUndefined();
    });

    it('returns the stored value when deleteGraceHours is present on disk', async () => {
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ editor: 'nvim', harnesses: {}, deleteGraceHours: 24 }),
      );
      const settings = await getSettings();
      expect(settings.deleteGraceHours).toBe(24);
    });
  });

  describe('updateSettings', () => {
    beforeEach(() => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(DEFAULT_SETTINGS));
    });

    it('persists deleteGraceHours: 24 and getSettings returns 24', async () => {
      const result = await updateSettings({ deleteGraceHours: 24 });
      expect(result.deleteGraceHours).toBe(24);
      const writtenJson = mockFs.writeFile.mock.calls[0][1] as string;
      const written = JSON.parse(writtenJson);
      expect(written.deleteGraceHours).toBe(24);
    });

    it('accepts deleteGraceHours: 0 (purge on next poller tick)', async () => {
      const result = await updateSettings({ deleteGraceHours: 0 });
      expect(result.deleteGraceHours).toBe(0);
    });

    it('leaves deleteGraceHours untouched when not in patch', async () => {
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ ...DEFAULT_SETTINGS, deleteGraceHours: 12 }),
      );
      const result = await updateSettings({ editor: 'vscode' });
      expect(result.deleteGraceHours).toBe(12);
    });

    it('rejects negative deleteGraceHours', async () => {
      await expect(updateSettings({ deleteGraceHours: -1 })).rejects.toThrow(
        /Invalid deleteGraceHours/,
      );
    });

    it('rejects NaN deleteGraceHours', async () => {
      await expect(updateSettings({ deleteGraceHours: NaN })).rejects.toThrow(
        /Invalid deleteGraceHours/,
      );
    });
  });
});

describe('OctomuxSettings tracker fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.readFile.mockResolvedValue(JSON.stringify(DEFAULT_SETTINGS));
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
  });

  it('round-trips defaultTracker and defaultLinearTeamKey', async () => {
    await updateSettings({ defaultTracker: 'linear', defaultLinearTeamKey: 'BAC' });
    const writtenJson = mockFs.writeFile.mock.calls[0][1] as string;
    mockFs.readFile.mockResolvedValue(writtenJson);
    const s = await getSettings();
    expect(s.defaultTracker).toBe('linear');
    expect(s.defaultLinearTeamKey).toBe('BAC');
  });

  it('preserves Jira defaults when only Linear fields are updated', async () => {
    await updateSettings({ defaultJiraBaseUrl: 'https://acme.atlassian.net' });
    const writtenJson1 = mockFs.writeFile.mock.calls[0][1] as string;
    mockFs.readFile.mockResolvedValue(writtenJson1);
    await updateSettings({ defaultTracker: 'linear' });
    const writtenJson2 = mockFs.writeFile.mock.calls[1][1] as string;
    mockFs.readFile.mockResolvedValue(writtenJson2);
    const s = await getSettings();
    expect(s.defaultJiraBaseUrl).toBe('https://acme.atlassian.net');
    expect(s.defaultTracker).toBe('linear');
  });

  it('rejects an invalid defaultTracker value', async () => {
    await expect(updateSettings({ defaultTracker: 'asana' as any })).rejects.toThrow(
      /defaultTracker/,
    );
  });
});
