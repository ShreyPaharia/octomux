#!/usr/bin/env bash
# Rollup script for glass-redesign parallel audit tasks.
# Rebases current agent branch onto origin/feat/glass-redesign, pushes, and
# appends a summary to .octomux/rollup/<slug>.md.
#
# Usage: scripts/rollup-to-feat.sh <slug> <summary-file>
#   <slug>          short identifier for this task, e.g. "t1-tokens-sidebar"
#   <summary-file>  path to a markdown file with your completion summary
#
# Retries up to 5× on push races. Never runs lint/test — caller should have
# already verified those locally before invoking rollup.

set -euo pipefail

SLUG="${1:?Usage: rollup-to-feat.sh <slug> <summary-file>}"
SUMMARY_FILE="${2:?Usage: rollup-to-feat.sh <slug> <summary-file>}"
TARGET_BRANCH="feat/glass-redesign"

if [ ! -f "$SUMMARY_FILE" ]; then
  echo "rollup: summary file not found: $SUMMARY_FILE" >&2
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" = "$TARGET_BRANCH" ]; then
  echo "rollup: refusing to run on $TARGET_BRANCH directly" >&2
  exit 1
fi

echo "rollup: current branch = $CURRENT_BRANCH"
echo "rollup: target branch  = $TARGET_BRANCH"
echo "rollup: slug           = $SLUG"

# Stage any stray changes first — caller should have committed, but be defensive.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "rollup: refusing to run with uncommitted changes" >&2
  git status --short
  exit 1
fi

# Step 1: rebase onto latest feat/glass-redesign
echo "rollup: fetching $TARGET_BRANCH"
git fetch origin "$TARGET_BRANCH"

echo "rollup: rebasing $CURRENT_BRANCH onto origin/$TARGET_BRANCH"
if ! git rebase "origin/$TARGET_BRANCH"; then
  echo "rollup: rebase hit conflicts — Claude should resolve them now." >&2
  echo "rollup: when resolved: git add -A && git rebase --continue && re-run this script" >&2
  exit 2
fi

# Step 2: push to feat/glass-redesign (with retry loop)
PUSHED=0
for attempt in 1 2 3 4 5; do
  git fetch origin "$TARGET_BRANCH"
  # Ensure still fast-forwardable after fresh fetch
  git rebase "origin/$TARGET_BRANCH" || {
    echo "rollup: rebase after fetch hit conflicts (attempt $attempt) — resolve and re-run" >&2
    exit 2
  }
  if git push origin "HEAD:$TARGET_BRANCH" --no-verify 2>&1; then
    PUSHED=1
    break
  fi
  echo "rollup: push attempt $attempt failed (race?), retrying after backoff"
  sleep $((RANDOM % 12 + 4))
done

if [ "$PUSHED" != "1" ]; then
  echo "rollup: failed to push after 5 attempts" >&2
  exit 3
fi

echo "rollup: pushed $CURRENT_BRANCH → $TARGET_BRANCH"

# Step 3: append summary to feat/glass-redesign
echo "rollup: switching to $TARGET_BRANCH to add summary"
git checkout "$TARGET_BRANCH"
git pull --ff-only origin "$TARGET_BRANCH"

mkdir -p .octomux/rollup
DEST=".octomux/rollup/${SLUG}.md"
cp "$SUMMARY_FILE" "$DEST"

git add "$DEST"
git commit -m "chore(rollup): ${SLUG} ✓" --no-verify

for attempt in 1 2 3 4 5; do
  if git push origin "$TARGET_BRANCH" --no-verify; then
    echo "rollup: summary pushed"
    exit 0
  fi
  echo "rollup: summary push failed, rebasing + retry ($attempt)"
  git pull --rebase origin "$TARGET_BRANCH"
  sleep $((RANDOM % 8 + 3))
done

echo "rollup: failed to push summary after 5 attempts" >&2
exit 4
