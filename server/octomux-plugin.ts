import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { octomuxRoot } from './octomux-root.js';
import { shellQuoteSingle } from './shell-quote.js';

/** Plugin namespace for vendored octomux skills (e.g. `/octomux:review-walkthrough`). */
export const OCTOMUX_PLUGIN_NAME = 'octomux';

export function octomuxSkillRef(skillName: string): string {
  return `/${OCTOMUX_PLUGIN_NAME}:${skillName}`;
}

/** Locate the bundled octomux plugin directory shipped with the package. */
export function bundledOctomuxPluginDir(): string {
  const startDir = path.dirname(fileURLToPath(import.meta.url));
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'plugin');
    if (fs.existsSync(path.join(candidate, '.claude-plugin', 'plugin.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Cannot locate bundled octomux plugin from ${startDir} (walked up 6 levels)`);
}

export interface OctomuxPluginFlagOpts {
  /** Per-skill SKILL.md body overrides (schedule DB prompts for task-backed kinds). */
  skillContentOverrides?: Record<string, string>;
}

function writeOverlayPlugin(overrides: Record<string, string>): string {
  const id = crypto.randomBytes(8).toString('hex');
  const overlayDir = path.join(octomuxRoot(), 'plugin-overrides', id);
  const skillsDir = path.join(overlayDir, 'skills');
  fs.mkdirSync(skillsDir, { recursive: true, mode: 0o700 });

  fs.mkdirSync(path.join(overlayDir, '.claude-plugin'), { recursive: true });
  const manifest = {
    name: OCTOMUX_PLUGIN_NAME,
    version: '0.0.0-overlay',
    description: 'Ephemeral octomux skill overrides',
    author: { name: 'octomux' },
    skills: './skills/',
  };
  fs.writeFileSync(
    path.join(overlayDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    { mode: 0o600 },
  );
  for (const [name, content] of Object.entries(overrides)) {
    const skillDir = path.join(skillsDir, name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
  }

  return overlayDir;
}

/**
 * Build `--plugin-dir` flags for the bundled octomux plugin. When schedule
 * overrides are present, an ephemeral overlay plugin (under octomux data dir,
 * not ~/.claude or the worktree) is listed first so it wins over the bundle.
 */
export function buildOctomuxPluginDirFlags(opts?: OctomuxPluginFlagOpts): string {
  const bundled = bundledOctomuxPluginDir();
  const dirs: string[] = [];

  const overrides = opts?.skillContentOverrides;
  if (overrides && Object.keys(overrides).length > 0) {
    dirs.push(writeOverlayPlugin(overrides));
  }
  dirs.push(bundled);

  return dirs.map((d) => ` --plugin-dir ${shellQuoteSingle(d)}`).join('');
}

/** Append octomux plugin `--plugin-dir` flags to harness CLI flags. */
export function appendOctomuxPluginFlags(flags: string, opts?: OctomuxPluginFlagOpts): string {
  const pluginFlags = buildOctomuxPluginDirFlags(opts);
  if (!pluginFlags) return flags.trim();
  const trimmed = flags.trim();
  return trimmed ? `${trimmed}${pluginFlags}` : pluginFlags.trim();
}
