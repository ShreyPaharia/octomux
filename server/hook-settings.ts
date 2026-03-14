import path from 'path';
import fs from 'fs';

/**
 * Tools that agents are allowed to use without permission prompts.
 * Categorized as read-only or safe-write operations.
 *
 * NEVER auto-allow: git push --force, git reset --hard, rm -rf, deploy commands
 */
const DENIED_TOOLS = [
  // Agents must use /octomux-create-commit and /octomux-create-pr skills instead
  'Bash(git commit:*)',
  'Bash(gh pr create:*)',

  // Destructive operations
  'Bash(git push --force:*)',
  'Bash(git reset --hard:*)',
  'Bash(rm -rf:*)',
];

const ALLOWED_TOOLS = [
  // --- Read-only shell commands ---
  'Bash(cat:*)',
  'Bash(cd:*)',
  'Bash(echo:*)',
  'Bash(env:*)',
  'Bash(find:*)',
  'Bash(grep:*)',
  'Bash(head:*)',
  'Bash(jq:*)',
  'Bash(ls:*)',
  'Bash(lsof:*)',
  'Bash(pwd:*)',
  'Bash(rg:*)',
  'Bash(sed:*)',
  'Bash(sort:*)',
  'Bash(sqlite3:*)',
  'Bash(stat:*)',
  'Bash(tail:*)',
  'Bash(tree:*)',
  'Bash(wc:*)',
  'Bash(which:*)',
  'Bash(xargs:*)',

  // --- Safe write: build tools & package managers ---
  'Bash(bun:*)',
  'Bash(bunx:*)',
  'Bash(go:*)',
  'Bash(GOPATH=$(go:*)',
  'Bash(node:*)',
  'Bash(npx:*)',
  'Bash(npm:*)',
  'Bash(python3:*)',
  'Bash(tsc:*)',
  'Bash(vitest:*)',
  'Bash(playwright:*)',

  // --- Safe: git (read + stage + push, commit denied — use /octomux-create-commit) ---
  'Bash(git add:*)',
  'Bash(git branch:*)',
  'Bash(git checkout:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git pull:*)',
  'Bash(git push:*)',
  'Bash(git stash:*)',
  'Bash(git status:*)',
  'Bash(git show:*)',
  'Bash(git rev-parse:*)',
  'Bash(git worktree:*)',
  'Bash(git ls-remote:*)',
  'Bash(git remote:*)',
  'Bash(git fetch:*)',
  'Bash(git merge:*)',
  'Bash(git rebase:*)',
  'Bash(git cherry-pick:*)',
  'Bash(git tag:*)',

  // --- Safe: GitHub CLI (read only, PR creation denied — use /octomux-create-pr) ---
  'Bash(gh issue:*)',
  'Bash(gh api:*)',
  'Bash(gh repo view:*)',
  'Bash(gh pr view:*)',
  'Bash(gh pr list:*)',

  // --- Safe write: file operations ---
  'Bash(cp:*)',
  'Bash(mkdir:*)',
  'Bash(chmod:*)',
  'Bash(touch:*)',
  'Bash(mv:*)',

  // --- Safe write: network & misc ---
  'Bash(curl:*)',
  'Bash(for:*)',

  // --- Claude Code internal tools ---
  'ExitPlanMode',
  'AskUserQuestion',

  // --- Atlassian MCP tools (read-only) ---
  'mcp__plugin_atlassian_atlassian__getJiraIssue',
  'mcp__plugin_atlassian_atlassian__searchJiraIssuesUsingJql',
  'mcp__plugin_atlassian_atlassian__getVisibleJiraProjects',
  'mcp__plugin_atlassian_atlassian__getConfluencePage',
  'mcp__plugin_atlassian_atlassian__searchConfluenceUsingCql',
  'mcp__plugin_atlassian_atlassian__searchAtlassian',

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
  const existingDeny = Array.isArray(existingPerms.deny) ? (existingPerms.deny as string[]) : [];
  const mergedDeny = [...new Set([...DENIED_TOOLS, ...existingDeny])];
  const mergedPermissions = { ...existingPerms, allow: mergedAllow, deny: mergedDeny };

  const merged = { ...existing, permissions: mergedPermissions, hooks: mergedHooks };

  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
}
