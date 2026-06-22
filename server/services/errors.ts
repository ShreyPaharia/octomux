/**
 * Shared typed errors for the service layer.
 *
 * ServiceError carries an HTTP status code so route handlers can map it to the
 * correct HTTP response without knowing business logic.
 */

export class ServiceError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}
