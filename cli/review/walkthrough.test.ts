import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createTestDb } from '../../server/test-helpers.js';
import { runWalkthrough } from './walkthrough.js';
import { getReviewRun } from '../../server/repositories/review-runs.js';

vi.mock('@octomux/diff-engine', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    listChangedFiles: vi.fn(async () => ['server/db.ts', 'package-lock.json']),
  };
});

let tmpDir: string;
let stderrBuf = '';

beforeEach(() => {
  stderrBuf = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderrBuf += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-wt-'));
});

const VALID = {
  global: {
    type: 'Enhancement',
    risk: 'low',
    effort: 2,
    relevant_tests: 'yes',
    security_concerns: null,
    ticket_compliance: [],
    summary: 's',
    key_review_points: ['x'],
  },
  groups: [
    {
      name: 'Schema',
      summary: '',
      files: [{ path: 'server/db.ts', label: 'dependencies', summary: 's' }],
    },
  ],
};

function seedRunningTask(): void {
  const db = createTestDb();
  db.prepare(
    `INSERT INTO worktrees (id, path, repo_path, branch, base_branch, base_sha, mode, status)
     VALUES ('wt1', ?, '/repos/foo', 'review/x', 'main', 'sha-base', 'new', 'available')`,
  ).run(tmpDir);
  db.prepare(
    `INSERT INTO tasks (id, title, description, runtime_state, workflow_status, source, worktree_id, pr_head_sha)
     VALUES ('t1', 'x', '', 'running', 'backlog', 'auto_review', 'wt1', 'sha-head')`,
  ).run();
  db.prepare(
    `INSERT INTO review_runs (id, task_id, pr_head_sha) VALUES ('r1', 't1', 'sha-head')`,
  ).run();
}

describe('octomux review walkthrough', () => {
  it('ingests a valid walkthrough JSON and appends an Other changes orphan group', async () => {
    seedRunningTask();
    const file = path.join(tmpDir, 'wt.json');
    fs.writeFileSync(file, JSON.stringify(VALID));
    await runWalkthrough(['--task', 't1', '--json-file', file]);
    const run = getReviewRun('r1');
    const ingested = JSON.parse(run!.walkthrough!) as typeof VALID & { groups: { name: string }[] };
    const groupNames = ingested.groups.map((g) => g.name);
    expect(groupNames).toContain('Schema');
    expect(groupNames).toContain('Other changes');
    expect(stderrBuf).toMatch(/auto-appended/);
  });

  it('rejects when the JSON references a file not in the diff', async () => {
    seedRunningTask();
    const bad = {
      ...VALID,
      groups: [
        {
          name: 'X',
          summary: '',
          files: [{ path: 'made/up.ts', label: 'miscellaneous', summary: '' }],
        },
      ],
    };
    const file = path.join(tmpDir, 'wt.json');
    fs.writeFileSync(file, JSON.stringify(bad));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit);
    await expect(runWalkthrough(['--task', 't1', '--json-file', file])).rejects.toThrow(/exit 2/);
    expect(stderrBuf).toMatch(/hallucinated file path: made\/up\.ts/);
    exitSpy.mockRestore();
  });
});
