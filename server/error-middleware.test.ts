import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { ServiceError } from './services/errors.js';
import express from 'express';

describe('errorMiddleware', () => {
  it('maps ServiceError to status + { error } JSON', async () => {
    const app = express();
    app.get('/test', () => {
      throw new ServiceError('Task not found', 404);
    });
    const { errorMiddleware } = await import('./error-middleware.js');
    app.use(errorMiddleware);

    const res = await request(app).get('/test');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Task not found' });
  });

  it('preserves custom error body on ServiceError', async () => {
    const app = express();
    app.get('/test', () => {
      throw new ServiceError('config validation failed', 400, {
        error: 'config validation failed',
        details: ['name is required'],
      });
    });
    const { errorMiddleware } = await import('./error-middleware.js');
    app.use(errorMiddleware);

    const res = await request(app).get('/test');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'config validation failed',
      details: ['name is required'],
    });
  });

  it('maps loadTaskOrFail through createApp routes', async () => {
    const app = createApp();
    const res = await request(app).get('/api/tasks/nonexistent-id');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Task not found' });
  });
});
