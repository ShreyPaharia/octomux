# Repo-portable skills, agents, and saved files (SHR-184)

octomux stores repo-local configuration under `<repo>/.octomux/`. Skills and agents
use a three-tier loader; saved files use a single documented directory with REST
and CLI access.

## Layout

| Path                                     | Purpose                                       |
| ---------------------------------------- | --------------------------------------------- |
| `<repo>/.octomux/skills/<name>/SKILL.md` | Repo-portable skills (version-controlled)     |
| `<repo>/.octomux/agents/<name>.md`       | Repo-portable agent definitions               |
| `<repo>/.octomux/files/**`               | Saved files / lightweight memory (plain text) |

Home and package defaults still apply:

| Path                                                   | Purpose                              |
| ------------------------------------------------------ | ------------------------------------ |
| `~/.claude/skills/<name>/SKILL.md`                     | User-global skills                   |
| `$OCTOMUX_AGENTS_DIR` or `~/.octomux/agents/<name>.md` | User-global agent overrides          |
| `<octomux-package>/skills/`                            | Built-in skills shipped with octomux |
| `<octomux-package>/agents/`                            | Built-in agent definitions           |

## Loader precedence

For both skills and agents:

1. **Repo** — `<repo>/.octomux/...` (highest)
2. **Home** — `~/.claude/skills` or `~/.octomux/agents`
3. **Built-in** — package `skills/` and `agents/` dirs

On task launch, effective skills are mirrored to `<worktree>/.claude/skills/` and
agents to `<worktree>/.claude/agents/` (or Cursor rules) so harnesses resolve them
without writing to `~/.claude`.

Optional `repo_path` query parameter on skills/agents REST endpoints scopes reads and
writes to the repo tier.

## Saved files API

**Location:** `<repo>/.octomux/files/` (created on first write).

Allowed extensions: `.md`, `.txt`, `.json`, `.yaml`, `.yml`, `.csv`, `.html`.
Max file size: 1 MiB. Paths must be relative; traversal and symlinks are rejected.

### REST

```
GET  /api/repos/:repoPath/files
GET  /api/repos/:repoPath/files/content?path=<rel>
PUT  /api/repos/:repoPath/files/content?path=<rel>   body: { "content": "..." }
```

`:repoPath` is URL-encoded (same pattern as `/api/repos/:repoPath/learnings`).

### CLI

```
octomux files list [-r <repo>]
octomux files get <path> [-r <repo>]
octomux files put <path> [-r <repo>] [-c <content>]
```

`-r` defaults to the current working directory.
