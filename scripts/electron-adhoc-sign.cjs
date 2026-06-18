// electron-builder afterPack hook — ad-hoc sign the macOS .app.
//
// We have no Apple Developer ID, so electron-builder's own signing is disabled
// (mac.identity: null). But an UNSIGNED arm64 app — or one with only the
// linker's bare ad-hoc sig — is reported by macOS as "damaged" (its resource
// seal is invalid). Running `codesign --force --deep --sign -` here produces a
// VALID ad-hoc signature (verified: `codesign --verify --deep --strict` passes),
// which downgrades the Gatekeeper block from "damaged" to the normal
// "unidentified developer" prompt (right-click → Open). This runs after the
// .app is assembled and BEFORE the dmg/zip are built, so the installers contain
// the signed app.
//
// (A real Developer ID cert + notarization remains the proper long-term fix.)

const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename; // e.g. "octomux"
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`[afterPack] ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });

  // Sanity-check the seal so a broken signature fails the build loudly.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit',
  });
  console.log('[afterPack] ad-hoc signature valid');
};
