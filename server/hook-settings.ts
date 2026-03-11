import path from 'path';
import fs from 'fs';

/**
 * Tools that agents are allowed to use without permission prompts.
 * Categorized as read-only or safe-write operations.
 *
 * NEVER auto-allow: git push --force, git reset --hard, rm -rf, deploy commands
 */
const ALLOWED_TOOLS = [
  // --- Read-only shell commands ---
  'Bash(cat:*)',
  'Bash(cd:*)',
  'Bash(echo:*)',
  'Bash(find:*)',
  'Bash(grep:*)',
  'Bash(head:*)',
  'Bash(jq:*)',
  'Bash(ls:*)',
  'Bash(lsof:*)',
  'Bash(sqlite3:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  'Bash(which:*)',

  // --- Safe write: build tools & package managers ---
  'Bash(bun:*)',
  'Bash(bunx:*)',
  'Bash(node:*)',
  'Bash(npx:*)',
  'Bash(npm:*)',
  'Bash(tsc:*)',

  // --- Safe write: git (read + stage, no commit/push/force/reset) ---
  'Bash(git add:*)',
  'Bash(git branch:*)',
  'Bash(git checkout:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git pull:*)',
  'Bash(git stash:*)',
  'Bash(git status:*)',
  'Bash(git show:*)',
  'Bash(git rev-parse:*)',
  'Bash(git worktree:*)',

  // --- Safe read: GitHub CLI (no PR creation) ---
  'Bash(gh issue:*)',
  'Bash(gh api:*)',
  'Bash(gh repo view:*)',

  // --- Safe write: file operations ---
  'Bash(cp:*)',
  'Bash(mkdir:*)',
  'Bash(chmod:*)',
  'Bash(touch:*)',

  // --- Safe write: network & misc ---
  'Bash(curl:*)',
  'Bash(for:*)',

  // --- Playwright MCP tools ---
  'mcp__plugin_playwright_playwright__browser_click',
  'mcp__plugin_playwright_playwright__browser_close',
  'mcp__plugin_playwright_playwright__browser_console_messages',
  'mcp__plugin_playwright_playwright__browser_evaluate',
  'mcp__plugin_playwright_playwright__browser_fill_form',
  'mcp__plugin_playwright_playwright__browser_navigate',
  'mcp__plugin_playwright_playwright__browser_run_code',
  'mcp__plugin_playwright_playwright__browser_snapshot',
  'mcp__plugin_playwright_playwright__browser_take_screenshot',
  'mcp__plugin_playwright_playwright__browser_type',
];

const HOOK_EVENTS = {
  UserPromptSubmit: [
    {
      hooks: [
        {
          type: 'http',
          url: 'http://localhost:7777/api/hooks/user-prompt-submit',
          timeout: 5,
        },
      ],
    },
  ],
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

  // Merge permissions: combine our allowed tools with any existing ones (deduplicated)
  const existingPerms =
    typeof existing.permissions === 'object' &&
    existing.permissions !== null &&
    !Array.isArray(existing.permissions)
      ? (existing.permissions as Record<string, unknown>)
      : {};
  const existingAllow = Array.isArray(existingPerms.allow) ? (existingPerms.allow as string[]) : [];
  const mergedAllow = [...new Set([...ALLOWED_TOOLS, ...existingAllow])];
  const mergedPermissions = { ...existingPerms, allow: mergedAllow };

  const merged = { ...existing, permissions: mergedPermissions, hooks: mergedHooks };

  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
}
