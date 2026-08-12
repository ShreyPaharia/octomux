import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_CLASS_HEADER, createRequestCore, qs } from './index.js';

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

describe('createRequestCore — client class header', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubFetch() {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  function sentHeaders(fetchMock: ReturnType<typeof stubFetch>): Record<string, string> {
    return fetchMock.mock.calls[0][1].headers as Record<string, string>;
  }

  it.each([['ui'], ['cli']] as const)(
    'sends %s as the client class header',
    async (clientClass) => {
      const fetchMock = stubFetch();
      const { request } = createRequestCore({ baseUrl: '/api', clientClass });

      await request('/tasks');

      expect(sentHeaders(fetchMock)[CLIENT_CLASS_HEADER]).toBe(clientClass);
    },
  );

  it('omits the header when no client class is given, so the server fails closed', async () => {
    const fetchMock = stubFetch();
    const { request } = createRequestCore({ baseUrl: '/api' });

    await request('/tasks');

    expect(sentHeaders(fetchMock)).not.toHaveProperty(CLIENT_CLASS_HEADER);
  });

  // Regression: `{ headers, ...init }` let a caller's own `headers` replace the
  // defaults outright, silently dropping Content-Type and the client class.
  it('merges caller headers with the defaults instead of replacing them', async () => {
    const fetchMock = stubFetch();
    const { request } = createRequestCore({ baseUrl: '/api', clientClass: 'cli' });

    await request('/tasks', { method: 'POST', body: '{}', headers: { 'X-Trace': 'abc' } });

    expect(sentHeaders(fetchMock)).toEqual({
      'Content-Type': 'application/json',
      [CLIENT_CLASS_HEADER]: 'cli',
      'X-Trace': 'abc',
    });
  });

  it('lets a caller deliberately override a default header', async () => {
    const fetchMock = stubFetch();
    const { request } = createRequestCore({ baseUrl: '/api', clientClass: 'cli' });

    await request('/tasks', { headers: { [CLIENT_CLASS_HEADER]: 'ui' } });

    expect(sentHeaders(fetchMock)[CLIENT_CLASS_HEADER]).toBe('ui');
  });
});
