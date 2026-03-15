---
name: octomux-create-commit
description: Generate a conventional commit message from staged changes and commit. Use when the user asks to commit, says /commit, or wants to save their changes.
---

# Commit

Generate a commit message from staged changes using conventional commits, then commit.

## Steps

1. **Check for staged changes:**

   ```bash
   git diff --cached --stat
   ```

   If nothing is staged, tell the user and stop.

2. **Get the staged diff:**

   ```bash
   git diff --cached
   ```

3. **Generate the commit message** by analyzing the diff. Follow these rules exactly:

   ### Format

   ```
   <type>(<scope>): <description>
   ```

   Scope is optional. If changes span multiple scopes, omit scope.

   ### Allowed Types

   | Type       | When to use                                  |
   | ---------- | -------------------------------------------- |
   | `feat`     | A new feature                                |
   | `fix`      | A bug fix                                    |
   | `docs`     | Documentation only changes                   |
   | `style`    | Code style changes (formatting, etc.)        |
   | `refactor` | Code refactoring (no new feature or bug fix) |
   | `perf`     | Performance improvements                     |
   | `test`     | Adding or fixing tests                       |
   | `build`    | Build system or dependencies                 |
   | `ci`       | CI configuration changes                     |
   | `chore`    | Other changes                                |
   | `revert`   | Revert a commit                              |

   ### Rules
   - Description must be at least 10 characters
   - Use lowercase for the description
   - Do not end with a period
   - Cover ALL changes in the diff
   - Keep the message concise — one line unless a body is truly needed
   - If a body is needed, add a blank line after the subject, then bullet points

4. **Show the message to the user** and ask for confirmation before committing.

5. **Commit** using a heredoc for proper formatting:

   ```bash
   git commit -m "$(cat <<'EOF'
   <generated message>
   EOF
   )"
   ```

6. **Verify** by running `git log --oneline -1` to confirm.

## Notes

- NEVER amend a previous commit unless the user explicitly asks
- NEVER push unless the user explicitly asks
- If the diff is large, summarize the key changes — don't list every file
- If unsure about the type, prefer `feat` for new code, `fix` for corrections, `refactor` for restructuring
