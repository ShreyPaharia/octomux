import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import request from 'supertest';
import { createTestDb, insertTask } from '../test-helpers.js';
import { createApp } from '../app.js';
import { getTaskExternalRefs } from '../repositories/index.js';

describe('task-workflow refs endpoints — multi-ticket', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = createTestDb();
    app = createApp();
    insertTask(db, { id: 'task-ref-1' });
  });

  it('POST /api/tasks/:id/refs adds two refs for the same integration', async () => {
    await request(app)
      .post('/api/tasks/task-ref-1/refs')
      .send({ integration: 'linear', ref: 'SHR-1', url: null })
      .expect(201);

    await request(app)
      .post('/api/tasks/task-ref-1/refs')
      .send({ integration: 'linear', ref: 'SHR-2', url: null })
      .expect(201);

    const refs = getTaskExternalRefs('task-ref-1');
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.ref).sort()).toEqual(['SHR-1', 'SHR-2']);
  });

  it('DELETE /api/tasks/:id/refs/:integration?ref= deletes only that ref', async () => {
    await request(app)
      .post('/api/tasks/task-ref-1/refs')
      .send({ integration: 'linear', ref: 'SHR-1' })
      .expect(201);
    await request(app)
      .post('/api/tasks/task-ref-1/refs')
      .send({ integration: 'linear', ref: 'SHR-2' })
      .expect(201);

    // Delete only SHR-1
    await request(app)
      .delete('/api/tasks/task-ref-1/refs/linear?ref=SHR-1')
      .expect(204);

    const refs = getTaskExternalRefs('task-ref-1');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.ref).toBe('SHR-2');
  });

  it('DELETE /api/tasks/:id/refs/:integration without ?ref deletes all', async () => {
    await request(app)
      .post('/api/tasks/task-ref-1/refs')
      .send({ integration: 'linear', ref: 'SHR-1' })
      .expect(201);
    await request(app)
      .post('/api/tasks/task-ref-1/refs')
      .send({ integration: 'linear', ref: 'SHR-2' })
      .expect(201);

    await request(app)
      .delete('/api/tasks/task-ref-1/refs/linear')
      .expect(204);

    const refs = getTaskExternalRefs('task-ref-1');
    expect(refs).toHaveLength(0);
  });

  it('DELETE returns 404 when ref does not exist', async () => {
    await request(app)
      .post('/api/tasks/task-ref-1/refs')
      .send({ integration: 'linear', ref: 'SHR-1' })
      .expect(201);

    await request(app)
      .delete('/api/tasks/task-ref-1/refs/linear?ref=SHR-99')
      .expect(404);
  });
});
