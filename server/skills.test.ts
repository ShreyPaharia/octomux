import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { setLogger } from './logger.js';
import { builtInSkillsDir } from './octomux-paths.js';

vi.mock('fs', () => {
  const promises = {
    access: vi.fn(),
    readdir: vi.fn(),
    readFile: vi.fn(),
  };
  return { default: { promises }, promises };
});

const { listSkills, getSkill } = await import('./skills.js');

function enoent(): NodeJS.ErrnoException {
  const err = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

const SKILLS_DIR = builtInSkillsDir();

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fs.promises.access).mockResolvedValue(undefined);
});

describe('listSkills', () => {
  it('returns skills with descriptions parsed from YAML frontmatter', async () => {
    const entries = [
      { name: 'my-skill', isDirectory: () => true },
      { name: 'another-skill', isDirectory: () => true },
    ];
    vi.mocked(fs.promises.readdir).mockResolvedValue(entries as any);
    vi.mocked(fs.promises.readFile).mockImplementation((filePath: any) => {
      if (filePath === path.join(SKILLS_DIR, 'my-skill', 'SKILL.md')) {
        return Promise.resolve('---\ndescription: A cool skill\n---\n# Content');
      }
      if (filePath === path.join(SKILLS_DIR, 'another-skill', 'SKILL.md')) {
        return Promise.resolve('---\ndescription: Another skill\n---\n# More content');
      }
      return Promise.resolve('');
    });

    const result = await listSkills();

    expect(result).toEqual([
      { name: 'another-skill', description: 'Another skill' },
      { name: 'my-skill', description: 'A cool skill' },
    ]);
  });

  it('skips non-directory entries', async () => {
    const entries = [
      { name: 'my-skill', isDirectory: () => true },
      { name: 'readme.txt', isDirectory: () => false },
    ];
    vi.mocked(fs.promises.readdir).mockResolvedValue(entries as any);
    vi.mocked(fs.promises.readFile).mockResolvedValue('---\ndescription: A skill\n---\nContent');

    const result = await listSkills();

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('my-skill');
  });

  it('returns empty description when no frontmatter', async () => {
    const entries = [{ name: 'bare-skill', isDirectory: () => true }];
    vi.mocked(fs.promises.readdir).mockResolvedValue(entries as any);
    vi.mocked(fs.promises.readFile).mockResolvedValue('# Just content, no frontmatter');

    const result = await listSkills();

    expect(result).toEqual([{ name: 'bare-skill', description: '' }]);
  });

  it.each([{ hidden: '.claude' }, { hidden: '.git' }, { hidden: '.cache' }])(
    'skips hidden directory $hidden',
    async ({ hidden }) => {
      const entries = [
        { name: hidden, isDirectory: () => true },
        { name: 'real-skill', isDirectory: () => true },
      ];
      vi.mocked(fs.promises.readdir).mockResolvedValue(entries as any);
      vi.mocked(fs.promises.readFile).mockImplementation((filePath: any) => {
        if (filePath === path.join(SKILLS_DIR, 'real-skill', 'SKILL.md')) {
          return Promise.resolve('---\ndescription: real\n---\n');
        }
        return Promise.reject(enoent());
      });

      const result = await listSkills();

      expect(result).toEqual([{ name: 'real-skill', description: 'real' }]);
      expect(fs.promises.readFile).not.toHaveBeenCalledWith(
        path.join(SKILLS_DIR, hidden, 'SKILL.md'),
        'utf-8',
      );
    },
  );

  it('skips a non-hidden dir whose SKILL.md is missing and warns', async () => {
    const logs: string[] = [];
    const stream = { write: (msg: string) => logs.push(msg) };
    setLogger(pino({ level: 'trace' }, stream));

    const entries = [
      { name: 'broken-skill', isDirectory: () => true },
      { name: 'good-skill', isDirectory: () => true },
    ];
    vi.mocked(fs.promises.readdir).mockResolvedValue(entries as any);
    vi.mocked(fs.promises.readFile).mockImplementation((filePath: any) => {
      if (filePath === path.join(SKILLS_DIR, 'good-skill', 'SKILL.md')) {
        return Promise.resolve('---\ndescription: good\n---\n');
      }
      return Promise.reject(enoent());
    });

    const result = await listSkills();

    expect(result).toEqual([{ name: 'good-skill', description: 'good' }]);
    const warnLine = logs.find((l) => l.includes('"level":40'));
    expect(warnLine).toBeDefined();
    expect(warnLine).toContain('"skill":"broken-skill"');
    expect(warnLine).toContain('"code":"ENOENT"');
  });

  it('rethrows non-ENOENT errors from readFile', async () => {
    const entries = [{ name: 'unreadable', isDirectory: () => true }];
    vi.mocked(fs.promises.readdir).mockResolvedValue(entries as any);
    const eacces = new Error('EACCES') as NodeJS.ErrnoException;
    eacces.code = 'EACCES';
    vi.mocked(fs.promises.readFile).mockRejectedValue(eacces);

    await expect(listSkills()).rejects.toThrow('EACCES');
  });
});

describe('getSkill', () => {
  it('returns skill content', async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue('# My Skill\nSome content');

    const result = await getSkill('my-skill');

    expect(result).toEqual({ name: 'my-skill', content: '# My Skill\nSome content' });
    expect(fs.promises.readFile).toHaveBeenCalledWith(
      path.join(SKILLS_DIR, 'my-skill', 'SKILL.md'),
      'utf-8',
    );
  });

  it('throws on missing skill', async () => {
    vi.mocked(fs.promises.readFile).mockRejectedValue(enoent());

    await expect(getSkill('nonexistent')).rejects.toThrow('Skill not found: nonexistent');
  });

  it('rejects path traversal names', async () => {
    await expect(getSkill('..')).rejects.toThrow('Invalid skill name');
    await expect(getSkill('../etc')).rejects.toThrow('Invalid skill name');
  });
});
