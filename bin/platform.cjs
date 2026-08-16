/**
 * Which `@octomux/cli-*` package this host needs.
 *
 * Shared by the postinstall step and the fallback wrapper so the two can't drift.
 */

const PACKAGE_PREFIX = '@octomux/cli';

/**
 * True on a musl-based Linux (Alpine and friends).
 *
 * `process.report.getReport().header.glibcVersionRuntime` is present on glibc and
 * absent on musl. Cheaper than shelling out to `ldd`, and it avoids the
 * ENOENT-means-musl false positive when `ldd` simply isn't installed.
 */
function isMusl() {
  if (process.platform !== 'linux') return false;
  try {
    const report =
      typeof process.report?.getReport === 'function' ? process.report.getReport() : null;
    return !report?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

/** The platform package name, or null when this host has no prebuilt binary. */
function platformPackage() {
  const { platform, arch } = process;

  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return `${PACKAGE_PREFIX}-darwin-${arch}`;
  }
  if (platform === 'linux' && (arch === 'arm64' || arch === 'x64')) {
    return `${PACKAGE_PREFIX}-linux-${arch}${isMusl() ? '-musl' : ''}`;
  }
  return null;
}

module.exports = { PACKAGE_PREFIX, isMusl, platformPackage };
