/**
 * server/orchestrator/artifact-endpoint.test.ts
 *
 * Tests for Task 2.4 / SHR-127: symlink-safe artifact endpoint + lock.
 *
 * Covers:
 *  - Path traversal / escape attempts rejected (403)
 *  - Symlink components in path rejected (403)
 *  - Extension allowlist enforced (.json, .md, .html only)
 *  - GET returns file contents + ETag
 *  - PUT gated on phase==awaiting_approval + artifact_lock_owner
 *  - Conditional PUT: etag conflict → 412
 *  - File not found → 404
 *  - Worktree not found for task → 404
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createTestDb, insertTask } from '../test-helpers.js';
import { getDb } from '../db.js';
import { createConversation, upsertManagedTask } from './store.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../task-runner.js', async () => {
  const { getDb } = await import('../db.js');
  return {
    startTask: vi.fn(async (task: any) => {
      const db = getDb();
      db.prepare(`UPDATE tasks SET runtime_state = 'running', tmux_session = ? WHERE id = ?`).run(
        `octomux-agent-${task.id}`,
        task.id,
      );
      if (task.worktree_id) {
        db.prepare(`UPDATE worktrees SET path = ? WHERE id = ?`).run(
          `/tmp/.worktrees/${task.id}`,
          task.worktree_id,
        );
      }
    }),
    closeTask: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    addAgent: vi.fn().mockResolvedValue({}),
    resumeTask: vi.fn().mockResolvedValue(undefined),
    stopAgent: vi.fn().mockResolvedValue(undefined),
    createUserTerminal: vi.fn().mockResolvedValue({}),
    createShellTerminal: vi.fn().mockResolvedValue({}),
    closeShellTerminal: vi.fn().mockResolvedValue(undefined),
    softDeleteTask: vi.fn().mockResolvedValue(undefined),
    hopAgent: vi.fn().mockResolvedValue(undefined),
  };
});

// ─── Lazy import after mocks ──────────────────────────────────────────────────

import { createApp } from '../app.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

function setupWorktree(taskId: string, worktreeId: string): string {
  const wtPath = path.join(tmpDir, `worktree-${taskId}`);
  fs.mkdirSync(wtPath, { recursive: true });
  // Point the worktree row at the temp directory.
  getDb().prepare(`UPDATE worktrees SET path = ? WHERE id = ?`).run(wtPath, worktreeId);
  return wtPath;
}

function writeArtifact(wtPath: string, relPath: string, content: string): void {
  const full = path.join(wtPath, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/orchestrator/artifact', () => {
  let app: ReturnType<typeof createApp>;
  let taskId: string;
  let worktreeId: string;
  let wtPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-test-'));
    createTestDb();
    app = createApp();

    // Insert a task with a worktree
    const task = insertTask(getDb(), {
      id: 'task-art-001',
      title: 'Artifact test task',
      worktree: '/placeholder',
      repo_path: '/tmp/repo',
    });
    taskId = task.id;
    worktreeId = task.worktree_id!;
    wtPath = setupWorktree(taskId, worktreeId);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('returns file contents and ETag for a valid .json artifact', async () => {
    writeArtifact(wtPath, 'plan.json', JSON.stringify({ schema_version: '1.0.0', summary: 'hi' }));

    const res = await request(app)
      .get('/api/orchestrator/artifact')
      .query({ task: taskId, path: 'plan.json' });

    expect(res.status).toBe(200);
    expect(res.headers['etag']).toBeTruthy();
    expect(res.body).toMatchObject({ schema_version: '1.0.0' });
  });

  it('returns file contents for a .md artifact', async () => {
    writeArtifact(wtPath, 'PLAN.md', '# Plan\n\nDo the thing.');

    const res = await request(app)
      .get('/api/orchestrator/artifact')
      .query({ task: taskId, path: 'PLAN.md' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('# Plan');
  });

  it('returns file contents for a .html artifact', async () => {
    writeArtifact(wtPath, 'report.html', '<html><body>report</body></html>');

    const res = await request(app)
      .get('/api/orchestrator/artifact')
      .query({ task: taskId, path: 'report.html' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<html>');
  });

  it('rejects disallowed extension (.ts)', async () => {
    const res = await request(app)
      .get('/api/orchestrator/artifact')
      .query({ task: taskId, path: 'src/evil.ts' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/extension/i);
  });

  it('rejects disallowed extension (.sh)', async () => {
    const res = await request(app)
      .get('/api/orchestrator/artifact')
      .query({ task: taskId, path: 'run.sh' });

    expect(res.status).toBe(403);
  });

  it('rejects path traversal (../)', async () => {
    const res = await request(app)
      .get('/api/orchestrator/artifact')
      .query({ task: taskId, path: '../../../etc/passwd.md' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/traversal|symlink|path/i);
  });

  it('rejects path traversal (encoded)', async () => {
    const res = await request(app)
      .get('/api/orchestrator/artifact')
      .query({ task: taskId, path: 'foo/../../etc/passwd.md' });

    expect(res.status).toBe(403);
  });

  it('rejects absolute path', async () => {
    const res = await request(app)
      .get('/api/orchestrator/artifact')
      .query({ task: taskId, path: '/etc/passwd.md' });

    expect(res.status).toBe(403);
  });

  it('rejects symlink component in path', async () => {
    // Create a directory with a symlink inside the worktree
    const realDir = path.join(tmpDir, 'real-target');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'secret.md'), 'secret');

    const linkPath = path.join(wtPath, 'link-to-outside');
    fs.symlinkSync(realDir, linkPath);

    const res = await request(app)
      .get('/api/orchestrator/artifact')
      .query({ task: taskId, path: 'link-to-outside/secret.md' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/symlink/i);
  });

  it('rejects a file that is itself a symlink', async () => {
    const realFile = path.join(tmpDir, 'real.json');
    fs.writeFileSync(realFile, '{"x":1}');

    const linkPath = path.join(wtPath, 'link.json');
    fs.symlinkSync(realFile, linkPath);

    const res = await request(app)
      .get('/api/orchestrator/artifact')
      .query({ task: taskId, path: 'link.json' });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/symlink/i);
  });

  it('returns 404 when file does not exist', async () => {
    const res = await request(app)
      .get('/api/orchestrator/artifact')
      .query({ task: taskId, path: 'nonexistent.md' });

    expect(res.status).toBe(404);
  });

  it('returns 404 when task does not exist', async () => {
    const res = await request(app)
      .get('/api/orchestrator/artifact')
      .query({ task: 'no-such-task', path: 'plan.json' });

    expect(res.status).toBe(404);
  });

  it('returns 400 when task query param missing', async () => {
    const res = await request(app).get('/api/orchestrator/artifact').query({ path: 'plan.json' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when path query param missing', async () => {
    const res = await request(app).get('/api/orchestrator/artifact').query({ task: taskId });

    expect(res.status).toBe(400);
  });
});

describe('PUT /api/orchestrator/artifact', () => {
  let app: ReturnType<typeof createApp>;
  let taskId: string;
  let worktreeId: string;
  let wtPath: string;
  let convId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-put-test-'));
    createTestDb();
    app = createApp();

    const task = insertTask(getDb(), {
      id: 'task-art-put-001',
      title: 'Artifact PUT test task',
      worktree: '/placeholder',
      repo_path: '/tmp/repo',
    });
    taskId = task.id;
    worktreeId = task.worktree_id!;
    wtPath = setupWorktree(taskId, worktreeId);

    convId = createConversation({ title: 'PUT test conv' });
    // Set up a managed task in awaiting_approval phase with UI as lock owner
    upsertManagedTask({
      conversation_id: convId,
      task_id: taskId,
      phase: 'awaiting_approval',
      artifact_lock_owner: 'ui',
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('writes the artifact and returns the new ETag when all conditions met', async () => {
    writeArtifact(wtPath, 'plan.json', JSON.stringify({ schema_version: '1.0.0', summary: 'v1' }));

    // First GET to get ETag
    const getRes = await request(app)
      .get('/api/orchestrator/artifact')
      .query({ task: taskId, path: 'plan.json' });
    expect(getRes.status).toBe(200);
    const etag = getRes.headers['etag'];

    // PUT with matching If-Match
    const putRes = await request(app)
      .put('/api/orchestrator/artifact')
      .query({ task: taskId, path: 'plan.json' })
      .set('If-Match', etag)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ schema_version: '1.0.0', summary: 'v2' }));

    expect(putRes.status).toBe(200);
    expect(putRes.headers['etag']).toBeTruthy();
    expect(putRes.headers['etag']).not.toBe(etag);

    // Verify file was written
    const written = fs.readFileSync(path.join(wtPath, 'plan.json'), 'utf8');
    expect(JSON.parse(written)).toMatchObject({ summary: 'v2' });
  });

  it('rejects PUT when phase is not awaiting_approval', async () => {
    upsertManagedTask({
      conversation_id: convId,
      task_id: taskId,
      phase: 'implementing',
      artifact_lock_owner: 'ui',
    });

    writeArtifact(wtPath, 'plan.json', '{}');

    const getRes = await request(app)
      .get('/api/orchestrator/artifact')
      .query({ task: taskId, path: 'plan.json' });
    const etag = getRes.headers['etag'];

    const putRes = await request(app)
      .put('/api/orchestrator/artifact')
      .query({ task: taskId, path: 'plan.json' })
      .set('If-Match', etag)
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(putRes.status).toBe(409);
    expect(putRes.body.error).toMatch(/awaiting_approval|phase|lock/i);
  });

  it('rejects PUT when artifact_lock_owner is not ui', async () => {
    upsertManagedTask({
      conversation_id: convId,
      task_id: taskId,
      phase: 'awaiting_approval',
      artifact_lock_owner: null,
    });

    writeArtifact(wtPath, 'plan.json', '{}');

    const getRes = await request(app)
      .get('/api/orchestrator/artifact')
      .query({ task: taskId, path: 'plan.json' });
    const etag = getRes.headers['etag'];

    const putRes = await request(app)
      .put('/api/orchestrator/artifact')
      .query({ task: taskId, path: 'plan.json' })
      .set('If-Match', etag)
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(putRes.status).toBe(409);
  });

  it('rejects PUT with 412 when ETag does not match (file changed)', async () => {
    writeArtifact(wtPath, 'plan.json', '{"schema_version":"1.0.0","summary":"original"}');

    const getRes = await request(app)
      .get('/api/orchestrator/artifact')
      .query({ task: taskId, path: 'plan.json' });
    const etag = getRes.headers['etag'];

    // Mutate the file between GET and PUT
    fs.writeFileSync(
      path.join(wtPath, 'plan.json'),
      '{"schema_version":"1.0.0","summary":"changed"}',
    );

    const putRes = await request(app)
      .put('/api/orchestrator/artifact')
      .query({ task: taskId, path: 'plan.json' })
      .set('If-Match', etag)
      .set('Content-Type', 'application/json')
      .send('{"schema_version":"1.0.0","summary":"my edit"}');

    expect(putRes.status).toBe(412);
    expect(putRes.body.error).toMatch(/etag|modified|conflict/i);
  });

  it('rejects PUT without If-Match header', async () => {
    writeArtifact(wtPath, 'plan.json', '{}');

    const putRes = await request(app)
      .put('/api/orchestrator/artifact')
      .query({ task: taskId, path: 'plan.json' })
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(putRes.status).toBe(428);
    expect(putRes.body.error).toMatch(/If-Match|etag|required/i);
  });

  it('rejects PUT with path traversal', async () => {
    const putRes = await request(app)
      .put('/api/orchestrator/artifact')
      .query({ task: taskId, path: '../../../evil.md' })
      .set('If-Match', '"abc"')
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(putRes.status).toBe(403);
  });

  it('rejects PUT with disallowed extension', async () => {
    const putRes = await request(app)
      .put('/api/orchestrator/artifact')
      .query({ task: taskId, path: 'evil.sh' })
      .set('If-Match', '"abc"')
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(putRes.status).toBe(403);
  });

  it('rejects PUT for task with no managed_tasks row (not orchestrator-managed)', async () => {
    // Insert a task NOT in managed_tasks but with a valid worktree
    const unTask = insertTask(getDb(), {
      id: 'task-unmanaged',
      title: 'Unmanaged task',
      worktree: '/placeholder-unmanaged',
      repo_path: '/tmp/repo',
    });
    const unwtPath = path.join(tmpDir, 'worktree-unmanaged');
    fs.mkdirSync(unwtPath, { recursive: true });
    getDb()
      .prepare(`UPDATE worktrees SET path = ? WHERE id = ?`)
      .run(unwtPath, unTask.worktree_id!);
    writeArtifact(unwtPath, 'plan.json', '{"schema_version":"1.0.0","summary":"test"}');

    // First GET to obtain a valid ETag (so the 412 check doesn't block us)
    const getRes = await request(app)
      .get('/api/orchestrator/artifact')
      .query({ task: 'task-unmanaged', path: 'plan.json' });
    const etag = getRes.headers['etag'] ?? '"none"';

    const putRes = await request(app)
      .put('/api/orchestrator/artifact')
      .query({ task: 'task-unmanaged', path: 'plan.json' })
      .set('If-Match', etag)
      .set('Content-Type', 'application/json')
      .send('{"schema_version":"1.0.0","summary":"edit"}');

    expect(putRes.status).toBe(409);
  });
});
