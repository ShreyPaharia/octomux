/**
 * Start-time installers for user-facing octomux assets: Claude Code skills in
 * ~/.claude/skills and (for the standalone binary) an `octomux` CLI shim on
 * PATH.
 *
 * `octomux start` calls these on every boot, so both are gated: skills are
 * replaced only when the shipped version differs from the stamp left by the
 * previous install (matching stamp → no install, no update), and the CLI shim
 * is created only when no working `octomux` is on PATH at all.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  cpSync,
  rmSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from 'fs';
import path from 'path';
import os from 'os';

// Old skill names removed on sight so renames don't leave dead copies behind.
const DEPRECATED_SKILLS = [
  'octomux-create-pr',
  'octomux-create-task',
  'octomux-create-commit',
  'octomux-executing-plans',
];

/**
 * Install/refresh the bundled skills into `target` (~/.claude/skills).
 * Only skill names present in the bundle are ever replaced — user-authored
 * skills in the same directory are never touched. Returns true when anything
 * was (re)installed.
 */
export function installSkills({ source, target, version }) {
  if (!existsSync(source)) return false;

  for (const name of DEPRECATED_SKILLS) {
    rmSync(path.join(target, name), { recursive: true, force: true });
  }

  const stamp = path.join(target, '.octomux-skills-version');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === version) return false;

  mkdirSync(target, { recursive: true });
  for (const skill of readdirSync(source)) {
    const dest = path.join(target, skill);
    rmSync(dest, { recursive: true, force: true });
    cpSync(path.join(source, skill), dest, { recursive: true });
  }
  writeFileSync(stamp, version);
  return true;
}

/**
 * Put the running binary on PATH as `octomux` when nothing else provides it.
 * A working `octomux` anywhere on PATH (npm global, homebrew, a prior link) is
 * left alone — this only fills the gap, it never fights the owner. A dead
 * symlink left by a moved/deleted binary is replaced. Returns the link path
 * when one was created, null when nothing was needed.
 */
export function installCliShim({
  execPath,
  onPath,
  binDir = path.join(os.homedir(), '.local', 'bin'),
}) {
  if (onPath) return null;
  const link = path.join(binDir, 'octomux');
  mkdirSync(binDir, { recursive: true });
  rmSync(link, { force: true });
  symlinkSync(execPath, link);
  return link;
}
