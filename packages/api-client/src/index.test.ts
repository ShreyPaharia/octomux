import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequestCore, qs } from './index.js';

describe('qs', () => {
  it.each([
    [{}, ''],
    [{ repo_path: 'a/b' }, '?repo_path=a%2Fb'],
    [{ a: '1', b: undefined }, '?a=1'],
    [{ x: 'a&b', y: 'c=d' }, '?x=a%26b&y=c%3Dd'],
  ] as const)('qs(%j) → %s', (params, expected) => {
    expect(qs(params)).toBe(expected);
  });
});

describe('createRequestCore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('deduplicates in-flight GET requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { request } = createRequestCore({ baseUrl: '/api' });
    const [a, b] = await Promise.all([request('/tasks'), request('/tasks')]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
  });

  it('does not deduplicate non-GET requests', async () => {
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { request } = createRequestCore({ baseUrl: '/api' });
    await Promise.all([
      request('/tasks', { method: 'POST', body: '{}' }),
      request('/tasks', { method: 'POST', body: '{}' }),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps API errors from JSON body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const { request } = createRequestCore({ baseUrl: '/api' });
    await expect(request('/missing')).rejects.toThrow('not found');
  });

  it('returns undefined for 204 responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    const { request } = createRequestCore({ baseUrl: '/api' });
    await expect(request('/gone', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('calls onFetchError for network failures', async () => {
    const networkErr = new Error('connection refused');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(networkErr));

    const onFetchError = vi.fn((err: unknown) => {
      throw new Error(`wrapped: ${(err as Error).message}`);
    });

    const { request } = createRequestCore({ baseUrl: 'http://localhost:7777/api', onFetchError });
    await expect(request('/tasks')).rejects.toThrow('wrapped: connection refused');
    expect(onFetchError).toHaveBeenCalledWith(networkErr, {
      baseUrl: 'http://localhost:7777/api',
    });
  });
});
