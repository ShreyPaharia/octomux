import path from 'path';
import os from 'os';
import { octomuxRoot } from './octomux-root.js';
import { assetRoot } from './assets.js';

/** Repo-local octomux config root: `<repo>/.octomux/`. */
export function repoOctomuxDir(repoPath: string): string {
  return path.join(repoPath, '.octomux');
}

export function repoSkillsDir(repoPath: string): string {
  return path.join(repoOctomuxDir(repoPath), 'skills');
}

export function repoAgentsDir(repoPath: string): string {
  return path.join(repoOctomuxDir(repoPath), 'agents');
}

/** Repo-portable saved files: `<repo>/.octomux/files/`. */
export function repoFilesDir(repoPath: string): string {
  return path.join(repoOctomuxDir(repoPath), 'files');
}

export function homeSkillsDir(): string {
  return path.join(os.homedir(), '.claude', 'skills');
}

export function homeAgentsDir(): string {
  return process.env.OCTOMUX_AGENTS_DIR || path.join(octomuxRoot(), 'agents');
}

export function builtInSkillsDir(): string {
  return path.join(assetRoot(), 'skills');
}

export function builtInAgentsDir(): string {
  return path.join(assetRoot(), 'agents');
}
