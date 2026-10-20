import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { AppError } from '../lib/errors';
import { hasPermission, type Permission } from '../security/permissions';

export const SESSION_COOKIE = 'ph_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface AuthContext {
  userId: string;
  organizationId: string;
  role: Role;
  email: string;
  name: string;
  employeeId: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function issueSessionToken(userId: string, tokenVersion: number): string {
  return jwt.sign({ sub: userId, tv: tokenVersion }, env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: SESSION_TTL_SECONDS,
  });
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: env.COOKIE_SECURE, sameSite: 'lax', path: '/' });
}

/** Verifies the session cookie, re-checks the user is still active, and attaches the auth context. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
    if (!token) throw AppError.unauthenticated();

    let payload: { sub: string; tv: number };
    try {
      payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as typeof payload;
    } catch {
      throw AppError.unauthenticated('Your session has expired. Please sign in again.');
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        organizationId: true,
        role: true,
        email: true,
        name: true,
        employeeId: true,
        isActive: true,
        tokenVersion: true,
      },
    });
    // tokenVersion changes on logout and password reset, which revokes earlier tokens.
    if (!user || !user.isActive || user.tokenVersion !== payload.tv) {
      throw AppError.unauthenticated('Your session is no longer valid. Please sign in again.');
    }

    req.auth = {
      userId: user.id,
      organizationId: user.organizationId,
      role: user.role,
      email: user.email,
      name: user.name,
      employeeId: user.employeeId,
    };
    next();
  } catch (err) {
    next(err);
  }
}

export function requirePermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const auth = req.auth;
    if (!auth) return next(AppError.unauthenticated());
    const allowed = permissions.every((p) => hasPermission(auth.role, p));
    if (!allowed) return next(AppError.forbidden());
    next();
  };
}

export function requireAuth(req: Request): AuthContext {
  if (!req.auth) throw AppError.unauthenticated();
  return req.auth;
}
