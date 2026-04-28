import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { createTestDb, insertTestTask, execFileOk } from './test-helpers.js';

vi.mock('child_process', () => ({ execFile: vi.fn() }));
import { execFile } from 'child_process';

describe('POST/DELETE /api/tasks/:id/files/*path/reviewed', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    createTestDb();
    insertTestTask({ id: 't1', worktree: '/tmp/wt', base_branch: 'main', base_sha: 'sha0' });
    app = createApp();
    vi.mocked(execFile).mockImplementation(execFileOk('headSha\n') as unknown as typeof execFile);
  });

  it('POST inserts a review-state row with current HEAD as commit', async () => {
    const res = await request(app)
      .post('/api/tasks/t1/files/src/foo.ts/reviewed')
      .send();
    expect(res.status).toBe(204);
    const { listReviewState } = await import('./file-review-state.js');
    const rows = listReviewState('t1');
    expect(rows[0]).toMatchObject({ file_path: 'src/foo.ts', reviewed_at_commit: 'headSha' });
  });

  it('DELETE removes the row', async () => {
    await request(app).post('/api/tasks/t1/files/src/foo.ts/reviewed').send();
    const res = await request(app).delete('/api/tasks/t1/files/src/foo.ts/reviewed').send();
    expect(res.status).toBe(204);
    const { listReviewState } = await import('./file-review-state.js');
    expect(listReviewState('t1')).toEqual([]);
  });

  it('rejects path traversal', async () => {
    const res = await request(app)
      .post('/api/tasks/t1/files/..%2Fetc%2Fpasswd/reviewed')
      .send();
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown task', async () => {
    const res = await request(app).post('/api/tasks/missing/files/src/foo.ts/reviewed').send();
    expect(res.status).toBe(404);
  });

  it('upsert is idempotent', async () => {
    await request(app).post('/api/tasks/t1/files/src/foo.ts/reviewed').send();
    const res = await request(app).post('/api/tasks/t1/files/src/foo.ts/reviewed').send();
    expect(res.status).toBe(204);
  });

  it('DELETE on missing row is idempotent', async () => {
    const res = await request(app).delete('/api/tasks/t1/files/src/foo.ts/reviewed').send();
    expect(res.status).toBe(204);
  });
});
