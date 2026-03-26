---
name: octomux-create-pr
description: Use when creating a pull request, opening a PR, or pushing and creating a PR for an octomux task
---

# Create PR for an octomux task

Create a GitHub pull request directly using `gh pr create`. The octomux dashboard will auto-detect the PR within 30 seconds.

## Steps

1. **Identify the task branch and repo:**
   - Ask the user which task, or infer from context
   - Get the task details (branch, repo_path, worktree):
     ```bash
     octomux get-task <task-id>
     ```
   - You need `branch`, `repo_path`, and `base_branch` (if set). If no base_branch, default to `main`.

2. **Gather context for the PR description:**

   ```bash
   git -C <worktree> log <base>..HEAD --oneline
   git -C <worktree> diff <base>...HEAD --stat
   ```

3. **Check if branch is pushed and push if needed:**

   ```bash
   # Check if remote tracking branch exists
   git -C <repo_path> ls-remote --heads origin <branch>
   ```

   If the branch is not pushed yet, push it:

   ```bash
   git -C <repo_path> push -u origin <branch>
   ```

   If already pushed, check if local is ahead and push any new commits:

   ```bash
   git -C <worktree> status -sb  # check if ahead of remote
   git -C <repo_path> push origin <branch>  # push if ahead
   ```

4. **Draft the PR title and body, then confirm with the user:**

   **Title:** Conventional commit format, under 70 chars, min 10 char description:

   ```
   <type>(<scope>): <description>
   ```

   Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `perf`
   Examples: `feat(hooks): add permission prompt tracking`, `fix(terminal): clean up orphaned tmux sessions`

   **Body:** Must include all three sections — What, Why, and Testing:

   ```markdown
   ## What

   <Description of what this PR does — summarize the changes>

   ## Why

   <Explanation of why this change is needed — the motivation>

   Resolves <link>

   ## Testing

   <How this was tested — commands run, manual verification, etc.>
   ```

   **Linking tickets/issues:**
   - If the task was created from a **Jira ticket**, include the Jira link
   - If the task was created from a **GitHub issue**, include: `Resolves #<issue-number>`
   - Infer the ticket/issue from the branch name (e.g., `feat/IN-123-...` -> IN-123, `fix/42-...` -> #42)
   - If no ticket/issue is associated, omit the `Resolves` line

   **IMPORTANT: Present the title and body to the user and WAIT for their confirmation before creating the PR.** Do NOT create the PR without explicit user approval. The user may want to adjust the title, description, or add context.

5. **After user confirms, create the PR using `gh`:**

   ```bash
   gh pr create \
     --head <branch> \
     --base <base> \
     --title "<title>" \
     --body "<body>" \
     --repo <repo_path>
   ```

6. **Report** — Print the PR URL. The octomux dashboard will auto-detect and link it to the task within ~30 seconds via the PR poller.

## Notes

- Do NOT use the octomux API PR endpoints (`/pr/preview`, `/pr`) — create directly with `gh` for better context and speed
- The dashboard auto-detects PRs by matching the branch name — no manual DB update needed
- If `gh pr create` fails with "already exists", the PR was likely already created
- The task must have a `branch` set (created automatically when octomux starts the task)
- Use `--repo` flag with the repo path so `gh` knows which repo to target
