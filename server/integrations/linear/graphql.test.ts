import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { linearGraphql, LinearApiError } from './graphql.js';

describe('linearGraphql', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs to api.linear.app with the bare api key as Authorization', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: { viewer: { id: 'u1', name: 'Test' } } }),
    });

    const result = await linearGraphql('lin_api_xyz', 'query { viewer { id name } }');
    expect(result).toEqual({ viewer: { id: 'u1', name: 'Test' } });

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.linear.app/graphql');
    expect(opts.method).toBe('POST');
    const headers = opts.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('lin_api_xyz');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('passes variables in the body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ data: { issue: { id: 'iss-1' } } }),
    });

    await linearGraphql('k', 'query I($id: String!) { issue(id: $id) { id } }', { id: 'BAC-1' });

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({
      query: 'query I($id: String!) { issue(id: $id) { id } }',
      variables: { id: 'BAC-1' },
    });
  });

  it('throws LinearApiError when response contains errors[]', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        errors: [
          { message: 'Authentication failed', extensions: { code: 'AUTHENTICATION_ERROR' } },
        ],
      }),
    });

    await expect(linearGraphql('bad', 'query { viewer { id } }')).rejects.toThrow(LinearApiError);
    await expect(linearGraphql('bad', 'query { viewer { id } }')).rejects.toThrow(
      /Authentication failed/,
    );
  });

  it('throws on HTTP non-2xx', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: vi.fn().mockResolvedValue('upstream broke'),
    });

    await expect(linearGraphql('k', 'query {}')).rejects.toThrow(/500/);
  });
});
