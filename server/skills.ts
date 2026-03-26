import fs from 'fs';
import path from 'path';
import os from 'os';

export interface Skill {
  name: string;
  description: string;
}

export interface SkillDetail {
  name: string;
  content: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

function skillsDir(): string {
  return path.join(os.homedir(), '.claude', 'skills');
}

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

async function ensureDir(dir: string): Promise<void> {
  try {
    await fs.promises.access(dir);
  } catch {
    await fs.promises.mkdir(dir, { recursive: true });
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function listSkills(): Promise<Skill[]> {
  const dir = skillsDir();

  await ensureDir(dir);

  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const skills: Skill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, 'SKILL.md');
    const content = await fs.promises.readFile(skillFile, 'utf-8');
    skills.push({ name: entry.name, description: parseDescription(content) });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSkill(name: string): Promise<SkillDetail> {
  validateName(name);

  const dir = skillsDir();
  const skillDir = path.join(dir, name);

  if (!(await exists(skillDir))) {
    throw new Error(`Skill not found: ${name}`);
  }

  const content = await fs.promises.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
  return { name, content };
}

export async function createSkill(name: string, content: string): Promise<SkillDetail> {
  validateName(name);

  const dir = skillsDir();
  const skillDir = path.join(dir, name);

  if (await exists(skillDir)) {
    throw new Error(`Skill already exists: ${name}`);
  }

  await fs.promises.mkdir(skillDir, { recursive: true });
  await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf-8');

  return { name, content };
}

export async function updateSkill(name: string, content: string): Promise<SkillDetail> {
  validateName(name);

  const dir = skillsDir();
  const skillDir = path.join(dir, name);

  if (!(await exists(skillDir))) {
    throw new Error(`Skill not found: ${name}`);
  }

  await fs.promises.writeFile(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
  return { name, content };
}

export async function deleteSkill(name: string): Promise<void> {
  validateName(name);

  const dir = skillsDir();
  const skillDir = path.join(dir, name);

  if (!(await exists(skillDir))) {
    throw new Error(`Skill not found: ${name}`);
  }

  await fs.promises.rm(skillDir, { recursive: true });
}
