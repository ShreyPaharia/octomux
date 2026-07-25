# Skills, agent roles, and saved files (SHR-184)

octomux stores repo-local configuration under `<repo>/.octomux/`. Skills and agent
role definitions ship from a single source — the bundled octomux plugin — and are
not editable through the API. Saved files use a documented repo-local directory
with full REST and CLI access.

## Skills and agent roles

Skills (e.g. `prod-log-triage`, `doc-drift`) and agent roles (`orchestrator`,
`planner`, `reviewer`) live in the bundled octomux plugin:

| Path                                              | Purpose                                        |
| ------------------------------------------------- | ---------------------------------------------- |
| `<octomux-package>/plugin/skills/<name>/SKILL.md` | Built-in skills, single source                 |
| `<octomux-package>/plugin/agents/<name>.md`       | Built-in agent role definitions, single source |

There is no repo or home tier and no edit/write API — earlier revisions had
`<repo>/.octomux/{skills,agents}` and `~/.octomux/agents`, but nothing ever
delivered them to a running agent: `syncAgents()` is a no-op in every harness,
and delivery to launched agents is entirely via `--plugin-dir` pointing at the
bundled plugin (see commit `1cd48c2`). Those tiers were readable through the
REST API but invisible to every actual agent, so they were removed.
`GET /api/skills`, `GET /api/skills/:name`, `GET /api/agents`, and
`GET /api/agents/:name` now read only from the bundled plugin.

Users who want their own skills or subagents use Claude Code's native
locations — `~/.claude/skills/` and `~/.claude/agents/` for user-global,
`<repo>/.claude/` for repo-specific — which the harness reads directly and
octomux neither manages nor lists.

Octomux's own skills can also be installed into a user's own Claude Code
directly, via the plugin marketplace:

```
/plugin marketplace add ShreyPaharia/octomux-agents
/plugin install octomux@octomux
```

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
