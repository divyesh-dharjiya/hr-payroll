import { z } from 'zod';
import { db } from '../../db';
import type { User } from '../../db/schema';
import { AppError, withChangesKept } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { hashPassword, randomToken, sha256, verifyPassword } from '../../lib/crypto';
import { appLink, sendMail } from '../../lib/mailer';
import { Router, accepted, noContent, requireAuth } from '../../http/router';
import { permissionsFor } from '../../security/permissions';
import { authContextFor, authenticate, issueSessionToken } from '../../security/session';
import { DEMO_DOMAIN, DEMO_PASSWORD, seedDemoData } from '../../db/seed';

/** Routes that work without a session (sign-in, password reset, demo helpers). */
export const publicAuthRouter = new Router('/auth');
/** Routes that need a session. */
export const authRouter = new Router('/auth');

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const RESET_TTL_MINUTES = 30;
// Used to keep response timing similar when the account does not exist.
let dummyHash: string | null = null;

export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(128, 'Use at most 128 characters.')
  .regex(/[A-Za-z]/, 'Include at least one letter.')
  .regex(/[0-9]/, 'Include at least one number.');

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.').max(128),
});

const forgotSchema = z.object({ email: z.string().trim().toLowerCase().email('Enter a valid email address.') });
const resetSchema = z.object({ token: z.string().min(20), password: passwordSchema });

function publicUser(user: User) {
  const employee = db.employees.get(user.employeeId);
  const organization = db.organizations.get(user.organizationId);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    employeeId: user.employeeId,
    organizationId: user.organizationId,
    organizationName: organization?.name ?? '',
    organizationTimezone: organization?.timezone ?? 'Asia/Kolkata',
    photoUrl: employee?.photoUrl ?? null,
    title: employee ? (db.designations.get(employee.designationId)?.title ?? null) : null,
    permissions: permissionsFor(user.role),
  };
}

publicAuthRouter.post('/login', (req) => {
  const input = loginSchema.parse(req.body);
  const user = db.users.find((u) => u.email === input.email);

  if (!user || !user.isActive) {
    verifyPassword(input.password, (dummyHash ??= hashPassword('not-a-real-password')));
    throw AppError.unauthenticated('Invalid email or password.');
  }
  if (user.lockedUntil && user.lockedUntil > new Date().toISOString()) {
    throw new AppError(429, 'RATE_LIMITED', 'This account is temporarily locked after repeated failed sign-ins. Try again later.');
  }

  if (!verifyPassword(input.password, user.passwordHash)) {
    const failed = user.failedLoginCount + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    db.users.update(user.id, {
      failedLoginCount: lock ? 0 : failed,
      lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() : null,
    });
    writeAudit(null, user.organizationId, { action: 'auth.login_failed', entityType: 'User', entityId: user.id, summary: { reason: 'invalid_password', locked: lock } });
    throw withChangesKept(AppError.unauthenticated('Invalid email or password.'));
  }

  const updated = db.users.update(user.id, { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date().toISOString() });
  req.setSession(issueSessionToken(updated));
  writeAudit(authContextFor(updated), updated.organizationId, { action: 'auth.login', entityType: 'User', entityId: updated.id });
  return { user: publicUser(updated) };
});

// Demo accounts for one-click sign-in on the sign-in page. The demo company and its password are fictional and
// live only in this browser, so the password is part of the app (see db/seed.ts).
const ROLE_ORDER = ['SUPER_ADMIN', 'HR_ADMIN', 'MANAGER', 'EMPLOYEE'];

publicAuthRouter.get('/demo-accounts', () => {
  const accounts = db.users
    .filter((u) => u.email.endsWith(`@${DEMO_DOMAIN}`) && u.isActive)
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role))
    .map((u) => {
      const employee = db.employees.get(u.employeeId);
      return {
        email: u.email,
        name: u.name,
        role: u.role,
        title: employee
          ? `${db.designations.get(employee.designationId)?.title ?? ''} · ${db.departments.get(employee.departmentId)?.name ?? ''}`
          : 'Full system access',
      };
    });
  return { password: DEMO_PASSWORD, accounts };
});

/** Replaces everything stored in this browser with a fresh demo company, dated relative to today. */
publicAuthRouter.post('/demo-reset', (req) => {
  db.clear();
  seedDemoData();
  req.setSession(null);
  return noContent();
});

// Session probe for app start: answers with `user: null` when signed out, so a visitor's first page load does not
// produce a failed request. Endpoints that need a session keep answering 401.
publicAuthRouter.get('/session', (req) => {
  try {
    const auth = authenticate(req.session);
    return { user: publicUser(db.users.get(auth.userId)!) };
  } catch (err) {
    if (err instanceof AppError && err.status === 401) return { user: null };
    throw err;
  }
});

publicAuthRouter.post('/forgot-password', (req) => {
  const { email } = forgotSchema.parse(req.body);
  const user = db.users.find((u) => u.email === email);
  if (user && user.isActive) {
    const { token, hash } = randomToken();
    db.users.update(user.id, {
      passwordResetTokenHash: hash,
      passwordResetExpiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000).toISOString(),
    });
    sendMail({
      to: user.email,
      subject: 'Reset your PeopleHub password',
      text: `Use this link within ${RESET_TTL_MINUTES} minutes to set a new password:\n${appLink(`/reset-password?token=${token}`)}\n\nIf you did not ask for this, ignore this email.`,
    });
    writeAudit(null, user.organizationId, { action: 'auth.password_reset_requested', entityType: 'User', entityId: user.id });
  }
  // Same response whether or not the account exists, to avoid account enumeration.
  return accepted({ message: 'If an account exists for that email, a reset link has been sent.' });
});

publicAuthRouter.post('/reset-password', (req) => {
  const { token, password } = resetSchema.parse(req.body);
  const hash = sha256(token);
  const now = new Date().toISOString();
  const user = db.users.find((u) => u.passwordResetTokenHash === hash && u.passwordResetExpiresAt !== null && u.passwordResetExpiresAt > now);
  if (!user) {
    throw AppError.invalidState('This reset link is invalid or has expired. Request a new one.');
  }
  db.users.update(user.id, {
    passwordHash: hashPassword(password),
    passwordResetTokenHash: null,
    passwordResetExpiresAt: null,
    failedLoginCount: 0,
    lockedUntil: null,
    tokenVersion: user.tokenVersion + 1,
  });
  writeAudit(null, user.organizationId, { action: 'auth.password_reset', entityType: 'User', entityId: user.id });
  return noContent();
});

authRouter.post('/logout', (req) => {
  const auth = requireAuth(req);
  // Changing tokenVersion revokes every outstanding session for this user, not just this tab.
  const user = db.users.get(auth.userId)!;
  db.users.update(user.id, { tokenVersion: user.tokenVersion + 1 });
  req.setSession(null);
  return noContent();
});

authRouter.get('/me', (req) => ({ user: publicUser(db.users.get(requireAuth(req).userId)!) }));
