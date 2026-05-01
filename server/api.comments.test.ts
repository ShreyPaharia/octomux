import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createTestDb, insertTestTask, findCallback } from './test-helpers.js';

vi.mock('fs', () => ({
  default: {
    statSync: vi.fn(() => ({ isDirectory: () => true })),
    readdirSync: vi.fn(() => []),
    existsSync: vi.fn(() => true),
    promises: {
      stat: vi.fn(async () => ({ isDirectory: () => true })),
      readdir: vi.fn(async () => []),
      access: vi.fn(async () => {}),
    },
  },
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('./diff.js', () => ({
  getDiffSummary: vi.fn(),
  getFileDiff: vi.fn(),
  safeResolvePath: (wt: string, p: string) => {
    if (!p || p.includes('..') || p.startsWith('/')) throw new Error('Invalid path');
    return `${wt}/${p}`;
  },
  MAX_FILE_BYTES: 1_048_576,
}));

const { execFile } = await import('child_process');
const diffMod = await import('./diff.js');
const { createApp } = await import('./app.js');

type ExecResult = { stdout: string; stderr?: string };
type ExecMatcher = (cmd: string, args: string[]) => ExecResult | Error | undefined;

function setExecImpl(matcher: ExecMatcher): void {
  vi.mocked(execFile).mockImplementation(((cmd: string, args: string[], ...rest: any[]) => {
    const cb = findCallback(...rest);
    const result = matcher(cmd, args);
    if (!cb) return undefined as any;
    if (result instanceof Error) cb(result);
    else if (result) cb(null, { stdout: result.stdout, stderr: result.stderr ?? '' });
    else cb(null, { stdout: '', stderr: '' });
    return undefined as any;
  }) as unknown as typeof execFile);
}

const ANCHORED = 'line1\nline2\nline3\nline4\n';

function defaultExecMatcher(cmd: string, args: string[]): ExecResult | Error | undefined {
  if (cmd !== 'git') return undefined;
  if (args.includes('rev-parse')) return { stdout: 'headSha\n' };
  if (args.includes('show')) return { stdout: ANCHORED };
  return { stdout: '' };
}

describe('inline comments API', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.restoreAllMocks();
    createTestDb();
    insertTestTask({
      id: 't1',
      worktree: '/tmp/wt',
      base_branch: 'main',
      base_sha: 'baseSha',
    });
    app = createApp();
    setExecImpl(defaultExecMatcher);
    vi.mocked(diffMod.getFileDiff).mockResolvedValue({
      oldContent: ANCHORED,
      newContent: ANCHORED,
      status: 'M',
      tooLarge: false,
      binary: false,
      isDirectory: false,
    });
  });

  describe('POST /api/tasks/:id/comments', () => {
    it('creates a comment and resolves HEAD when anchor_commit_sha omitted', async () => {
      const res = await request(app)
        .post('/api/tasks/t1/comments')
        .send({ file_path: 'src/foo.ts', line: 2, side: 'new', body: 'nit' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        task_id: 't1',
        file_path: 'src/foo.ts',
        line: 2,
        side: 'new',
        original_commit_sha: 'headSha',
        body: 'nit',
        agent_id: null,
      });
    });

    it('uses explicit anchor_commit_sha when provided', async () => {
      const res = await request(app).post('/api/tasks/t1/comments').send({
        file_path: 'src/foo.ts',
        line: 1,
        side: 'new',
        body: 'x',
        anchor_commit_sha: 'pinnedSha',
      });
      expect(res.status).toBe(201);
      expect(res.body.original_commit_sha).toBe('pinnedSha');
    });

    it.each([
      ['missing body', { file_path: 'a.ts', line: 1, side: 'new' }],
      ['empty body', { file_path: 'a.ts', line: 1, side: 'new', body: '   ' }],
      ['bad side', { file_path: 'a.ts', line: 1, side: 'middle', body: 'x' }],
      ['non-integer line', { file_path: 'a.ts', line: 1.5, side: 'new', body: 'x' }],
      ['zero line', { file_path: 'a.ts', line: 0, side: 'new', body: 'x' }],
      ['missing file_path', { line: 1, side: 'new', body: 'x' }],
      ['path traversal', { file_path: '../etc/passwd', line: 1, side: 'new', body: 'x' }],
    ])('400 on %s', async (_name, body) => {
      const res = await request(app).post('/api/tasks/t1/comments').send(body);
      expect(res.status).toBe(400);
    });

    it('400 when line is out of range at anchor commit', async () => {
      const res = await request(app)
        .post('/api/tasks/t1/comments')
        .send({ file_path: 'a.ts', line: 999, side: 'new', body: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/line out of range/);
    });

    it('400 when current file is binary', async () => {
      vi.mocked(diffMod.getFileDiff).mockResolvedValueOnce({
        oldContent: '',
        newContent: '',
        status: 'B',
        tooLarge: false,
        binary: true,
        isDirectory: false,
      });
      const res = await request(app)
        .post('/api/tasks/t1/comments')
        .send({ file_path: 'img.png', line: 1, side: 'new', body: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/binary/);
    });

    it('400 for scratch run_mode', async () => {
      insertTestTask({
        id: 'scratch1',
        run_mode: 'scratch',
        worktree: null,
        base_branch: null,
        base_sha: null,
      });
      const res = await request(app)
        .post('/api/tasks/scratch1/comments')
        .send({ file_path: 'a.ts', line: 1, side: 'new', body: 'x' });
      expect(res.status).toBe(400);
    });

    it('404 for unknown task', async () => {
      const res = await request(app)
        .post('/api/tasks/missing/comments')
        .send({ file_path: 'a.ts', line: 1, side: 'new', body: 'x' });
      expect(res.status).toBe(404);
    });

    it('400 when file is missing at anchor commit', async () => {
      setExecImpl((cmd, args) => {
        if (args.includes('rev-parse')) return { stdout: 'headSha\n' };
        if (args.includes('show')) return new Error('not found');
        return { stdout: '' };
      });
      const res = await request(app)
        .post('/api/tasks/t1/comments')
        .send({ file_path: 'src/foo.ts', line: 1, side: 'new', body: 'x' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/tasks/:id/comments', () => {
    async function seed(file = 'src/foo.ts', line = 2, body = 'hello') {
      const res = await request(app)
        .post('/api/tasks/t1/comments')
        .send({ file_path: file, line, side: 'new', body });
      expect(res.status).toBe(201);
      return res.body;
    }

    it('returns shape { comments }', async () => {
      await seed();
      const res = await request(app).get('/api/tasks/t1/comments');
      expect(res.status).toBe(200);
      expect(res.body.comments).toHaveLength(1);
      expect(res.body.comments[0]).toMatchObject({ file_path: 'src/foo.ts', line: 2 });
    });

    it('filters by ?file=', async () => {
      await seed('a.ts', 1, 'A');
      await seed('b.ts', 1, 'B');
      const res = await request(app).get('/api/tasks/t1/comments?file=b.ts');
      expect(res.body.comments.map((c: any) => c.body)).toEqual(['B']);
    });

    it.each([
      // anchored line text matches current text → not outdated
      ['unchanged', 'line2', 'line2', false],
      // current line differs from anchor → outdated
      ['changed', 'line2', 'CHANGED', true],
    ])('outdated computation %s', async (_name, anchorLine, currentLine, expected) => {
      const buildContent = (l2: string) => `line1\n${l2}\nline3\nline4\n`;
      // Seed via direct execFile mock returning the original anchored content.
      setExecImpl((cmd, args) => {
        if (args.includes('rev-parse')) return { stdout: 'headSha\n' };
        if (args.includes('show')) return { stdout: buildContent(anchorLine) };
        return { stdout: '' };
      });
      vi.mocked(diffMod.getFileDiff).mockResolvedValue({
        oldContent: buildContent(anchorLine),
        newContent: buildContent(anchorLine),
        status: 'M',
        tooLarge: false,
        binary: false,
        isDirectory: false,
      });
      await seed('src/foo.ts', 2, 'x');

      // Now read with possibly-changed current text.
      vi.mocked(diffMod.getFileDiff).mockResolvedValue({
        oldContent: buildContent(currentLine),
        newContent: buildContent(currentLine),
        status: 'M',
        tooLarge: false,
        binary: false,
        isDirectory: false,
      });
      // For computeOutdated, git show is called with the anchored sha — return original.
      setExecImpl((cmd, args) => {
        if (args.includes('show')) return { stdout: buildContent(anchorLine) };
        return { stdout: '' };
      });

      const res = await request(app).get('/api/tasks/t1/comments');
      expect(res.body.comments).toHaveLength(1);
      expect(res.body.comments[0].outdated).toBe(expected);
    });

    it('outdated_unavailable when worktree missing on disk', async () => {
      await seed();
      const fs = (await import('fs')).default;
      vi.mocked(fs.existsSync).mockImplementation(() => false);
      const res = await request(app).get('/api/tasks/t1/comments');
      expect(res.status).toBe(200);
      expect(res.body.outdated_unavailable).toBe(true);
      expect(res.body.comments[0].outdated).toBe(false);
    });
  });

  describe('PATCH /api/tasks/:id/comments/:cid', () => {
    async function seed() {
      const r = await request(app)
        .post('/api/tasks/t1/comments')
        .send({ file_path: 'a.ts', line: 1, side: 'new', body: 'x' });
      return r.body.id as string;
    }

    it('toggles resolved', async () => {
      const id = await seed();
      const r1 = await request(app).patch(`/api/tasks/t1/comments/${id}`).send({ resolved: true });
      expect(r1.status).toBe(200);
      expect(r1.body.resolved_at).toBeTruthy();
      const r2 = await request(app).patch(`/api/tasks/t1/comments/${id}`).send({ resolved: false });
      expect(r2.body.resolved_at).toBeNull();
    });

    it('updates body', async () => {
      const id = await seed();
      const r = await request(app).patch(`/api/tasks/t1/comments/${id}`).send({ body: 'updated' });
      expect(r.body.body).toBe('updated');
    });

    it('rejects empty body', async () => {
      const id = await seed();
      const r = await request(app).patch(`/api/tasks/t1/comments/${id}`).send({ body: '   ' });
      expect(r.status).toBe(400);
    });

    it('404 when comment belongs to another task', async () => {
      const id = await seed();
      insertTestTask({
        id: 't2',
        worktree: '/tmp/wt2',
        base_branch: 'main',
        base_sha: 'baseSha',
      });
      const r = await request(app).patch(`/api/tasks/t2/comments/${id}`).send({ resolved: true });
      expect(r.status).toBe(404);
    });
  });

  describe('DELETE /api/tasks/:id/comments/:cid', () => {
    it('returns 204 then 404 on second call', async () => {
      const r1 = await request(app)
        .post('/api/tasks/t1/comments')
        .send({ file_path: 'a.ts', line: 1, side: 'new', body: 'x' });
      const id = r1.body.id;
      const d1 = await request(app).delete(`/api/tasks/t1/comments/${id}`);
      expect(d1.status).toBe(204);
      const d2 = await request(app).delete(`/api/tasks/t1/comments/${id}`);
      expect(d2.status).toBe(404);
    });
  });
});
