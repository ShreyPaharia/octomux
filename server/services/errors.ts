/**
 * Shared typed errors for the service layer and route handlers.
 *
 * ServiceError carries an HTTP status code so the error middleware can map it to
 * the correct HTTP response without route handlers knowing response wiring.
 */

export class ServiceError extends Error {
  /** When set, sent as the JSON body verbatim (preserves non-standard shapes). */
  readonly body?: Record<string, unknown>;

  constructor(
    message: string,
    public readonly status: number,
    body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ServiceError';
    this.body = body;
  }
}

export function badRequest(message: string): ServiceError {
  return new ServiceError(message, 400);
}

export function notFound(message: string): ServiceError {
  return new ServiceError(message, 404);
}

export function conflict(message: string): ServiceError {
  return new ServiceError(message, 409);
}

/**
 * Map a thrown domain/errno error to ServiceError (replaces sendDomainError).
 * Used in catch blocks where filesystem / domain errors are expected.
 */
export function toDomainServiceError(err: unknown): ServiceError {
  const e = err as NodeJS.ErrnoException;
  const msg = e.message || 'Unknown error';
  if (e.code === 'ENOENT' || msg.includes('not found') || msg.includes('does not exist')) {
    return new ServiceError(msg, 404);
  }
  if (msg.includes('already exists')) {
    return new ServiceError(msg, 409);
  }
  if (msg.startsWith('Invalid') || msg.includes('required')) {
    return new ServiceError(msg, 400);
  }
  return new ServiceError(msg, 500);
}
