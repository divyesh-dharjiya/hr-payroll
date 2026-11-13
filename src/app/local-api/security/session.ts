import { db } from '../db';
import type { Role, User } from '../db/schema';
import { AppError } from '../lib/errors';

// ---------------------------------------------------------------------------------------------------------------
// Sessions. Signing in issues a token naming the user, their token version and an expiry (8 hours). The user is
// re-read on every request, and `tokenVersion` changes on sign-out and password reset, which revokes older tokens
// in every tab. The browser keeps the token in localStorage (see runtime.ts); tests pass it per request.
// ---------------------------------------------------------------------------------------------------------------

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface AuthContext {
  userId: string;
  organizationId: string;
  role: Role;
  email: string;
  name: string;
  employeeId: string | null;
}

interface TokenPayload {
  sub: string;
  tv: number;
  exp: number;
}

export function issueSessionToken(user: Pick<User, 'id' | 'tokenVersion'>): string {
  const payload: TokenPayload = { sub: user.id, tv: user.tokenVersion, exp: Date.now() + SESSION_TTL_MS };
  return btoa(JSON.stringify(payload));
}

function parseToken(token: string): TokenPayload | null {
  try {
    const payload = JSON.parse(atob(token)) as TokenPayload;
    return typeof payload.sub === 'string' && typeof payload.tv === 'number' && typeof payload.exp === 'number' ? payload : null;
  } catch {
    return null;
  }
}

export function authContextFor(user: User): AuthContext {
  return {
    userId: user.id,
    organizationId: user.organizationId,
    role: user.role,
    email: user.email,
    name: user.name,
    employeeId: user.employeeId,
  };
}

/** Verifies a session token and re-checks that the user is still active. Throws 401 when it is not valid. */
export function authenticate(token: string | null): AuthContext {
  if (!token) throw AppError.unauthenticated();
  const payload = parseToken(token);
  if (!payload || payload.exp < Date.now()) throw AppError.unauthenticated('Your session has expired. Please sign in again.');
  const user = db.users.get(payload.sub);
  if (!user || !user.isActive || user.tokenVersion !== payload.tv) {
    throw AppError.unauthenticated('Your session is no longer valid. Please sign in again.');
  }
  return authContextFor(user);
}
