/**
 * POST /api/tasks/:id/pastes — the web-terminal image-paste upload.
 *
 * `sessionFor` is mocked at the compute boundary: this file owns the route
 * contract (validation, size/type caps, the base64-decode exec handed to the
 * task's compute session), not the compute providers themselves.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from '../bun-test.js';

const mkdirp = vi.fn(async (_p: string) => {});
const exec = vi.fn(async (_argv: string[], _opts?: unknown) => ({
  stdout: '',
  stderr: '',
  exitCode: 0,
}));

vi.mock('../compute/index.js', () => {
  const actual = vi.importActual<typeof import('../compute/index.js')>('../compute/index.js');
  return {
    ...actual,
    sessionFor: vi.fn(async () => ({ files: { mkdirp }, exec })),
  };
});

const { default: request } = await import('supertest');
const { createTestDb, insertTask, DEFAULTS, createTestHttpServer } =
  await import('../test-helpers.js');
const { getDb } = await import('../db.js');
const { createApp } = await import('../app.js');

const http_ = createTestHttpServer();

beforeEach(() => {
  createTestDb();
  http_.use(createApp() as unknown as (req: unknown, res: unknown) => void);
  mkdirp.mockClear();
  exec.mockClear();
});

afterAll(() => {
  http_.close();
});

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function insertPasteTask(worktree: string | null = '/tmp/wt') {
  const task = insertTask(getDb(), { ...DEFAULTS.task, worktree });
  return task;
}

describe('POST /api/tasks/:id/pastes', () => {
  it('writes the image into <worktree>/.octomux/pastes via the compute session and returns its path', async () => {
    const task = insertPasteTask();

    const res = await request(http_.server)
      .post(`/api/tasks/${task.id}/pastes`)
      .set('Content-Type', 'image/png')
      .send(PNG_BYTES);

    expect(res.status).toBe(201);
    expect(res.body.path).toMatch(new RegExp(`^/tmp/wt/\\.octomux/pastes/\\d+\\.png$`));
    expect(mkdirp).toHaveBeenCalledWith('/tmp/wt/.octomux/pastes');
    // The decode runs compute-side (ComputeFiles.write is string-only, which
    // would mangle binary through a remote provider).
    const [argv, opts] = exec.mock.calls[0] as [string[], { input: string }];
    expect(argv).toEqual(['sh', '-c', 'base64 -d > "$0"', res.body.path]);
    expect(Buffer.from(opts.input, 'base64')).toEqual(PNG_BYTES);
  });

  it('maps jpeg to a .jpg extension', async () => {
    const task = insertPasteTask();
    const res = await request(http_.server)
      .post(`/api/tasks/${task.id}/pastes`)
      .set('Content-Type', 'image/jpeg')
      .send(PNG_BYTES);
    expect(res.status).toBe(201);
    expect(res.body.path).toMatch(/\.jpg$/);
  });

  it('rejects a non-image content type with 400 and writes nothing', async () => {
    const task = insertPasteTask();
    const res = await request(http_.server)
      .post(`/api/tasks/${task.id}/pastes`)
      .set('Content-Type', 'application/pdf')
      .send(PNG_BYTES);
    expect(res.status).toBe(400);
    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects an empty body with 400', async () => {
    const task = insertPasteTask();
    const res = await request(http_.server)
      .post(`/api/tasks/${task.id}/pastes`)
      .set('Content-Type', 'image/png')
      .send(Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects a body over 10MB with 413', async () => {
    const task = insertPasteTask();
    // fetch, not supertest: superagent under bun never surfaces the early 413
    // the server sends while the client is still streaming the body.
    const { port } = http_.server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}/pastes`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: new Uint8Array(10 * 1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
    expect(exec).not.toHaveBeenCalled();
  });

  it('404s for an unknown task', async () => {
    const res = await request(http_.server)
      .post('/api/tasks/nope/pastes')
      .set('Content-Type', 'image/png')
      .send(PNG_BYTES);
    expect(res.status).toBe(404);
  });

  it('400s for a task without a worktree', async () => {
    const task = insertPasteTask(null);
    const res = await request(http_.server)
      .post(`/api/tasks/${task.id}/pastes`)
      .set('Content-Type', 'image/png')
      .send(PNG_BYTES);
    expect(res.status).toBe(400);
    expect(exec).not.toHaveBeenCalled();
  });
});
