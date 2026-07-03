/**
 * @octomux/api-client — isomorphic HTTP request core for CLI and web consumers.
 */

export interface RequestCoreOptions {
  /** Prefix prepended to every path, e.g. `/api` or `http://localhost:7777/api`. */
  baseUrl: string;
  /** Set Content-Type on every request (CLI). Default: only when body is present (web). */
  alwaysJsonContentType?: boolean;
  /** Customize or rethrow fetch network errors (e.g. CLI ECONNREFUSED messaging). */
  onFetchError?: (err: unknown, ctx: { baseUrl: string }) => never;
}

export interface RequestCore {
  request: <T>(path: string, options?: RequestInit) => Promise<T>;
  baseUrl: string;
}

/** Build a query string from optional key/value pairs (undefined values are omitted). */
export function qs(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][];
  if (entries.length === 0) return '';
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

/** Create an HTTP request core with in-flight GET deduplication. */
export function createRequestCore(options: RequestCoreOptions): RequestCore {
  const { baseUrl, alwaysJsonContentType = false, onFetchError } = options;
  const inflight = new Map<string, Promise<unknown>>();

  async function doRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {};
    if (alwaysJsonContentType || init?.body) {
      headers['Content-Type'] = 'application/json';
    }
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        headers,
        ...init,
      });
    } catch (err) {
      if (onFetchError) {
        onFetchError(err, { baseUrl });
      }
      throw err;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(body.error || res.statusText);
    }
    if (res.status === 204) return undefined as T;
    return res.json();
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const method = init?.method || 'GET';

    if (method === 'GET') {
      const key = `GET:${path}`;
      const existing = inflight.get(key);
      if (existing) return existing as Promise<T>;

      const promise = doRequest<T>(path, init).finally(() => {
        inflight.delete(key);
      });
      inflight.set(key, promise);
      return promise;
    }

    return doRequest<T>(path, init);
  }

  return { request, baseUrl };
}
