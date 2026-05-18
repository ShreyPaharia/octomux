import { hookBaseUrl } from './hook-base-url.js';
import { getHarness } from './harnesses/index.js';

/**
 * Tools that agents are allowed to use without permission prompts.
 * Categorized as read-only or safe-write operations.
 *
 * NEVER auto-allow: git push --force, git reset --hard, rm -rf, deploy commands
 */
// Tools that are neither allowed nor denied will prompt for permission each time.
// git commit and gh pr create are intentionally omitted from both lists so agents
// must get explicit approval before committing or creating PRs.

export const DENIED_TOOLS = [
  // Destructive operations — always blocked
  'Bash(git push --force:*)',
  'Bash(git reset --hard:*)',
  'Bash(rm -rf:*)',
];

export const ALLOWED_TOOLS = [
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

/**
 * Install hook settings into a worktree. Dispatches to the per-task harness.
 * The legacy signature (single arg) defaults to Claude with no token; callers
 * should be updated to pass `harnessId` and `hookToken` explicitly.
 */
export async function installHookSettings(
  worktreePath: string,
  harnessId: string = 'claude-code',
  hookToken: string = '',
): Promise<void> {
  await getHarness(harnessId).installHooks(worktreePath, hookBaseUrl(), hookToken);
}
