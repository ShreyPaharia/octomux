import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { installHookSettings } from './hook-settings.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-settings-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('installHookSettings', () => {
  it('creates .claude/settings.local.json with all 4 hook events', () => {
    installHookSettings(tmpDir);

    const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

    expect(settings.hooks.UserPromptSubmit).toEqual([
      {
        hooks: [
          {
            type: 'http',
            url: 'http://localhost:7777/api/hooks/user-prompt-submit',
            timeout: 5,
          },
        ],
      },
    ]);
    expect(settings.hooks.PermissionRequest).toEqual([
      {
        hooks: [
          { type: 'http', url: 'http://localhost:7777/api/hooks/permission-request', timeout: 5 },
        ],
      },
    ]);
    expect(settings.hooks.PostToolUse).toEqual([
      {
        hooks: [{ type: 'http', url: 'http://localhost:7777/api/hooks/post-tool-use', timeout: 5 }],
      },
    ]);
    expect(settings.hooks.Stop).toEqual([
      {
        hooks: [{ type: 'http', url: 'http://localhost:7777/api/hooks/stop', timeout: 5 }],
      },
    ]);
  });

  it('merges with existing settings preserving non-hook keys', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.local.json'),
      JSON.stringify({ allowedTools: ['Bash'], customKey: 42 }),
    );

    installHookSettings(tmpDir);

    const settings = JSON.parse(
      fs.readFileSync(path.join(claudeDir, 'settings.local.json'), 'utf-8'),
    );
    expect(settings.allowedTools).toEqual(['Bash']);
    expect(settings.customKey).toBe(42);
    expect(settings.hooks.PermissionRequest).toBeDefined();
  });

  it('preserves existing hook events like PreToolUse', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const existingHooks = {
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'http', url: 'http://example.com', timeout: 3 }] }],
      },
    };
    fs.writeFileSync(path.join(claudeDir, 'settings.local.json'), JSON.stringify(existingHooks));

    installHookSettings(tmpDir);

    const settings = JSON.parse(
      fs.readFileSync(path.join(claudeDir, 'settings.local.json'), 'utf-8'),
    );
    expect(settings.hooks.PreToolUse).toEqual(existingHooks.hooks.PreToolUse);
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
    expect(settings.hooks.PermissionRequest).toBeDefined();
    expect(settings.hooks.PostToolUse).toBeDefined();
    expect(settings.hooks.Stop).toBeDefined();
  });

  it('handles corrupted existing file gracefully', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.local.json'), '{not valid json!!!');

    installHookSettings(tmpDir);

    const settings = JSON.parse(
      fs.readFileSync(path.join(claudeDir, 'settings.local.json'), 'utf-8'),
    );
    expect(settings.hooks.PermissionRequest).toBeDefined();
  });

  it('creates .claude directory if it does not exist', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    expect(fs.existsSync(claudeDir)).toBe(false);

    installHookSettings(tmpDir);

    expect(fs.existsSync(claudeDir)).toBe(true);
    const settings = JSON.parse(
      fs.readFileSync(path.join(claudeDir, 'settings.local.json'), 'utf-8'),
    );
    expect(settings.hooks).toBeDefined();
  });
});
