import { describe, it, expect, vi, beforeEach, afterEach } from './bun-test.js';

// Mock fs
vi.mock('fs', () => {
  const actual = vi.importActual<typeof import('fs')>('fs');
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

const {
  getSettings,
  updateSettings,
  getPluginSettings,
  updatePluginSettings,
  getStoredApprovalTimeoutMs,
  getStoredCapabilityGateEnabled,
  DEFAULT_SETTINGS,
} = await import('./settings.js');
const { default: fs } = await import('fs');

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
      expect(DEFAULT_SETTINGS.plugins).toEqual({});
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

describe('approvalTimeoutMs / hookTimeoutMs / aiTaskNaming settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
  });

  describe('getSettings', () => {
    it.each([
      ['approvalTimeoutMs', 90000, 90000],
      ['approvalTimeoutMs', -1, undefined],
      ['approvalTimeoutMs', 0, undefined],
      ['approvalTimeoutMs', 'not-a-number', undefined],
      ['hookTimeoutMs', 60000, 60000],
      ['hookTimeoutMs', -1, undefined],
      ['hookTimeoutMs', 'nope', undefined],
    ])('parses stored %s = %p as %p', async (key, stored, expected) => {
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ editor: 'nvim', harnesses: {}, [key]: stored }),
      );
      const settings = await getSettings();
      expect((settings as any)[key]).toBe(expected);
    });

    it.each([
      [true, true],
      [false, false],
      ['yes', undefined],
      [1, undefined],
    ])('parses stored aiTaskNaming = %p as %p', async (stored, expected) => {
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ editor: 'nvim', harnesses: {}, aiTaskNaming: stored }),
      );
      const settings = await getSettings();
      expect(settings.aiTaskNaming).toBe(expected);
    });

    it('returns undefined for all three when absent from disk', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ editor: 'nvim', harnesses: {} }));
      const settings = await getSettings();
      expect(settings.approvalTimeoutMs).toBeUndefined();
      expect(settings.hookTimeoutMs).toBeUndefined();
      expect(settings.aiTaskNaming).toBeUndefined();
    });
  });

  describe('updateSettings', () => {
    beforeEach(() => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(DEFAULT_SETTINGS));
    });

    it('persists approvalTimeoutMs and hookTimeoutMs and round-trips them', async () => {
      const result = await updateSettings({ approvalTimeoutMs: 90000, hookTimeoutMs: 60000 });
      expect(result.approvalTimeoutMs).toBe(90000);
      expect(result.hookTimeoutMs).toBe(60000);
      const writtenJson = mockFs.writeFile.mock.calls[0][1] as string;
      const written = JSON.parse(writtenJson);
      expect(written.approvalTimeoutMs).toBe(90000);
      expect(written.hookTimeoutMs).toBe(60000);
    });

    it('persists aiTaskNaming: true', async () => {
      const result = await updateSettings({ aiTaskNaming: true });
      expect(result.aiTaskNaming).toBe(true);
    });

    it.each([
      ['approvalTimeoutMs', 0],
      ['approvalTimeoutMs', -5],
      ['approvalTimeoutMs', NaN],
      ['hookTimeoutMs', 0],
      ['hookTimeoutMs', -5],
    ])('rejects invalid %s = %p', async (key, value) => {
      await expect(updateSettings({ [key]: value } as any)).rejects.toThrow(
        new RegExp(`Invalid ${key}`),
      );
    });

    it('rejects a non-boolean aiTaskNaming', async () => {
      await expect(updateSettings({ aiTaskNaming: 'yes' as any })).rejects.toThrow(
        /Invalid aiTaskNaming/,
      );
    });

    it('leaves the three fields untouched when not in patch', async () => {
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({
          ...DEFAULT_SETTINGS,
          approvalTimeoutMs: 90000,
          hookTimeoutMs: 60000,
          aiTaskNaming: true,
        }),
      );
      const result = await updateSettings({ editor: 'vscode' });
      expect(result.approvalTimeoutMs).toBe(90000);
      expect(result.hookTimeoutMs).toBe(60000);
      expect(result.aiTaskNaming).toBe(true);
    });
  });
});

describe('getStoredApprovalTimeoutMs', () => {
  // getStoredApprovalTimeoutMs uses fs.readFileSync (via the default `fs`
  // import), which the mock at the top of this file passes through to the
  // real implementation (only fs.promises.* is mocked) — so this exercises
  // the real filesystem against a temp settings.json, keyed off OCTOMUX_DATA_DIR
  // (octomuxRoot() reads it at call time, so no module reset is needed).
  let dir: string;
  let prevDataDir: string | undefined;

  beforeEach(async () => {
    const fsSync = vi.importActual<typeof import('fs')>('fs');
    const os = await import('os');
    const path = await import('path');
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'octomux-settings-test-'));
    prevDataDir = process.env.OCTOMUX_DATA_DIR;
    process.env.OCTOMUX_DATA_DIR = dir;
  });

  afterEach(async () => {
    const fsSync = vi.importActual<typeof import('fs')>('fs');
    if (prevDataDir === undefined) delete process.env.OCTOMUX_DATA_DIR;
    else process.env.OCTOMUX_DATA_DIR = prevDataDir;
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['{"approvalTimeoutMs": 90000}', 90000],
    ['{"approvalTimeoutMs": -1}', undefined],
    ['{}', undefined],
    ['not json', undefined],
  ])('reads %s as %p from settings.json on disk', async (contents, expected) => {
    const fsSync = vi.importActual<typeof import('fs')>('fs');
    const path = await import('path');
    fsSync.writeFileSync(path.join(dir, 'settings.json'), contents);
    expect(getStoredApprovalTimeoutMs()).toBe(expected);
  });

  it('returns undefined when settings.json does not exist', () => {
    expect(getStoredApprovalTimeoutMs()).toBeUndefined();
  });
});

describe('getStoredCapabilityGateEnabled (capability-gate kill switch)', () => {
  // Same real-filesystem pattern as getStoredApprovalTimeoutMs above.
  let dir: string;
  let prevDataDir: string | undefined;

  beforeEach(async () => {
    const fsSync = vi.importActual<typeof import('fs')>('fs');
    const os = await import('os');
    const path = await import('path');
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'octomux-settings-gate-test-'));
    prevDataDir = process.env.OCTOMUX_DATA_DIR;
    process.env.OCTOMUX_DATA_DIR = dir;
  });

  afterEach(async () => {
    const fsSync = vi.importActual<typeof import('fs')>('fs');
    if (prevDataDir === undefined) delete process.env.OCTOMUX_DATA_DIR;
    else process.env.OCTOMUX_DATA_DIR = prevDataDir;
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['{"capabilityGateEnabled": false}', false],
    ['{"capabilityGateEnabled": true}', true],
    ['{}', undefined],
    ['not json', undefined],
  ])('reads %s as %p from settings.json on disk', async (contents, expected) => {
    const fsSync = vi.importActual<typeof import('fs')>('fs');
    const path = await import('path');
    fsSync.writeFileSync(path.join(dir, 'settings.json'), contents);
    expect(getStoredCapabilityGateEnabled()).toBe(expected);
  });

  it('returns undefined when settings.json does not exist (kill switch defaults ON elsewhere)', () => {
    expect(getStoredCapabilityGateEnabled()).toBeUndefined();
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

describe('settings.plugins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
  });

  describe('getSettings', () => {
    it('defaults to {} when absent from disk', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ editor: 'nvim', harnesses: {} }));
      const settings = await getSettings();
      expect(settings.plugins).toEqual({});
    });

    it('preserves an unknown plugin id verbatim, no validation', async () => {
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ plugins: { 'some-plugin': { anything: [1, 2, { nested: true }] } } }),
      );
      const settings = await getSettings();
      expect(settings.plugins['some-plugin']).toEqual({ anything: [1, 2, { nested: true }] });
    });
  });

  describe('updateSettings', () => {
    beforeEach(() => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(DEFAULT_SETTINGS));
    });

    it('a write to an unrelated key does not wipe plugins', async () => {
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ ...DEFAULT_SETTINGS, plugins: { demo: { foo: 'bar' } } }),
      );
      const result = await updateSettings({ editor: 'vscode' });
      expect(result.plugins).toEqual({ demo: { foo: 'bar' } });
      const writtenJson = mockFs.writeFile.mock.calls[0][1] as string;
      expect(JSON.parse(writtenJson).plugins).toEqual({ demo: { foo: 'bar' } });
    });

    it('an unknown plugin id survives a round-trip through a patch', async () => {
      const result = await updateSettings({ plugins: { 'not-installed': { keep: 'me' } } });
      expect(result.plugins['not-installed']).toEqual({ keep: 'me' });
      mockFs.readFile.mockResolvedValue(JSON.stringify(result));
      const reread = await getSettings();
      expect(reread.plugins['not-installed']).toEqual({ keep: 'me' });
    });

    it('preserves other plugin ids when patching one', async () => {
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ ...DEFAULT_SETTINGS, plugins: { a: { x: 1 }, b: { y: 2 } } }),
      );
      const result = await updateSettings({ plugins: { b: { y: 3 } } });
      expect(result.plugins).toEqual({ a: { x: 1 }, b: { y: 3 } });
    });

    it.each(['__proto__', 'constructor', 'prototype'])(
      'round-trips a plugin literally named %s without reparenting the merge object',
      async (id) => {
        const result = await updateSettings({ plugins: { [id]: { keep: 'me' } } });

        // The write must not vanish: the blob is an own property of the
        // result, not lost via prototype reparenting.
        expect(Object.prototype.hasOwnProperty.call(result.plugins, id)).toBe(true);
        expect(result.plugins[id]).toEqual({ keep: 'me' });
        // The merge object's own prototype must be untouched.
        expect(Object.getPrototypeOf(result.plugins)).toBe(Object.prototype);

        const writtenJson = mockFs.writeFile.mock.calls[0][1] as string;
        expect(JSON.parse(writtenJson).plugins[id]).toEqual({ keep: 'me' });

        mockFs.readFile.mockResolvedValue(writtenJson);
        const reread = await getSettings();
        expect(reread.plugins[id]).toEqual({ keep: 'me' });
      },
    );
  });

  describe('getPluginSettings / updatePluginSettings', () => {
    it('getPluginSettings returns {} for a plugin with no saved settings', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(DEFAULT_SETTINGS));
      expect(await getPluginSettings('fresh-id')).toEqual({});
    });

    it('updatePluginSettings on a fresh id creates it', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(DEFAULT_SETTINGS));
      await updatePluginSettings('fresh-id', { enabled: true });
      const writtenJson = mockFs.writeFile.mock.calls[0][1] as string;
      expect(JSON.parse(writtenJson).plugins['fresh-id']).toEqual({ enabled: true });
    });

    it('updatePluginSettings shallow-merges onto the existing blob', async () => {
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ ...DEFAULT_SETTINGS, plugins: { demo: { a: 1, b: 2 } } }),
      );
      await updatePluginSettings('demo', { b: 3, c: 4 });
      const writtenJson = mockFs.writeFile.mock.calls[0][1] as string;
      expect(JSON.parse(writtenJson).plugins.demo).toEqual({ a: 1, b: 3, c: 4 });
    });

    it('plugin config contents are never validated (arbitrary shapes pass through)', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify(DEFAULT_SETTINGS));
      const weird = { fn: 'not-actually-a-function-just-a-string', deep: { a: { b: { c: [] } } } };
      await updatePluginSettings('weird-plugin', weird);
      const writtenJson = mockFs.writeFile.mock.calls[0][1] as string;
      expect(JSON.parse(writtenJson).plugins['weird-plugin']).toEqual(weird);
    });

    it.each(['constructor', '__proto__', 'prototype'])(
      'getPluginSettings("%s") returns {} rather than walking the prototype chain',
      async (id) => {
        mockFs.readFile.mockResolvedValue(JSON.stringify(DEFAULT_SETTINGS));
        const result = await getPluginSettings(id);
        expect(result).toEqual({});
        // The historical bug: plain `settings.plugins[id]` resolves
        // `constructor` to `Object.prototype.constructor` (a function) and
        // `prototype`/`__proto__` similarly — none of those are plain objects.
        expect(typeof result).toBe('object');
        expect(result).not.toBe(Object);
      },
    );

    it('getPluginSettings("constructor") returns the stored blob when one is actually saved', async () => {
      mockFs.readFile.mockResolvedValue(
        JSON.stringify({ ...DEFAULT_SETTINGS, plugins: { constructor: { real: true } } }),
      );
      expect(await getPluginSettings('constructor')).toEqual({ real: true });
    });
  });
});
