#!/usr/bin/env bash
# Sign the compiled macOS binaries in dist-bin/.
#
# Two modes:
#
#   ad-hoc (default, no credentials needed)
#     `codesign --sign -`. An arm64 binary with no valid signature is reported by
#     macOS as "damaged" rather than merely untrusted, so this is not optional —
#     it downgrades that to the normal unidentified-developer prompt. Same
#     reasoning as scripts/electron-adhoc-sign.cjs.
#
#   Developer ID (set APPLE_SIGNING_IDENTITY)
#     Real signature with hardened runtime, plus notarization when the notary
#     credentials below are also set. Required for anything users download
#     outside npm — Gatekeeper quarantines browser/curl downloads, but not files
#     written by a package manager.
#
#       APPLE_SIGNING_IDENTITY  "Developer ID Application: Example (TEAMID)"
#       APPLE_NOTARY_PROFILE    keychain profile from `xcrun notarytool store-credentials`
#
# Note: a bare executable cannot be stapled (`xcrun stapler` wants an .app/.dmg/
# .pkg), so a notarized binary is validated online at first run. Ship it inside a
# .dmg or .pkg if you need offline validation.
#
# Usage: bash scripts/sign-macos.sh

set -uo pipefail

cd "$(dirname "$0")/.."

# codesign is macOS-only. Cross-compiling the darwin binaries elsewhere is fine;
# they just have to be signed on a macOS runner before they reach users.
if [ "$(uname -s)" != "Darwin" ]; then
  echo "Not macOS — skipping signing. Sign on a macOS runner before publishing."
  exit 0
fi

shopt -s nullglob
binaries=(dist-bin/octomux-darwin-*)
if [ ${#binaries[@]} -eq 0 ]; then
  echo "No macOS binaries in dist-bin/ — run: bun run build:binary:all" >&2
  exit 1
fi

identity="${APPLE_SIGNING_IDENTITY:-}"
if [ -n "$identity" ]; then
  echo "Signing with Developer ID: $identity"
  sign_args=(--force --timestamp --options runtime --sign "$identity")
else
  echo "No APPLE_SIGNING_IDENTITY — ad-hoc signing (valid signature, untrusted publisher)"
  sign_args=(--force --sign -)
fi

for binary in "${binaries[@]}"; do
  codesign "${sign_args[@]}" "$binary" || {
    echo "  ✗ codesign failed for $binary" >&2
    exit 1
  }
  codesign --verify --strict "$binary" || {
    echo "  ✗ verification failed for $binary" >&2
    exit 1
  }
  echo "  ✓ $binary"
done

if [ -z "$identity" ] || [ -z "${APPLE_NOTARY_PROFILE:-}" ]; then
  echo
  echo "Skipping notarization (needs APPLE_SIGNING_IDENTITY + APPLE_NOTARY_PROFILE)."
  exit 0
fi

for binary in "${binaries[@]}"; do
  zip="${binary}.zip"
  # notarytool takes an archive, not a bare executable.
  ditto -c -k --keepParent "$binary" "$zip"
  echo "Notarizing $binary…"
  xcrun notarytool submit "$zip" --keychain-profile "$APPLE_NOTARY_PROFILE" --wait || {
    echo "  ✗ notarization failed for $binary" >&2
    rm -f "$zip"
    exit 1
  }
  rm -f "$zip"
  echo "  ✓ notarized $binary"
done
