import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('fs', () => {
  const promises = {
    access: vi.fn(),
    mkdir: vi.fn(),
    readdir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rm: vi.fn(),
  };
  return { default: { promises }, promises };
});
vi.mock('os');

const { listSkills, getSkill, createSkill, updateSkill, deleteSkill } = await import(
  './skills.js'
);

const SKILLS_DIR = '/mock-home/.claude/skills';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(os.homedir).mockReturnValue('/mock-home');
});

describe('listSkills', () => {
  it('creates directory and returns empty array when dir does not exist', async () => {
    vi.mocked(fs.promises.access).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.promises.readdir).mockResolvedValue([]);

    const result = await listSkills();

    expect(fs.promises.mkdir).toHaveBeenCalledWith(SKILLS_DIR, { recursive: true });
    expect(result).toEqual([]);
  });

  it('returns skills with descriptions parsed from YAML frontmatter', async () => {
    vi.mocked(fs.promises.access).mockResolvedValue(undefined);
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
    vi.mocked(fs.promises.access).mockResolvedValue(undefined);
    const entries = [
      { name: 'my-skill', isDirectory: () => true },
      { name: 'readme.txt', isDirectory: () => false },
    ];
    vi.mocked(fs.promises.readdir).mockResolvedValue(entries as any);
    vi.mocked(fs.promises.readFile).mockResolvedValue(
      '---\ndescription: A skill\n---\nContent',
    );

    const result = await listSkills();

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('my-skill');
  });

  it('returns empty description when no frontmatter', async () => {
    vi.mocked(fs.promises.access).mockResolvedValue(undefined);
    const entries = [{ name: 'bare-skill', isDirectory: () => true }];
    vi.mocked(fs.promises.readdir).mockResolvedValue(entries as any);
    vi.mocked(fs.promises.readFile).mockResolvedValue('# Just content, no frontmatter');

    const result = await listSkills();

    expect(result).toEqual([{ name: 'bare-skill', description: '' }]);
  });
});

describe('getSkill', () => {
  it('returns skill content', async () => {
    vi.mocked(fs.promises.access).mockResolvedValue(undefined);
    vi.mocked(fs.promises.readFile).mockResolvedValue('# My Skill\nSome content');

    const result = await getSkill('my-skill');

    expect(result).toEqual({ name: 'my-skill', content: '# My Skill\nSome content' });
    expect(fs.promises.readFile).toHaveBeenCalledWith(
      path.join(SKILLS_DIR, 'my-skill', 'SKILL.md'),
      'utf-8',
    );
  });

  it('throws on missing skill', async () => {
    vi.mocked(fs.promises.access).mockRejectedValue(new Error('ENOENT'));

    await expect(getSkill('nonexistent')).rejects.toThrow('Skill not found: nonexistent');
  });

  it('rejects path traversal names', async () => {
    await expect(getSkill('..')).rejects.toThrow('Invalid skill name');
    await expect(getSkill('../etc')).rejects.toThrow('Invalid skill name');
  });
});

describe('createSkill', () => {
  it('creates directory and SKILL.md', async () => {
    vi.mocked(fs.promises.access).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

    const result = await createSkill('new-skill', '# New Skill');

    expect(fs.promises.mkdir).toHaveBeenCalledWith(path.join(SKILLS_DIR, 'new-skill'), {
      recursive: true,
    });
    expect(fs.promises.writeFile).toHaveBeenCalledWith(
      path.join(SKILLS_DIR, 'new-skill', 'SKILL.md'),
      '# New Skill',
      'utf-8',
    );
    expect(result).toEqual({ name: 'new-skill', content: '# New Skill' });
  });

  it('rejects path traversal names', async () => {
    await expect(createSkill('..', '# Bad')).rejects.toThrow('Invalid skill name');
    await expect(createSkill('../etc', '# Bad')).rejects.toThrow('Invalid skill name');
  });

  it('rejects names with spaces', async () => {
    await expect(createSkill('my skill', '# Bad')).rejects.toThrow('Invalid skill name');
  });

  it('rejects names with uppercase', async () => {
    await expect(createSkill('MySkill', '# Bad')).rejects.toThrow('Invalid skill name');
  });

  it('rejects duplicate skill', async () => {
    vi.mocked(fs.promises.access).mockResolvedValue(undefined);

    await expect(createSkill('existing-skill', '# Dupe')).rejects.toThrow(
      'Skill already exists: existing-skill',
    );
  });
});

describe('updateSkill', () => {
  it('writes content to existing skill', async () => {
    vi.mocked(fs.promises.access).mockResolvedValue(undefined);
    vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined);

    const result = await updateSkill('my-skill', '# Updated');

    expect(fs.promises.writeFile).toHaveBeenCalledWith(
      path.join(SKILLS_DIR, 'my-skill', 'SKILL.md'),
      '# Updated',
      'utf-8',
    );
    expect(result).toEqual({ name: 'my-skill', content: '# Updated' });
  });

  it('throws on missing skill', async () => {
    vi.mocked(fs.promises.access).mockRejectedValue(new Error('ENOENT'));

    await expect(updateSkill('nonexistent', '# Content')).rejects.toThrow(
      'Skill not found: nonexistent',
    );
  });

  it('rejects path traversal names', async () => {
    await expect(updateSkill('..', '# Bad')).rejects.toThrow('Invalid skill name');
    await expect(updateSkill('../etc', '# Bad')).rejects.toThrow('Invalid skill name');
  });
});

describe('deleteSkill', () => {
  it('removes skill directory', async () => {
    vi.mocked(fs.promises.access).mockResolvedValue(undefined);
    vi.mocked(fs.promises.rm).mockResolvedValue(undefined);

    await deleteSkill('my-skill');

    expect(fs.promises.rm).toHaveBeenCalledWith(path.join(SKILLS_DIR, 'my-skill'), {
      recursive: true,
    });
  });

  it('throws on missing skill', async () => {
    vi.mocked(fs.promises.access).mockRejectedValue(new Error('ENOENT'));

    await expect(deleteSkill('nonexistent')).rejects.toThrow('Skill not found: nonexistent');
  });

  it('rejects path traversal names', async () => {
    await expect(deleteSkill('..')).rejects.toThrow('Invalid skill name');
  });
});
