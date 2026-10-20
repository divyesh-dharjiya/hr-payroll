import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { isProduction } from '../config/env';

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INVALID_STATE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

// Domain errors carry a stable machine-readable code so the frontend can react consistently.
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
  static invalidState(message: string) {
    return new AppError(422, 'INVALID_STATE', message);
  }
}

export function errorBody(code: ErrorCode, message: string, details?: unknown) {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

// Central error handler: the only place that turns exceptions into HTTP responses.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json(errorBody(err.code, err.message, err.details));
  }
  if (err instanceof ZodError) {
    const fields = err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    return res.status(400).json(errorBody('VALIDATION_ERROR', 'Please correct the highlighted fields.', fields));
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return res
      .status(409)
      .json(errorBody('CONFLICT', 'A record with the same unique value already exists.', err.meta));
  }
  if (typeof err === 'object' && err !== null && 'type' in err && (err as { type?: string }).type === 'entity.parse.failed') {
    return res.status(400).json(errorBody('VALIDATION_ERROR', 'The request body is not valid JSON.'));
  }
  // Never leak internals to clients in production.
  console.error(`[${req.method} ${req.originalUrl}]`, err);
  return res
    .status(500)
    .json(errorBody('INTERNAL_ERROR', isProduction ? 'Something went wrong. Please try again.' : String(err)));
}
