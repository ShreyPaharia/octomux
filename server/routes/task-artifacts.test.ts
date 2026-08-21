/**
 * `GET /api/tasks/:id/artifacts(/:pluginId/:name)` — the HTTP surface for
 * `ctx.artifacts`. Sibling of `server/routes/plugin-facts.test.ts` in intent;
 * exercises the full `createApp()` stack (DB + error middleware) because the
 * 404 behavior lives in `loadTaskOrFail`/`error-middleware.ts`, not in this
 * router alone.
 */
import { describe, it, expect, beforeEach, afterEach } from '../bun-test.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const { default: request } = await import('supertest');
const { createTestDb, insertTask } = await import('../test-helpers.js');
const { getDb } = await import('../db.js');
const { createApp } = await import('../app.js');
const { writeTaskArtifact } = await import('../artifact-task.js');

describe('task artifacts routes', () => {
  let tmpDir: string;

  beforeEach(() => {
    createTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octomux-task-artifacts-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeTaskWithWorktree(id: string): void {
    const db = getDb();
    insertTask(db, { id, title: 'Artifacts task', description: 'desc', worktree: tmpDir });
  }

  it('lists every artifact for a task with a correct url', async () => {
    makeTaskWithWorktree('art-task-1');
    writeTaskArtifact('art-task-1', 'my-plugin', {
      name: 'report.md',
      mime: 'text/markdown',
      body: '# hello',
    });
    writeTaskArtifact('art-task-1', 'other-plugin', {
      name: 'data.json',
      mime: 'application/json',
      body: '{"a":1}',
    });

    const app = createApp();
    const res = await request(app).get('/api/tasks/art-task-1/artifacts').expect(200);

    expect(res.body.artifacts).toHaveLength(2);
    const byName = Object.fromEntries(
      (res.body.artifacts as Array<{ name: string; url: string; pluginId: string }>).map((a) => [
        a.name,
        a,
      ]),
    );
    expect(byName['report.md'].url).toBe('/api/tasks/art-task-1/artifacts/my-plugin/report.md');
    expect(byName['report.md'].pluginId).toBe('my-plugin');
    expect(byName['data.json'].url).toBe('/api/tasks/art-task-1/artifacts/other-plugin/data.json');
  });

  it('serves the raw body with the stored mime for a render-safe type', async () => {
    makeTaskWithWorktree('art-task-2');
    writeTaskArtifact('art-task-2', 'my-plugin', {
      name: 'notes.txt',
      mime: 'text/plain',
      body: 'plain text body',
    });

    const app = createApp();
    const res = await request(app)
      .get('/api/tasks/art-task-2/artifacts/my-plugin/notes.txt')
      .expect(200);

    expect(res.text).toBe('plain text body');
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('404s for an unknown task', async () => {
    const app = createApp();
    await request(app).get('/api/tasks/does-not-exist/artifacts').expect(404);
    await request(app).get('/api/tasks/does-not-exist/artifacts/my-plugin/report.md').expect(404);
  });

  it('404s for an unknown artifact on a known task', async () => {
    makeTaskWithWorktree('art-task-3');
    const app = createApp();
    await request(app).get('/api/tasks/art-task-3/artifacts/my-plugin/missing.md').expect(404);
  });

  it('returns an empty list for a task with no worktree, not a 404', async () => {
    const db = getDb();
    insertTask(db, {
      id: 'art-task-no-wt',
      title: 'No worktree',
      description: 'desc',
      worktree: null,
    });

    const app = createApp();
    const res = await request(app).get('/api/tasks/art-task-no-wt/artifacts').expect(200);
    expect(res.body.artifacts).toEqual([]);
  });

  it('404s on a traversal attempt in the path segments and reads nothing outside the artifacts dir', async () => {
    makeTaskWithWorktree('art-task-4');
    writeTaskArtifact('art-task-4', 'my-plugin', {
      name: 'safe.txt',
      mime: 'text/plain',
      body: 'safe body',
    });
    // Plant a decoy file outside the artifacts dir that a traversal attempt
    // would reach if the route (or the backend) failed to contain it.
    const secretFile = path.join(tmpDir, 'secret.txt');
    fs.writeFileSync(secretFile, 'top secret', 'utf8');

    const app = createApp();

    // '..' segments encoded so express/supertest deliver them as literal path
    // segments rather than having node's URL normalizer collapse them first.
    const attempts = [
      '/api/tasks/art-task-4/artifacts/my-plugin/..%2F..%2Fsecret.txt',
      '/api/tasks/art-task-4/artifacts/..%2Fmy-plugin/safe.txt',
      '/api/tasks/art-task-4/artifacts/my-plugin/a%2Fb',
    ];
    for (const url of attempts) {
      const res = await request(app).get(url);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('top secret');
    }
  });

  it('does not serve a text/html artifact as renderable text/html', async () => {
    makeTaskWithWorktree('art-task-5');
    writeTaskArtifact('art-task-5', 'my-plugin', {
      name: 'page.html',
      mime: 'text/html',
      body: '<script>alert(1)</script>',
    });

    const app = createApp();
    const res = await request(app)
      .get('/api/tasks/art-task-5/artifacts/my-plugin/page.html')
      .expect(200);

    // Defense chosen: force download for anything outside a small render-safe
    // mime allowlist, rather than special-casing html/svg. text/html isn't in
    // that allowlist, so it must come back as an attachment with nosniff set
    // — a browser must not be handed this as inline, same-origin HTML.
    expect(res.headers['content-disposition']).toBe('attachment');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
