/**
 * Octomux's own skills, read from the bundled plugin. Single source — see the
 * note on `builtInSkillsDir()` for why the repo and home tiers were removed.
 *
 * A user's personal skills live in Claude Code's native `~/.claude/skills/` and
 * are not listed here; the harness resolves those itself.
 */
import fs from 'fs';
import path from 'path';
import { childLogger } from './logger.js';
import { builtInSkillsDir } from './octomux-paths.js';

const logger = childLogger('skills');

export interface Skill {
  name: string;
  description: string;
}

export interface SkillDetail {
  name: string;
  content: string;
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
      logger.warn(
        { skill: name, code, skills_root: skillsRoot },
        'skipping dir without readable SKILL.md',
      );
      return null;
    }
    throw err;
  }
}

export async function listSkills(): Promise<Skill[]> {
  const dir = builtInSkillsDir();
  const skills: Skill[] = [];

  for (const name of await listSkillNamesInDir(dir)) {
    const content = await readSkillContent(dir, name);
    if (content === null) continue;
    skills.push({ name, description: parseDescription(content) });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSkill(name: string): Promise<SkillDetail> {
  validateName(name);

  const content = await readSkillContent(builtInSkillsDir(), name);
  if (content === null) {
    throw new Error(`Skill not found: ${name}`);
  }

  return { name, content };
}
