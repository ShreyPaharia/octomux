import { describe, it, expect, beforeEach, afterEach, vi } from '../../server/bun-test.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createTestDb } from '../../server/test-helpers.js';
import { runPlaybook } from './playbook.js';

let stdoutBuf = '';
let tmpHome: string;

beforeEach(() => {
  stdoutBuf = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => {
    stdoutBuf += String(c);
    return true;
  }) as typeof process.stdout.write);
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-pbcli-'));
  // Spy on homedir rather than setting $HOME: bun resolves os.homedir() once
  // at startup and ignores later env changes.
  vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function seedReviewTask(db: ReturnType<typeof createTestDb>): void {
  db.prepare(
    `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, base_sha, mode, status)
     VALUES ('wt1', '/tmp/wt', '/repos/foo', 'review/x', 'main', 'b', 'new', 'available')`,
  ).run();
  db.prepare(
    `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, source, worktree_id, pr_head_sha)
     VALUES ('t1', 'r', '', 'running', 'backlog', 'auto_review', 'wt1', 'h')`,
  ).run();
}

describe('octomux review playbook', () => {
  it('add then show round-trips the note for the task repo', async () => {
    const db = createTestDb();
    seedReviewTask(db);
    await runPlaybook([
      'add',
      '--task',
      't1',
      '--topic',
      'hot-spots',
      '--note',
      'token.ts fragile',
    ]);
    stdoutBuf = '';
    await runPlaybook(['show', '--task', 't1']);
    const out = JSON.parse(stdoutBuf);
    expect(out.index).toContain('hot-spots.md');
    expect(out.files[0].body).toContain('token.ts fragile');
  });
});
