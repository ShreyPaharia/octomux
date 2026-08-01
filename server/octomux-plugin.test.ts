import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  appendOctomuxPluginFlags,
  bundledOctomuxPluginDir,
  buildOctomuxPluginDirFlags,
  octomuxSkillRef,
} from './octomux-plugin.js';

describe('octomux-plugin', () => {
  it('octomuxSkillRef namespaces skills', () => {
    expect(octomuxSkillRef('review-walkthrough')).toBe('/octomux:review-walkthrough');
  });

  it('bundledOctomuxPluginDir resolves the shipped plugin manifest', () => {
    const dir = bundledOctomuxPluginDir();
    expect(fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'skills', 'review-walkthrough', 'SKILL.md'))).toBe(true);
  });

  it('buildOctomuxPluginDirFlags includes the bundled plugin dir', () => {
    const flags = buildOctomuxPluginDirFlags();
    expect(flags).toContain('--plugin-dir');
    expect(flags).toContain(bundledOctomuxPluginDir());
  });

  it('appendOctomuxPluginFlags writes schedule overrides to an overlay plugin', () => {
    const prev = process.env.OCTOMUX_DATA_DIR;
    const dataDir = path.join(os.tmpdir(), `octomux-plugin-override-${Date.now()}`);
    process.env.OCTOMUX_DATA_DIR = dataDir;
    try {
      const flags = appendOctomuxPluginFlags('', {
        skillContentOverrides: { 'prod-log-triage': '# DB override prompt' },
      });
      expect(flags).toContain('--plugin-dir');
      const overlayMatch = flags.match(/--plugin-dir '([^']+)'/);
      expect(overlayMatch).not.toBeNull();
      const overlayDir = overlayMatch![1];
      const skillFile = path.join(overlayDir, 'skills', 'prod-log-triage', 'SKILL.md');
      expect(fs.readFileSync(skillFile, 'utf-8')).toBe('# DB override prompt');
      expect(overlayDir.startsWith(dataDir)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.OCTOMUX_DATA_DIR;
      else process.env.OCTOMUX_DATA_DIR = prev;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
