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

function getSkillsDir(): string {
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

export async function listSkills(): Promise<Skill[]> {
  const dir = getSkillsDir();

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const skills: Skill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, 'SKILL.md');
    const content = fs.readFileSync(skillFile, 'utf-8');
    skills.push({ name: entry.name, description: parseDescription(content) });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSkill(name: string): Promise<SkillDetail> {
  const dir = getSkillsDir();
  const skillDir = path.join(dir, name);

  if (!fs.existsSync(skillDir)) {
    throw new Error(`Skill not found: ${name}`);
  }

  const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
  return { name, content };
}

export async function createSkill(name: string, content: string): Promise<SkillDetail> {
  validateName(name);

  const dir = getSkillsDir();
  const skillDir = path.join(dir, name);

  if (fs.existsSync(skillDir)) {
    throw new Error(`Skill already exists: ${name}`);
  }

  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8');

  return { name, content };
}

export async function updateSkill(name: string, content: string): Promise<SkillDetail> {
  const dir = getSkillsDir();
  const skillDir = path.join(dir, name);

  if (!fs.existsSync(skillDir)) {
    throw new Error(`Skill not found: ${name}`);
  }

  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf-8');
  return { name, content };
}

export async function deleteSkill(name: string): Promise<void> {
  validateName(name);

  const dir = getSkillsDir();
  const skillDir = path.join(dir, name);

  if (!fs.existsSync(skillDir)) {
    throw new Error(`Skill not found: ${name}`);
  }

  fs.rmSync(skillDir, { recursive: true, force: true });
}
