import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { AppError, errorBody } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { randomToken, sha256 } from '../../lib/crypto';
import { sendMail } from '../../lib/mailer';
import { demoModeEnabled, env, isProduction } from '../../config/env';
import {
  authenticate,
  clearSessionCookie,
  issueSessionToken,
  requireAuth,
  setSessionCookie,
} from '../../middleware/auth';
import { permissionsFor } from '../../security/permissions';

export const authRouter = Router();

// Rate limiting for credential endpoints: per IP, on top of per-account lockout in the login flow.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isProduction ? 20 : 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) =>
    res.status(429).json(errorBody('RATE_LIMITED', 'Too many attempts. Please wait a few minutes and try again.')),
});

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const RESET_TTL_MINUTES = 30;
// Used to keep response timing similar when the account does not exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

const passwordSchema = z
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

async function publicUser(user: {
  id: string;
  email: string;
  name: string;
  role: string;
  employeeId: string | null;
  organizationId: string;
}) {
  const [employee, organization] = await Promise.all([
    user.employeeId
      ? prisma.employee.findUnique({ where: { id: user.employeeId }, select: { photoUrl: true, designation: { select: { title: true } } } })
      : null,
    prisma.organization.findUnique({ where: { id: user.organizationId }, select: { name: true, timezone: true } }),
  ]);
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
    title: employee?.designation.title ?? null,
    permissions: permissionsFor(user.role as never),
  };
}

authRouter.post('/login', authLimiter, async (req, res) => {
  const input = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  if (!user || !user.isActive) {
    await bcrypt.compare(input.password, DUMMY_HASH);
    throw AppError.unauthenticated('Invalid email or password.');
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(429, 'RATE_LIMITED', 'This account is temporarily locked after repeated failed sign-ins. Try again later.');
  }

  const ok = await bcrypt.compare(input.password, user.passwordHash);
  if (!ok) {
    const failed = user.failedLoginCount + 1;
    const lock = failed >= MAX_FAILED_LOGINS;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: lock ? 0 : failed,
        lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
      },
    });
    await writeAudit(null, user.organizationId, {
      action: 'auth.login_failed',
      entityType: 'User',
      entityId: user.id,
      summary: { reason: 'invalid_password', locked: lock },
    }, req);
    throw AppError.unauthenticated('Invalid email or password.');
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  setSessionCookie(res, issueSessionToken(updated.id, updated.tokenVersion));
  await writeAudit(
    { userId: updated.id, organizationId: updated.organizationId, role: updated.role, email: updated.email, name: updated.name, employeeId: updated.employeeId },
    updated.organizationId,
    { action: 'auth.login', entityType: 'User', entityId: updated.id },
    req,
  );
  res.json({ user: await publicUser(updated) });
});

// Demo mode only (DEMO_MODE=true, never in production): lists the seeded demo accounts so the sign-in page can fill
// them in with one click. Returns 404 otherwise, so the endpoint does not exist for real deployments.
const DEMO_DOMAIN = '@lotus-demo.example';
const ROLE_ORDER = ['SUPER_ADMIN', 'HR_ADMIN', 'MANAGER', 'EMPLOYEE'];

authRouter.get('/demo-accounts', async (_req, res) => {
  if (!demoModeEnabled) throw AppError.notFound('Endpoint not found.');
  const users = await prisma.user.findMany({
    where: { email: { endsWith: DEMO_DOMAIN }, isActive: true },
    select: {
      email: true,
      name: true,
      role: true,
      employee: { select: { designation: { select: { title: true } }, department: { select: { name: true } } } },
    },
  });
  const accounts = users
    .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role))
    .map((u) => ({
      email: u.email,
      name: u.name,
      role: u.role,
      title: u.employee ? `${u.employee.designation.title} · ${u.employee.department.name}` : 'Full system access',
    }));
  res.json({ password: env.SEED_DEMO_PASSWORD, accounts });
});

authRouter.post('/logout', authenticate, async (req, res) => {
  const auth = requireAuth(req);
  // Bumping tokenVersion revokes every outstanding token for this user, not just this browser.
  await prisma.user.update({ where: { id: auth.userId }, data: { tokenVersion: { increment: 1 } } });
  clearSessionCookie(res);
  res.status(204).end();
});

authRouter.get('/me', authenticate, async (req, res) => {
  const auth = requireAuth(req);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
  res.json({ user: await publicUser(user) });
});

// Session probe for app start: answers 200 with `user: null` when signed out, so a visitor's first page load does not
// produce a failed request. Endpoints that need a session keep answering 401.
authRouter.get('/session', (req, res, next) => {
  authenticate(req, res, async (err?: unknown) => {
    try {
      if (err) {
        if (err instanceof AppError && err.status === 401) return res.json({ user: null });
        return next(err);
      }
      const user = await prisma.user.findUniqueOrThrow({ where: { id: requireAuth(req).userId } });
      res.json({ user: await publicUser(user) });
    } catch (e) {
      next(e);
    }
  });
});

authRouter.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = forgotSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  if (user && user.isActive) {
    const { token, hash } = randomToken();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetTokenHash: hash,
        passwordResetExpiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60_000),
      },
    });
    const link = `${env.CLIENT_ORIGIN}/reset-password?token=${token}`;
    await sendMail({
      to: user.email,
      subject: 'Reset your PeopleHub password',
      text: `Use this link within ${RESET_TTL_MINUTES} minutes to set a new password:\n${link}\n\nIf you did not ask for this, ignore this email.`,
    });
    await writeAudit(null, user.organizationId, { action: 'auth.password_reset_requested', entityType: 'User', entityId: user.id }, req);
  }
  // Same response whether or not the account exists, to avoid account enumeration.
  res.status(202).json({ message: 'If an account exists for that email, a reset link has been sent.' });
});

authRouter.post('/reset-password', authLimiter, async (req, res) => {
  const { token, password } = resetSchema.parse(req.body);
  const user = await prisma.user.findFirst({
    where: { passwordResetTokenHash: sha256(token), passwordResetExpiresAt: { gt: new Date() } },
  });
  if (!user) {
    throw AppError.invalidState('This reset link is invalid or has expired. Request a new one.');
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
      failedLoginCount: 0,
      lockedUntil: null,
      tokenVersion: { increment: 1 },
    },
  });
  await writeAudit(null, user.organizationId, { action: 'auth.password_reset', entityType: 'User', entityId: user.id }, req);
  res.status(204).end();
});

/** Hash helper used by seeding and account creation. */
export async function hashPassword(plain: string) {
  return bcrypt.hash(plain, 12);
}

export { passwordSchema };
