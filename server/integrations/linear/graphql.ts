import { childLogger } from '../../logger.js';

const logger = childLogger('integrations:linear:graphql');

export class LinearApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'LinearApiError';
  }
}

export async function linearGraphql<T = unknown>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, ...(variables ? { variables } : {}) }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logger.warn({ status: res.status, body: text }, 'linear graphql non-2xx');
    throw new LinearApiError(`Linear API HTTP ${res.status} ${res.statusText ?? ''}: ${text}`);
  }

  const body = (await res.json()) as {
    data?: T;
    errors?: Array<{ message: string; extensions?: { code?: string } }>;
  };
  if (body.errors && body.errors.length > 0) {
    const first = body.errors[0];
    throw new LinearApiError(first.message, first.extensions?.code);
  }
  if (body.data === undefined) {
    throw new LinearApiError('Linear API returned no data and no errors');
  }
  return body.data;
}
