import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpIntegrationClient, HttpIntegrationError } from './http-client.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('HttpIntegrationClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends Basic auth header', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ id: '1' }),
      text: vi.fn().mockResolvedValue(''),
    });

    const client = HttpIntegrationClient.basicAuth(
      'https://acme.atlassian.net',
      'dev@acme.com',
      'token123',
    );
    await client.json('/rest/api/3/myself');

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const expected = Buffer.from('dev@acme.com:token123').toString('base64');
    expect((opts.headers as Record<string, string>).Authorization).toBe(`Basic ${expected}`);
    expect(mockFetch.mock.calls[0][0]).toBe('https://acme.atlassian.net/rest/api/3/myself');
  });

  it('json() throws HttpIntegrationError on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: vi.fn().mockResolvedValue('bad creds'),
    });

    const client = HttpIntegrationClient.basicAuth('https://x.io', 'a', 'b');
    await expect(client.json('/nope')).rejects.toBeInstanceOf(HttpIntegrationError);
  });

  it('request() returns body without throwing on failure', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: vi.fn().mockResolvedValue('invalid transition'),
    });

    const client = HttpIntegrationClient.basicAuth('https://x.io', 'a', 'b');
    const result = await client.request('/transitions', { method: 'POST' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.body).toBe('invalid transition');
  });

  it('wraps network errors as HttpIntegrationError', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const client = HttpIntegrationClient.basicAuth('https://x.io', 'a', 'b');
    await expect(client.fetch('/x')).rejects.toMatchObject({ message: 'ECONNREFUSED' });
  });
});
