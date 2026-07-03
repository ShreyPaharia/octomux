import { LinearClient, LinearError } from '@linear/sdk';

/** Thrown for Linear API failures and app-local cases (e.g. issue not found). */
export class LinearApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'LinearApiError';
  }
}

export function createLinearClient(apiKey: string): LinearClient {
  return new LinearClient({ apiKey });
}

export function toLinearApiError(err: unknown): LinearApiError {
  if (err instanceof LinearApiError) return err;
  if (err instanceof LinearError) {
    const code = err.errors?.[0]?.type ?? err.type;
    const statusSuffix =
      err.status !== undefined && !err.message.includes(String(err.status))
        ? ` (HTTP ${err.status})`
        : '';
    return new LinearApiError(`${err.message}${statusSuffix}`, code);
  }
  if (err instanceof Error) return new LinearApiError(err.message);
  return new LinearApiError(String(err));
}

export async function invokeLinear<T>(
  apiKey: string,
  fn: (client: LinearClient) => Promise<T>,
): Promise<T> {
  try {
    return await fn(createLinearClient(apiKey));
  } catch (err) {
    throw toLinearApiError(err);
  }
}
