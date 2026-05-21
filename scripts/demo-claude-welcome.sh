#!/usr/bin/env bash
# Static empty Claude Code session for README screenshots (no API, no user name).
set -euo pipefail
export TERM="${TERM:-xterm-256color}"
printf '\033[2J\033[H'
cat <<'EOF'

╭─── Claude Code ────────────────────────────────────────────────────────────────╮
│                                                    │ Tips for getting        │
│              Ready to work on your task            │ started                 │
│                                                    │ Ask Claude to implement │
│                       ▐▛███▜▌                      │ a feature or fix a bug  │
│                      ▝▜█████▛▘                     │ ─────────────────────── │
│                        ▘▘ ▝▝                       │ Type a task below       │
│  Sonnet · acme-platform · agents/team-invite-flow    │ Press ? for shortcuts   │
│      demo-fixtures/acme-platform/.worktrees/demo-detail                        │
╰──────────────────────────────────────────────────────────────────────────────╯







                                                              ◉ Agent 1 · idle
────────────────────────────────────────────────────────────────────────────────
❯ 
────────────────────────────────────────────────────────────────────────────────
  ? for shortcuts

EOF
# Hold the pane open for tmux attach / xterm streaming.
exec bash -c 'while true; do sleep 3600; done'
