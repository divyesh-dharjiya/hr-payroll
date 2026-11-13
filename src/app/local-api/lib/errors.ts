import { ZodError } from 'zod';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

// Domain errors carry a stable machine-readable code so the UI can react consistently.
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, 'VALIDATION_ERROR', message, details);
  }
  static unauthenticated(message = 'Please sign in to continue.') {
    return new AppError(401, 'UNAUTHENTICATED', message);
  }
  static forbidden(message = 'You do not have permission to perform this action.') {
    return new AppError(403, 'FORBIDDEN', message);
  }
  static notFound(message = 'The requested record was not found.') {
    return new AppError(404, 'NOT_FOUND', message);
  }
  static conflict(message: string, details?: unknown) {
    return new AppError(409, 'CONFLICT', message, details);
  }
  static invalidState(message: string, details?: unknown) {
    return new AppError(422, 'INVALID_STATE', message, details);
  }
}

/**
 * Marks an error so the changes the request made before failing are kept: a failed sign-in still counts the
 * attempt, and a payroll validation that finds problems still refreshes the draft (see Database.transaction).
 */
export function withChangesKept<E extends Error>(err: E): E {
  return Object.assign(err, { keepChanges: true });
}

/** Raised by the database when an insert or update would duplicate a unique key (like a unique index). */
export class UniqueConstraintError extends Error {
  constructor(
    readonly table: string,
    readonly fields: string[],
  ) {
    super(`Unique constraint failed on ${table} (${fields.join(', ')})`);
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export function errorBody(code: ErrorCode, message: string, details?: unknown): ErrorBody {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

/** The only place that turns exceptions into API error responses: `{ error: { code, message, details? } }`. */
export function toErrorResponse(err: unknown): { status: number; body: ErrorBody } {
  if (err instanceof AppError) {
    return { status: err.status, body: errorBody(err.code, err.message, err.details) };
  }
  if (err instanceof ZodError) {
    const fields = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    return { status: 400, body: errorBody('VALIDATION_ERROR', 'Please correct the highlighted fields.', fields) };
  }
  if (err instanceof UniqueConstraintError) {
    return { status: 409, body: errorBody('CONFLICT', 'A record with the same unique value already exists.', { target: err.fields }) };
  }
  console.error('[local-api]', err);
  return { status: 500, body: errorBody('INTERNAL_ERROR', 'Something went wrong. Please try again.') };
}
