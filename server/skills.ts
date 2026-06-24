import fs from 'fs';
import path from 'path';
import { childLogger } from './logger.js';
import {
  builtInSkillsDir,
  homeSkillsDir,
  repoSkillsDir,
} from './octomux-paths.js';

const logger = childLogger('skills');

export interface Skill {
  name: string;
  description: string;
}

export interface SkillDetail {
  name: string;
  content: string;
}

export interface SkillsOptions {
  /** When set, repo `.octomux/skills/` takes precedence over home and built-in. */
  repoPath?: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

function validateName(name: string): void {
  if (name === '..' || name.includes('..') || !NAME_RE.test(name)) {
    throw new Error(`Invalid skill name: ${name}`);
  }
}

function parseDescription(content: string): string {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return '';
  const frontmatter = match[1];
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  return descMatch ? descMatch[1].trim() : '';
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

function writeSkillsDir(opts?: SkillsOptions): string {
  return opts?.repoPath ? repoSkillsDir(opts.repoPath) : homeSkillsDir();
}

async function listSkillNamesInDir(dir: string): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    names.push(entry.name);
  }
  return names;
}

async function readSkillContent(skillsRoot: string, name: string): Promise<string | null> {
  const skillFile = path.join(skillsRoot, name, 'SKILL.md');
  try {
    return await fs.promises.readFile(skillFile, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') {
      logger.warn({ skill: name, code, skills_root: skillsRoot }, 'skipping dir without readable SKILL.md');
      return null;
    }
    throw err;
  }
}

/** Loader precedence: repo → home → built-in (later sources override earlier). */
function skillSourceDirs(opts?: SkillsOptions): string[] {
  const dirs: string[] = [builtInSkillsDir(), homeSkillsDir()];
  if (opts?.repoPath) dirs.push(repoSkillsDir(opts.repoPath));
  return dirs;
}

export async function listSkills(opts?: SkillsOptions): Promise<Skill[]> {
  const homeDir = homeSkillsDir();
  if (!opts?.repoPath) {
    await fs.promises.mkdir(homeDir, { recursive: true });
  }

  const byName = new Map<string, Skill>();
  for (const dir of skillSourceDirs(opts)) {
    for (const name of await listSkillNamesInDir(dir)) {
      const content = await readSkillContent(dir, name);
      if (content === null) continue;
      byName.set(name, { name, description: parseDescription(content) });
    }
  }

  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function resolveSkillContent(name: string, opts?: SkillsOptions): Promise<string | null> {
  const dirs = [...skillSourceDirs(opts)].reverse();
  for (const dir of dirs) {
    const content = await readSkillContent(dir, name);
    if (content !== null) return content;
  }
  return null;
}

export async function getSkill(name: string, opts?: SkillsOptions): Promise<SkillDetail> {
  validateName(name);

  const content = await resolveSkillContent(name, opts);
  if (content === null) {
    throw new Error(`Skill not found: ${name}`);
  }

  return { name, content };
}

export async function createSkill(
  name: string,
  content: string,
  opts?: SkillsOptions,
): Promise<SkillDetail> {
  validateName(name);

  const dir = writeSkillsDir(opts);
  const skillDir = path.join(dir, name);

  if (await exists(skillDir)) {
    throw new Error(`Skill already exists: ${name}`);
  }

  await fs.promises.mkdir(skillDir, { recursive: true });
  await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf-8');

  return { name, content };
}

export async function updateSkill(
  name: string,
  content: string,
  opts?: SkillsOptions,
): Promise<SkillDetail> {
  validateName(name);

  const dir = writeSkillsDir(opts);
  const skillDir = path.join(dir, name);

  if (!(await exists(skillDir))) {
    throw new Error(`Skill not found: ${name}`);
  }

  await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
  return { name, content };
}

export async function deleteSkill(name: string, opts?: SkillsOptions): Promise<void> {
  validateName(name);

  const dir = writeSkillsDir(opts);
  const skillDir = path.join(dir, name);

  if (!(await exists(skillDir))) {
    throw new Error(`Skill not found: ${name}`);
  }

  await fs.promises.rm(skillDir, { recursive: true });
}

/**
 * Mirror effective skills (repo → home → built-in) into `<worktree>/.claude/skills/`
 * so Claude Code resolves them in the worktree without touching `~/.claude/skills`.
 */
export async function syncSkills(worktreePath: string): Promise<void> {
  const targetDir = path.join(worktreePath, '.claude', 'skills');
  await fs.promises.mkdir(targetDir, { recursive: true });

  const opts: SkillsOptions = { repoPath: worktreePath };
  const skills = await listSkills(opts);
  for (const skill of skills) {
    const detail = await getSkill(skill.name, opts);
    const skillDir = path.join(targetDir, skill.name);
    await fs.promises.mkdir(skillDir, { recursive: true });
    await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), detail.content, 'utf-8');
  }
}
