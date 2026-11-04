import type { ErrorCode } from './http';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly retryable = false,
    readonly fields?: Record<string, string>,
    readonly operationId?: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
