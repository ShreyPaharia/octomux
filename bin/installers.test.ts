import { describe, it, expect, beforeEach, afterEach } from '../server/bun-test.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { installSkills, installCliShim } from './installers.js';

let tmp: string;
let source: string;
let target: string;

function writeSkill(root: string, name: string, body: string): void {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, name, 'SKILL.md'), body);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-installers-'));
  source = path.join(tmp, 'bundle');
  target = path.join(tmp, 'claude-skills');
  fs.mkdirSync(source, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('installSkills', () => {
  it('installs bundled skills and writes the version stamp', () => {
    writeSkill(source, 'create-pr', 'v1');

    expect(installSkills({ source, target, version: '1.0.0' })).toBe(true);
    expect(fs.readFileSync(path.join(target, 'create-pr', 'SKILL.md'), 'utf8')).toBe('v1');
    expect(fs.readFileSync(path.join(target, '.octomux-skills-version'), 'utf8')).toBe('1.0.0');
  });

  it('is a no-op when the stamp matches the current version', () => {
    writeSkill(source, 'create-pr', 'v1');
    installSkills({ source, target, version: '1.0.0' });
    // Simulate a user edit — a same-version restart must not clobber it.
    fs.writeFileSync(path.join(target, 'create-pr', 'SKILL.md'), 'edited');

    expect(installSkills({ source, target, version: '1.0.0' })).toBe(false);
    expect(fs.readFileSync(path.join(target, 'create-pr', 'SKILL.md'), 'utf8')).toBe('edited');
  });

  it('replaces stale skills when the version changes', () => {
    writeSkill(source, 'create-pr', 'v1');
    installSkills({ source, target, version: '1.0.0' });
    // Old version left an extra file behind inside the skill dir.
    fs.writeFileSync(path.join(target, 'create-pr', 'stale.md'), 'old');

    fs.writeFileSync(path.join(source, 'create-pr', 'SKILL.md'), 'v2');
    expect(installSkills({ source, target, version: '2.0.0' })).toBe(true);
    expect(fs.readFileSync(path.join(target, 'create-pr', 'SKILL.md'), 'utf8')).toBe('v2');
    expect(fs.existsSync(path.join(target, 'create-pr', 'stale.md'))).toBe(false);
    expect(fs.readFileSync(path.join(target, '.octomux-skills-version'), 'utf8')).toBe('2.0.0');
  });

  it('never touches user-authored skills in the same directory', () => {
    writeSkill(source, 'create-pr', 'v1');
    writeSkill(target, 'my-own-skill', 'mine');

    installSkills({ source, target, version: '1.0.0' });
    installSkills({ source, target, version: '2.0.0' });
    expect(fs.readFileSync(path.join(target, 'my-own-skill', 'SKILL.md'), 'utf8')).toBe('mine');
  });

  it('removes deprecated skill names', () => {
    writeSkill(source, 'create-pr', 'v1');
    writeSkill(target, 'octomux-create-pr', 'old-name');

    installSkills({ source, target, version: '1.0.0' });
    expect(fs.existsSync(path.join(target, 'octomux-create-pr'))).toBe(false);
  });

  it('does nothing when the bundle dir is missing', () => {
    expect(installSkills({ source: path.join(tmp, 'nope'), target, version: '1.0.0' })).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe('installCliShim', () => {
  it('does nothing when octomux is already on PATH', () => {
    const binDir = path.join(tmp, 'bin');
    expect(installCliShim({ execPath: '/opt/octomux', onPath: true, binDir })).toBeNull();
    expect(fs.existsSync(path.join(binDir, 'octomux'))).toBe(false);
  });

  it('links the running binary when octomux is missing from PATH', () => {
    const binDir = path.join(tmp, 'bin');
    const link = installCliShim({ execPath: process.execPath, onPath: false, binDir });
    expect(link).toBe(path.join(binDir, 'octomux'));
    expect(fs.readlinkSync(link!)).toBe(process.execPath);
  });

  it('replaces a dead symlink left by a moved binary', () => {
    const binDir = path.join(tmp, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.symlinkSync(path.join(tmp, 'gone'), path.join(binDir, 'octomux'));

    const link = installCliShim({ execPath: process.execPath, onPath: false, binDir });
    expect(fs.readlinkSync(link!)).toBe(process.execPath);
  });
});
