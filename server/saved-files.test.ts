import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  listSavedFiles,
  getSavedFile,
  putSavedFile,
  resolveSavedFilePath,
} from './saved-files.js';
import { repoFilesDir } from './octomux-paths.js';

describe('saved-files', () => {
  const tmpDir = path.join(os.tmpdir(), `octomux-saved-files-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('listSavedFiles returns [] when directory missing', async () => {
    expect(await listSavedFiles(tmpDir)).toEqual([]);
  });

  it('put/get round-trip writes under .octomux/files/', async () => {
    await putSavedFile(tmpDir, 'notes/todo.md', '# Todo\n- item');
    const file = await getSavedFile(tmpDir, 'notes/todo.md');
    expect(file.content).toBe('# Todo\n- item');
    expect(fs.existsSync(path.join(repoFilesDir(tmpDir), 'notes', 'todo.md'))).toBe(true);
  });

  it('listSavedFiles returns nested files', async () => {
    await putSavedFile(tmpDir, 'a.md', 'a');
    await putSavedFile(tmpDir, 'dir/b.md', 'b');
    const files = await listSavedFiles(tmpDir);
    expect(files.map((f) => f.path)).toEqual(['a.md', 'dir/b.md']);
  });

  it('rejects path traversal', () => {
    expect(resolveSavedFilePath(tmpDir, '../etc/passwd')).toEqual({
      rejected: 'path traversal detected',
    });
  });

  it('rejects disallowed extension', () => {
    expect(resolveSavedFilePath(tmpDir, 'evil.exe')).toEqual({
      rejected: 'extension ".exe" is not allowed; allowed: .md, .txt, .json, .yaml, .yml, .csv, .html',
    });
  });

  it('getSavedFile throws for missing file', async () => {
    await expect(getSavedFile(tmpDir, 'missing.md')).rejects.toThrow('File not found');
  });
});
