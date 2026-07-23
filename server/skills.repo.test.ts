import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { listSkills, getSkill } from './skills.js';
import { repoSkillsDir } from './octomux-paths.js';

describe('skills repo precedence', () => {
  const repoDir = path.join(os.tmpdir(), `octomux-skills-repo-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(path.join(repoDir, '.octomux', 'skills', 'repo-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, '.octomux', 'skills', 'repo-skill', 'SKILL.md'),
      '---\ndescription: From repo\n---\n# Repo skill',
    );
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('listSkills includes repo skills when repoPath is set', async () => {
    const skills = await listSkills({ repoPath: repoDir });
    expect(skills.some((s) => s.name === 'repo-skill')).toBe(true);
    const repoSkill = skills.find((s) => s.name === 'repo-skill');
    expect(repoSkill?.description).toBe('From repo');
  });

  it('listSkills includes the built-in prod-log-triage skill', async () => {
    const skills = await listSkills({ repoPath: repoDir });
    const triage = skills.find((s) => s.name === 'prod-log-triage');
    expect(triage).toBeDefined();
    expect(triage?.description.length).toBeGreaterThan(0);
  });

  it('getSkill reads repo skill without home copy', async () => {
    const skill = await getSkill('repo-skill', { repoPath: repoDir });
    expect(skill.content).toContain('# Repo skill');
    expect(fs.existsSync(path.join(repoSkillsDir(repoDir), 'repo-skill', 'SKILL.md'))).toBe(true);
  });
});
