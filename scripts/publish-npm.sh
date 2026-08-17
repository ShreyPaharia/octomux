#!/usr/bin/env bash
# Publish octomux to npm: the six platform packages first, the root last.
#
# Why a script and not a runbook: the order is load-bearing. The root's
# optionalDependencies pin the exact version of every platform package, so a
# root that lands first leaves `npm i octomux` resolving binaries that do not
# exist yet. That is what happened in 1.4.0 — every non-arm64-mac install broke
# until the rest caught up. This encodes the order and refuses to publish the
# root until all six are actually visible on the registry.
#
# Resumable: anything already published at this version is skipped, so a run
# interrupted halfway (expired OTP, dropped network) can simply be re-run.
#
# Usage:
#   bash scripts/publish-npm.sh --dry-run     # verify everything, publish nothing
#   bash scripts/publish-npm.sh               # publish
#   bash scripts/publish-npm.sh --otp 123456  # 2FA accounts, if not using a token
#
# Auth: an automation token in ~/.npmrc avoids OTP entirely and is the sane path
# for a seven-step publish — a 30-second code does not survive six uploads.
#
# Run `bun run build:npm` first; this script only publishes what is in dist-npm/.

set -uo pipefail
cd "$(dirname "$0")/.."

DRY_RUN=0
OTP_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --otp) OTP_ARGS=(--otp "$2"); shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

VERSION=$(node -p "require('./package.json').version")
say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ── Preflight ────────────────────────────────────────────────────────────────

say "octomux ${VERSION} → npm"
say ""

npm whoami >/dev/null 2>&1 || die "not authenticated — run 'npm login', or put an automation token in ~/.npmrc"
say "  auth        $(npm whoami 2>/dev/null)"

[ -d dist-npm ] || die "dist-npm/ missing — run 'bun run build:npm' first"

PKG_DIRS=(dist-npm/*/)
[ "${#PKG_DIRS[@]}" -eq 6 ] || die "expected 6 platform packages in dist-npm/, found ${#PKG_DIRS[@]}"

# Every platform package must be built at the version we are about to pin.
for d in "${PKG_DIRS[@]}"; do
  v=$(node -p "require('./$d/package.json').version")
  [ "$v" = "$VERSION" ] || die "$(basename "$d") is $v, root is $VERSION — rebuild"
done
say "  packages    6, all at ${VERSION}"

# The root must actually pin them, or the platform binaries never get installed.
for d in "${PKG_DIRS[@]}"; do
  n=$(node -p "require('./$d/package.json').name")
  pinned=$(node -p "require('./package.json').optionalDependencies?.['$n'] ?? ''")
  [ "$pinned" = "$VERSION" ] || die "root does not pin $n at $VERSION (got '${pinned:-none}') — rerun 'bun run build:npm'"
done
say "  root pins   all 6 at ${VERSION}"

# An arch mismatch here ships an app that cannot exec its own binary. It has
# happened (v1.5.0's Intel .dmg carried an arm64 tmux), so it is checked.
if command -v file >/dev/null 2>&1; then
  for d in "${PKG_DIRS[@]}"; do
    n=$(basename "$d")
    bin=$(find "$d" -type f -perm +111 ! -name '*.json' ! -name '*.md' 2>/dev/null | head -1)
    [ -n "$bin" ] || die "$n has no executable"
    desc=$(file -b "$bin")
    case "$n" in
      *darwin-arm64) echo "$desc" | grep -q 'arm64'   || die "$n is not arm64: $desc" ;;
      *darwin-x64)   echo "$desc" | grep -q 'x86_64'  || die "$n is not x86_64: $desc" ;;
      *linux-arm64*) echo "$desc" | grep -qi 'aarch64' || die "$n is not aarch64: $desc" ;;
      *linux-x64*)   echo "$desc" | grep -qi 'x86-64'  || die "$n is not x86-64: $desc" ;;
    esac
  done
  say "  arch        verified for all 6"
fi

if [ "$DRY_RUN" = "1" ]; then
  say ""
  say "dry run — nothing published."
  exit 0
fi

# ── Platform packages first ──────────────────────────────────────────────────

say ""
for d in "${PKG_DIRS[@]}"; do
  n=$(node -p "require('./$d/package.json').name")
  if [ "$(npm view "$n@$VERSION" version 2>/dev/null)" = "$VERSION" ]; then
    say "  = $n already at $VERSION"
    continue
  fi
  printf '  → %s ... ' "$n"
  if out=$(npm publish "$d" --access public "${OTP_ARGS[@]+"${OTP_ARGS[@]}"}" 2>&1); then
    say "published"
  else
    say "FAILED"
    printf '%s\n' "$out" | tail -4 >&2
    die "stopped before the root publish — nothing is half-released, re-run when fixed"
  fi
done

# ── Root last, and only once the registry can actually see all six ───────────
#
# npm publish returns success while the read path still 404s for a minute or
# two, so poll rather than trusting the exit code of the loop above.

say ""
printf '  waiting for all 6 to be readable'
for _ in $(seq 1 30); do
  missing=0
  for d in "${PKG_DIRS[@]}"; do
    n=$(node -p "require('./$d/package.json').name")
    [ "$(npm view "$n@$VERSION" version 2>/dev/null)" = "$VERSION" ] || missing=1
  done
  [ "$missing" = "0" ] && break
  printf '.'
  sleep 10
done
say ""
[ "$missing" = "0" ] || die "platform packages still not readable — root NOT published, re-run later"

printf '  → octomux (root) ... '
# --ignore-scripts: prepublishOnly would trigger a full rebuild of what we just
# verified, and a rebuild between verification and upload defeats the point.
if out=$(npm publish --ignore-scripts "${OTP_ARGS[@]+"${OTP_ARGS[@]}"}" 2>&1); then
  say "published"
else
  say "FAILED"
  printf '%s\n' "$out" | tail -4 >&2
  die "platform packages are up but the root is not — re-run to finish"
fi

say ""
say "published ${VERSION}. Now:"
say "  git checkout package.json     # drop the release-time pins"
say "  npm i --prefix /tmp/smoke octomux@latest && /tmp/smoke/node_modules/.bin/octomux --help"
