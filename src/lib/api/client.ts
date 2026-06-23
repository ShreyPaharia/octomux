/**
 * src/lib/api/client.ts
 *
 * The single shared request core for every API namespace. Holds the BASE prefix,
 * in-flight GET deduplication, and the low-level `request()` / `doRequest()`
 * helpers. Each per-domain namespace (`taskApi`, `reviewApi`, `configApi`)
 * imports `request` from here — there is exactly one copy of this logic.
 */

export const BASE = '/api';

// In-flight GET request deduplication: if the same GET is already pending,
// reuse its promise instead of firing a duplicate network request.
const inflight = new Map<string, Promise<unknown>>();

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const method = options?.method || 'GET';

  // Only deduplicate GET requests — mutations must always execute
  if (method === 'GET') {
    const key = `GET:${path}`;
    const existing = inflight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = doRequest<T>(path, options).finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
  }

  return doRequest<T>(path, options);
}

async function doRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};
  if (options?.body) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${BASE}${path}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}
