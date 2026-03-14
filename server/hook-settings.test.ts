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
  it('creates .claude/settings.local.json with all 4 hook events and permissions', () => {
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

    // Verify permissions are installed
    expect(settings.permissions).toBeDefined();
    expect(settings.permissions.allow).toBeInstanceOf(Array);
    expect(settings.permissions.allow).toContain('Bash(git diff:*)');
    expect(settings.permissions.allow).toContain('Bash(bun:*)');
    expect(settings.permissions.allow).toContain('Bash(node:*)');
    expect(settings.permissions.allow).toContain('Bash(for:*)');
    expect(settings.permissions.allow).toContain('Bash(sqlite3:*)');
    // git commit and gh pr create should NOT be in allow or deny (prompts for permission)
    expect(settings.permissions.allow).not.toContain('Bash(git commit:*)');
    expect(settings.permissions.allow).not.toContain('Bash(gh pr create:*)');
    expect(settings.permissions.deny).not.toContain('Bash(git commit:*)');
    expect(settings.permissions.deny).not.toContain('Bash(gh pr create:*)');
    // Destructive operations denied
    expect(settings.permissions.deny).toContain('Bash(git push --force:*)');
    expect(settings.permissions.deny).toContain('Bash(git reset --hard:*)');
    expect(settings.permissions.deny).toContain('Bash(rm -rf:*)');
    // Regular git push is allowed (only force push is denied)
    expect(settings.permissions.allow).toContain('Bash(git push:*)');
    expect(settings.permissions.allow).toContain(
      'mcp__plugin_playwright_playwright__browser_snapshot',
    );
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
    expect(settings.permissions.allow).toContain('Bash(git diff:*)');
  });

  it('merges existing permissions.allow with new allowed tools (deduplicated)', () => {
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.local.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(custom-tool:*)', 'Bash(git diff:*)'], deny: ['Bash(rm:*)'] },
      }),
    );

    installHookSettings(tmpDir);

    const settings = JSON.parse(
      fs.readFileSync(path.join(claudeDir, 'settings.local.json'), 'utf-8'),
    );
    // Custom tool preserved
    expect(settings.permissions.allow).toContain('Bash(custom-tool:*)');
    // Existing deny preserved and merged with our denied tools
    expect(settings.permissions.deny).toContain('Bash(rm:*)');
    expect(settings.permissions.deny).toContain('Bash(rm -rf:*)');
    // Our tools added
    expect(settings.permissions.allow).toContain('Bash(bun:*)');
    // No duplicates
    const diffCount = settings.permissions.allow.filter(
      (t: string) => t === 'Bash(git diff:*)',
    ).length;
    expect(diffCount).toBe(1);
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
