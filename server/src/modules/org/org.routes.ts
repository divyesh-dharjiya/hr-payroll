import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { changedFields, writeAudit } from '../../lib/audit';
import { dateOnly, ymdOf } from '../../lib/time';
import { requireAuth, requirePermission } from '../../middleware/auth';
import { hasPermission } from '../../security/permissions';

export const orgRouter = Router();

const bps = (min: number, max: number) => z.number().int().min(min).max(max);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm (24-hour).');

const profileSchema = z.object({
  name: z.string().trim().min(2).max(120),
  legalName: z.string().trim().max(160).nullable().optional(),
  timezone: z.string().trim().min(3).max(64),
  weeklyOffDays: z.array(z.number().int().min(0).max(6)).max(7),
  financialYearStartMonth: z.number().int().min(1).max(12),
  shiftStart: hhmm,
  shiftEnd: hhmm,
  graceMinutes: z.number().int().min(0).max(120),
  standardBreakMinutes: z.number().int().min(0).max(240),
  breakDeductionAfterMinutes: z.number().int().min(0).max(720),
  pfEmployeeRateBps: bps(0, 2000),
  pfEmployerRateBps: bps(0, 2000),
  pfWageCeilingPaise: z.number().int().min(0),
  esiEmployeeRateBps: bps(0, 2000),
  esiEmployerRateBps: bps(0, 2000),
  esiGrossCeilingPaise: z.number().int().min(0),
  overtimeMultiplierBps: bps(0, 30000),
});

// Only Super Admin changes the company identity; HR may change attendance and payroll rules.
const SUPER_ONLY_FIELDS = ['name', 'legalName', 'timezone'] as const;

orgRouter.get('/profile', async (req, res) => {
  const auth = requireAuth(req);
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: auth.organizationId } });
  const { id, createdAt, updatedAt, logoUrl, ...rest } = org;
  void id; void createdAt; void updatedAt;
  res.json({ ...rest, logoUrl: logoUrl ?? null, canEditIdentity: auth.role === 'SUPER_ADMIN' });
});

orgRouter.patch('/profile', requirePermission('org:manage'), async (req, res) => {
  const auth = requireAuth(req);
  const input = profileSchema.partial().parse(req.body);
  if (auth.role !== 'SUPER_ADMIN' && SUPER_ONLY_FIELDS.some((f) => f in input)) {
    throw AppError.forbidden('Only a Super Admin can change the company name, legal name or timezone.');
  }
  const before = await prisma.organization.findUniqueOrThrow({ where: { id: auth.organizationId } });
  const after = await prisma.organization.update({ where: { id: auth.organizationId }, data: input });
  const changed = changedFields(
    Object.fromEntries(Object.keys(input).map((k) => [k, (before as Record<string, unknown>)[k]])),
    Object.fromEntries(Object.keys(input).map((k) => [k, (after as Record<string, unknown>)[k]])),
  );
  await writeAudit(auth, auth.organizationId, { action: 'org.profile_updated', entityType: 'Organization', entityId: auth.organizationId, summary: { changedFields: changed } }, req);
  res.json({ ok: true });
});

// -- Departments and designations ---------------------------------------------------------------------------------

orgRouter.get('/departments', async (req, res) => {
  const auth = requireAuth(req);
  const rows = await prisma.department.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { name: 'asc' },
    include: { _count: { select: { employees: { where: { status: { not: 'EXITED' } } } } } },
  });
  res.json({ items: rows.map((d) => ({ id: d.id, name: d.name, code: d.code, employeeCount: d._count.employees })) });
});

const deptSchema = z.object({ name: z.string().trim().min(2).max(60), code: z.string().trim().regex(/^[A-Za-z]{2,6}$/, '2-6 letters.') });

orgRouter.post('/departments', requirePermission('org:manage'), async (req, res) => {
  const auth = requireAuth(req);
  const input = deptSchema.parse(req.body);
  try {
    const d = await prisma.department.create({ data: { ...input, code: input.code.toUpperCase(), organizationId: auth.organizationId } });
    await writeAudit(auth, auth.organizationId, { action: 'department.created', entityType: 'Department', entityId: d.id, summary: { name: d.name } }, req);
    res.status(201).json({ id: d.id });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw AppError.conflict('A department with this name or code already exists.');
    }
    throw err;
  }
});

orgRouter.delete('/departments/:id', requirePermission('org:manage'), async (req, res) => {
  const auth = requireAuth(req);
  const id = req.params.id as string;
  const count = await prisma.employee.count({ where: { departmentId: id, organizationId: auth.organizationId } });
  if (count > 0) throw AppError.invalidState(`This department has ${count} employee record(s). Move them to another department first.`);
  await prisma.department.deleteMany({ where: { id, organizationId: auth.organizationId } });
  await writeAudit(auth, auth.organizationId, { action: 'department.deleted', entityType: 'Department', entityId: id }, req);
  res.status(204).end();
});

orgRouter.get('/designations', async (req, res) => {
  const auth = requireAuth(req);
  const rows = await prisma.designation.findMany({ where: { organizationId: auth.organizationId }, orderBy: { title: 'asc' } });
  res.json({ items: rows.map((d) => ({ id: d.id, title: d.title })) });
});

orgRouter.post('/designations', requirePermission('org:manage'), async (req, res) => {
  const auth = requireAuth(req);
  const input = z.object({ title: z.string().trim().min(2).max(80) }).parse(req.body);
  try {
    const d = await prisma.designation.create({ data: { title: input.title, organizationId: auth.organizationId } });
    await writeAudit(auth, auth.organizationId, { action: 'designation.created', entityType: 'Designation', entityId: d.id, summary: { title: d.title } }, req);
    res.status(201).json({ id: d.id });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw AppError.conflict('This designation already exists.');
    throw err;
  }
});

orgRouter.delete('/designations/:id', requirePermission('org:manage'), async (req, res) => {
  const auth = requireAuth(req);
  const id = req.params.id as string;
  const count = await prisma.employee.count({ where: { designationId: id, organizationId: auth.organizationId } });
  if (count > 0) throw AppError.invalidState(`${count} employee(s) hold this designation. Reassign them first.`);
  await prisma.designation.deleteMany({ where: { id, organizationId: auth.organizationId } });
  await writeAudit(auth, auth.organizationId, { action: 'designation.deleted', entityType: 'Designation', entityId: id }, req);
  res.status(204).end();
});

// -- Holidays -----------------------------------------------------------------------------------------------------

orgRouter.get('/holidays', async (req, res) => {
  const auth = requireAuth(req);
  const year = z.coerce.number().int().min(2000).max(2100).default(new Date().getUTCFullYear()).parse(req.query.year ?? undefined);
  const rows = await prisma.holiday.findMany({
    where: { organizationId: auth.organizationId, holidayDate: { gte: dateOnly(`${year}-01-01`), lte: dateOnly(`${year}-12-31`) } },
    orderBy: { holidayDate: 'asc' },
  });
  res.json({ year, items: rows.map((h) => ({ id: h.id, date: ymdOf(h.holidayDate), name: h.name })) });
});

orgRouter.post('/holidays', requirePermission('org:manage'), async (req, res) => {
  const auth = requireAuth(req);
  const input = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: z.string().trim().min(2).max(100) }).parse(req.body);
  try {
    const h = await prisma.holiday.create({ data: { organizationId: auth.organizationId, holidayDate: dateOnly(input.date), name: input.name } });
    await writeAudit(auth, auth.organizationId, { action: 'holiday.created', entityType: 'Holiday', entityId: h.id, summary: { date: input.date } }, req);
    res.status(201).json({ id: h.id });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw AppError.conflict('A holiday already exists on this date.', [{ field: 'date', message: 'Choose another date.' }]);
    }
    throw err;
  }
});

orgRouter.delete('/holidays/:id', requirePermission('org:manage'), async (req, res) => {
  const auth = requireAuth(req);
  const id = req.params.id as string;
  await prisma.holiday.deleteMany({ where: { id, organizationId: auth.organizationId } });
  await writeAudit(auth, auth.organizationId, { action: 'holiday.deleted', entityType: 'Holiday', entityId: id }, req);
  res.status(204).end();
});

// -- Announcements ------------------------------------------------------------------------------------------------

const announcementSchema = z
  .object({
    title: z.string().trim().min(3).max(120),
    body: z.string().trim().min(3).max(2000),
    publishAt: z.string().datetime({ offset: true }).optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
    audienceRole: z.enum(['HR_ADMIN', 'MANAGER', 'EMPLOYEE']).nullable().optional(),
    departmentId: z.string().nullable().optional(),
  })
  .refine((v) => !v.expiresAt || !v.publishAt || new Date(v.expiresAt) > new Date(v.publishAt), {
    message: 'Expiry must be after the publish date.',
    path: ['expiresAt'],
  });

orgRouter.get('/announcements', async (req, res) => {
  const auth = requireAuth(req);
  const now = new Date();
  const manageAll = hasPermission(auth.role, 'org:manage') && req.query.all === 'true';
  let departmentId: string | null = null;
  if (auth.employeeId) {
    const me = await prisma.employee.findUnique({ where: { id: auth.employeeId }, select: { departmentId: true } });
    departmentId = me?.departmentId ?? null;
  }
  const audience: Prisma.AnnouncementWhereInput[] = [
    { audienceRole: null },
    { audienceRole: auth.role },
  ];
  const rows = await prisma.announcement.findMany({
    where: manageAll
      ? { organizationId: auth.organizationId }
      : {
          organizationId: auth.organizationId,
          publishAt: { lte: now },
          AND: [
            { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
            { OR: audience },
            { OR: [{ departmentId: null }, ...(departmentId ? [{ departmentId }] : [])] },
          ],
        },
    orderBy: { publishAt: 'desc' },
    take: 50,
  });
  res.json({ items: rows.map((a) => ({ ...a, publishAt: a.publishAt.toISOString(), expiresAt: a.expiresAt?.toISOString() ?? null, createdAt: a.createdAt.toISOString() })) });
});

orgRouter.post('/announcements', requirePermission('org:manage'), async (req, res) => {
  const auth = requireAuth(req);
  const input = announcementSchema.parse(req.body);
  const row = await prisma.announcement.create({
    data: {
      organizationId: auth.organizationId,
      title: input.title,
      body: input.body,
      publishAt: input.publishAt ? new Date(input.publishAt) : new Date(),
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      audienceRole: input.audienceRole ?? null,
      departmentId: input.departmentId ?? null,
      createdById: auth.userId,
    },
  });
  await writeAudit(auth, auth.organizationId, { action: 'announcement.created', entityType: 'Announcement', entityId: row.id, summary: { title: row.title } }, req);
  res.status(201).json({ id: row.id });
});

orgRouter.put('/announcements/:id', requirePermission('org:manage'), async (req, res) => {
  const auth = requireAuth(req);
  const id = req.params.id as string;
  const input = announcementSchema.parse(req.body);
  const existing = await prisma.announcement.findFirst({ where: { id, organizationId: auth.organizationId } });
  if (!existing) throw AppError.notFound('Announcement not found.');
  const row = await prisma.announcement.update({
    where: { id },
    data: {
      title: input.title,
      body: input.body,
      publishAt: input.publishAt ? new Date(input.publishAt) : existing.publishAt,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      audienceRole: input.audienceRole ?? null,
      departmentId: input.departmentId ?? null,
    },
  });
  await writeAudit(auth, auth.organizationId, { action: 'announcement.updated', entityType: 'Announcement', entityId: row.id, summary: { title: row.title } }, req);
  res.json({ id: row.id });
});

orgRouter.delete('/announcements/:id', requirePermission('org:manage'), async (req, res) => {
  const auth = requireAuth(req);
  const id = req.params.id as string;
  await prisma.announcement.deleteMany({ where: { id, organizationId: auth.organizationId } });
  await writeAudit(auth, auth.organizationId, { action: 'announcement.deleted', entityType: 'Announcement', entityId: id }, req);
  res.status(204).end();
});

// -- Audit trail --------------------------------------------------------------------------------------------------

orgRouter.get('/audit-logs', requirePermission('audit:read'), async (req, res) => {
  const auth = requireAuth(req);
  const q = z
    .object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25), entityType: z.string().max(40).optional(), action: z.string().max(80).optional() })
    .parse(req.query);
  const where: Prisma.AuditLogWhereInput = {
    organizationId: auth.organizationId,
    ...(q.entityType ? { entityType: q.entityType } : {}),
    ...(q.action ? { action: { contains: q.action, mode: 'insensitive' } } : {}),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
  ]);
  res.json({
    page: q.page,
    pageSize: q.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
    items: rows.map((r) => ({
      id: r.id,
      actor: r.actorEmail,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      summary: r.summary,
      ipAddress: r.ipAddress,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});
