import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { findInstructionFiles } from './instruction-files.js';

let tmpDir: string;

function write(rel: string, content = 'x'): void {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('findInstructionFiles', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-instr-'));
  });

  it('finds root-level CLAUDE.md, AGENTS.md, CONTRIBUTING.md, REVIEW.md', () => {
    write('CLAUDE.md');
    write('AGENTS.md');
    write('CONTRIBUTING.md');
    write('REVIEW.md');
    const result = findInstructionFiles(tmpDir);
    const paths = result.map((r) => r.path);
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('AGENTS.md');
    expect(paths).toContain('CONTRIBUTING.md');
    expect(paths).toContain('REVIEW.md');
  });

  it('returns scope="root" for top-level files', () => {
    write('CLAUDE.md');
    const result = findInstructionFiles(tmpDir);
    expect(result[0].scope).toBe('root');
  });

  it('returns scope set to the parent directory for nested .agents/REVIEW.md', () => {
    write('src/.agents/REVIEW.md');
    const result = findInstructionFiles(tmpDir);
    const file = result.find((r) => r.path === 'src/.agents/REVIEW.md');
    expect(file?.scope).toBe('src/');
  });

  it('returns scope=src/ for nested .cursor/rules/foo.mdc', () => {
    write('src/.cursor/rules/foo.mdc');
    const result = findInstructionFiles(tmpDir);
    const file = result.find((r) => r.path === 'src/.cursor/rules/foo.mdc');
    expect(file?.scope).toBe('src/');
  });

  it('skips files larger than 64KB and logs a warning', () => {
    const big = 'x'.repeat(64 * 1024 + 1);
    write('BIG.md', big);
    write('SMALL.md', 'ok');
    write('CLAUDE.md', 'ok');
    const result = findInstructionFiles(tmpDir);
    const paths = result.map((r) => r.path);
    expect(paths).toContain('CLAUDE.md');
    expect(paths).not.toContain('BIG.md');
  });

  it('matches .cursorrules and .windsurfrules at root', () => {
    write('.cursorrules');
    write('.windsurfrules');
    const result = findInstructionFiles(tmpDir);
    const paths = result.map((r) => r.path);
    expect(paths).toContain('.cursorrules');
    expect(paths).toContain('.windsurfrules');
  });
});
