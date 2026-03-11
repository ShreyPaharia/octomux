import path from 'path';
import fs from 'fs';

const HOOK_EVENTS = {
  PermissionRequest: [
    {
      hooks: [
        {
          type: 'http',
          url: 'http://localhost:7777/api/hooks/permission-request',
          timeout: 5,
        },
      ],
    },
  ],
  PostToolUse: [
    {
      hooks: [
        {
          type: 'http',
          url: 'http://localhost:7777/api/hooks/post-tool-use',
          timeout: 5,
        },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        {
          type: 'http',
          url: 'http://localhost:7777/api/hooks/stop',
          timeout: 5,
        },
      ],
    },
  ],
};

/**
 * Install Claude Code hook settings into a worktree's `.claude/settings.local.json`.
 * Merges with any existing settings, preserving non-hook keys and non-overlapping hook events.
 */
export function installHookSettings(worktreePath: string): void {
  const claudeDir = path.join(worktreePath, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.local.json');

  // Ensure .claude/ directory exists
  fs.mkdirSync(claudeDir, { recursive: true });

  // Read existing settings (if any)
  let existing: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    existing = JSON.parse(raw);
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      existing = {};
    }
  } catch {
    // File doesn't exist or is corrupted — start fresh
    existing = {};
  }

  // Merge hooks: our events override, but preserve other hook events
  const existingHooks =
    typeof existing.hooks === 'object' && existing.hooks !== null && !Array.isArray(existing.hooks)
      ? (existing.hooks as Record<string, unknown>)
      : {};

  const mergedHooks = { ...existingHooks, ...HOOK_EVENTS };

  const merged = { ...existing, hooks: mergedHooks };

  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
}
