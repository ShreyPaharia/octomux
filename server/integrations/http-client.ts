/** Shared fetch wrapper for REST-based integration providers (Jira, future Slack/GitHub). */

export class HttpIntegrationError extends Error {
  readonly status?: number;
  readonly body?: string;

  constructor(message: string, opts?: { status?: number; body?: string }) {
    super(message);
    this.name = 'HttpIntegrationError';
    this.status = opts?.status;
    this.body = opts?.body;
  }

  static fromNetwork(err: unknown): HttpIntegrationError {
    const message = err instanceof Error ? err.message : String(err);
    return new HttpIntegrationError(message);
  }

  static async fromResponse(res: Response): Promise<HttpIntegrationError> {
    const body = await res.text().catch(() => '');
    const message = body
      ? `${res.status}: ${res.statusText} — ${body}`
      : `${res.status}: ${res.statusText}`;
    return new HttpIntegrationError(message, { status: res.status, body });
  }
}

export type HttpIntegrationAuth =
  | { type: 'basic'; username: string; password: string }
  | { type: 'bearer'; token: string }
  | { type: 'headers'; headers: Record<string, string> };

export interface HttpIntegrationClientOptions {
  baseUrl: string;
  auth: HttpIntegrationAuth;
  defaultHeaders?: Record<string, string>;
  fetchFn?: typeof fetch;
}

export interface HttpIntegrationResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
}

function buildAuthHeaders(auth: HttpIntegrationAuth): Record<string, string> {
  switch (auth.type) {
    case 'basic': {
      const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
      return { Authorization: `Basic ${credentials}` };
    }
    case 'bearer':
      return { Authorization: `Bearer ${auth.token}` };
    case 'headers':
      return auth.headers;
  }
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/$/, '');
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export class HttpIntegrationClient {
  private readonly baseUrl: string;
  private readonly authHeaders: Record<string, string>;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchFn: typeof fetch;

  constructor(options: HttpIntegrationClientOptions) {
    this.baseUrl = options.baseUrl;
    this.authHeaders = buildAuthHeaders(options.auth);
    this.defaultHeaders = options.defaultHeaders ?? { Accept: 'application/json' };
    this.fetchFn = options.fetchFn ?? fetch;
  }

  static basicAuth(
    baseUrl: string,
    username: string,
    password: string,
    fetchFn?: typeof fetch,
  ): HttpIntegrationClient {
    return new HttpIntegrationClient({
      baseUrl,
      auth: { type: 'basic', username, password },
      fetchFn,
    });
  }

  async fetch(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(joinUrl(this.baseUrl, path), {
        ...init,
        headers: {
          ...this.defaultHeaders,
          ...this.authHeaders,
          ...(init?.headers as Record<string, string> | undefined),
        },
      });
    } catch (err) {
      throw HttpIntegrationError.fromNetwork(err);
    }
  }

  async request(path: string, init?: RequestInit): Promise<HttpIntegrationResponse> {
    const res = await this.fetch(path, init);
    const body = await res.text().catch(() => '');
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      body,
    };
  }

  async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetch(path, init);
    if (!res.ok) {
      throw await HttpIntegrationError.fromResponse(res);
    }
    return (await res.json()) as T;
  }
}
