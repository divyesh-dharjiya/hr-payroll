import { z } from 'zod';
import { db } from '../../db';
import type { Announcement, Organization } from '../../db/schema';
import { AppError, UniqueConstraintError } from '../../lib/errors';
import { changedFields, writeAudit } from '../../lib/audit';
import { Router, created, noContent, requireAuth, requirePermission } from '../../http/router';
import { hasPermission } from '../../security/permissions';
import type { AuthContext } from '../../security/session';
import { organizationOf } from '../employees/employees.service';

export const orgRouter = new Router('/org');

const bps = (min: number, max: number) => z.number().int().min(min).max(max);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm (24-hour).');

const profileSchema = z.object({
  name: z.string().trim().min(2).max(120),
  legalName: z.string().trim().max(160).nullable().optional(),
  // Every date calculation depends on this value, so only real IANA zones (for example Asia/Kolkata) are accepted.
  timezone: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'Enter a valid timezone, for example Asia/Kolkata.'),
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

const inOrg = (auth: AuthContext) => (row: { organizationId: string }) => row.organizationId === auth.organizationId;
const isoOf = (value: string) => new Date(value).toISOString();

orgRouter.get('/profile', (req) => {
  const auth = requireAuth(req);
  const { id, createdAt, updatedAt, ...rest } = organizationOf(auth);
  void id;
  void createdAt;
  void updatedAt;
  return { ...rest, canEditIdentity: auth.role === 'SUPER_ADMIN' };
});

orgRouter.patch('/profile', requirePermission('org:manage'), (req) => {
  const auth = requireAuth(req);
  const input = profileSchema.partial().parse(req.body);
  if (auth.role !== 'SUPER_ADMIN' && SUPER_ONLY_FIELDS.some((f) => f in input)) {
    throw AppError.forbidden('Only a Super Admin can change the company name, legal name or timezone.');
  }
  const before = organizationOf(auth);
  if ((input.shiftStart ?? before.shiftStart) === (input.shiftEnd ?? before.shiftEnd)) {
    throw AppError.badRequest('The shift must end at a different time than it starts.', [{ field: 'shiftEnd', message: 'Choose a different end time.' }]);
  }
  if (input.weeklyOffDays && new Set(input.weeklyOffDays).size === 7) {
    throw AppError.badRequest('Keep at least one working day in the week.', [{ field: 'weeklyOffDays', message: 'Keep at least one working day.' }]);
  }
  const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<Organization>;
  const after = db.organizations.update(auth.organizationId, patch);
  const keys = Object.keys(patch) as (keyof Organization)[];
  const changed = changedFields(
    Object.fromEntries(keys.map((k) => [k, before[k]])),
    Object.fromEntries(keys.map((k) => [k, after[k]])),
  );
  writeAudit(auth, auth.organizationId, { action: 'org.profile_updated', entityType: 'Organization', entityId: auth.organizationId, summary: { changedFields: changed } });
  return { ok: true };
});

// -- Departments and designations ---------------------------------------------------------------------------------

orgRouter.get('/departments', (req) => {
  const auth = requireAuth(req);
  const items = db.departments
    .filter(inOrg(auth))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => ({
      id: d.id,
      name: d.name,
      code: d.code,
      employeeCount: db.employees.count((e) => e.departmentId === d.id && e.status !== 'EXITED'),
    }));
  return { items };
});

const deptSchema = z.object({ name: z.string().trim().min(2).max(60), code: z.string().trim().regex(/^[A-Za-z]{2,6}$/, '2-6 letters.') });

orgRouter.post('/departments', requirePermission('org:manage'), (req) => {
  const auth = requireAuth(req);
  const input = deptSchema.parse(req.body);
  try {
    const d = db.departments.insert({ ...input, code: input.code.toUpperCase(), organizationId: auth.organizationId });
    writeAudit(auth, auth.organizationId, { action: 'department.created', entityType: 'Department', entityId: d.id, summary: { name: d.name } });
    return created({ id: d.id });
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw AppError.conflict('A department with this name or code already exists.');
    throw err;
  }
});

orgRouter.delete('/departments/:id', requirePermission('org:manage'), (req) => {
  const auth = requireAuth(req);
  const id = req.params['id'];
  const count = db.employees.count((e) => e.departmentId === id && e.organizationId === auth.organizationId);
  if (count > 0) throw AppError.invalidState(`This department has ${count} employee record(s). Move them to another department first.`);
  db.departments.deleteWhere((d) => d.id === id && d.organizationId === auth.organizationId);
  writeAudit(auth, auth.organizationId, { action: 'department.deleted', entityType: 'Department', entityId: id });
  return noContent();
});

orgRouter.get('/designations', (req) => {
  const auth = requireAuth(req);
  const items = db.designations
    .filter(inOrg(auth))
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((d) => ({ id: d.id, title: d.title }));
  return { items };
});

orgRouter.post('/designations', requirePermission('org:manage'), (req) => {
  const auth = requireAuth(req);
  const input = z.object({ title: z.string().trim().min(2).max(80) }).parse(req.body);
  try {
    const d = db.designations.insert({ title: input.title, organizationId: auth.organizationId });
    writeAudit(auth, auth.organizationId, { action: 'designation.created', entityType: 'Designation', entityId: d.id, summary: { title: d.title } });
    return created({ id: d.id });
  } catch (err) {
    if (err instanceof UniqueConstraintError) throw AppError.conflict('This designation already exists.');
    throw err;
  }
});

orgRouter.delete('/designations/:id', requirePermission('org:manage'), (req) => {
  const auth = requireAuth(req);
  const id = req.params['id'];
  const count = db.employees.count((e) => e.designationId === id && e.organizationId === auth.organizationId);
  if (count > 0) throw AppError.invalidState(`${count} employee(s) hold this designation. Reassign them first.`);
  db.designations.deleteWhere((d) => d.id === id && d.organizationId === auth.organizationId);
  writeAudit(auth, auth.organizationId, { action: 'designation.deleted', entityType: 'Designation', entityId: id });
  return noContent();
});

// -- Holidays -----------------------------------------------------------------------------------------------------

orgRouter.get('/holidays', (req) => {
  const auth = requireAuth(req);
  const year = z.coerce.number().int().min(2000).max(2100).default(new Date().getUTCFullYear()).parse(req.query['year'] ?? undefined);
  const items = db.holidays
    .filter((h) => inOrg(auth)(h) && h.holidayDate >= `${year}-01-01` && h.holidayDate <= `${year}-12-31`)
    .sort((a, b) => a.holidayDate.localeCompare(b.holidayDate))
    .map((h) => ({ id: h.id, date: h.holidayDate, name: h.name }));
  return { year, items };
});

orgRouter.post('/holidays', requirePermission('org:manage'), (req) => {
  const auth = requireAuth(req);
  const input = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: z.string().trim().min(2).max(100) }).parse(req.body);
  try {
    const h = db.holidays.insert({ organizationId: auth.organizationId, holidayDate: input.date, name: input.name });
    writeAudit(auth, auth.organizationId, { action: 'holiday.created', entityType: 'Holiday', entityId: h.id, summary: { date: input.date } });
    return created({ id: h.id });
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      throw AppError.conflict('A holiday already exists on this date.', [{ field: 'date', message: 'Choose another date.' }]);
    }
    throw err;
  }
});

orgRouter.delete('/holidays/:id', requirePermission('org:manage'), (req) => {
  const auth = requireAuth(req);
  const id = req.params['id'];
  db.holidays.deleteWhere((h) => h.id === id && h.organizationId === auth.organizationId);
  writeAudit(auth, auth.organizationId, { action: 'holiday.deleted', entityType: 'Holiday', entityId: id });
  return noContent();
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

/** Announcements the caller should see now: published, not expired, for their role and department (or everyone). */
export function visibleAnnouncements(auth: Pick<AuthContext, 'organizationId' | 'role' | 'employeeId'>, take: number): Announcement[] {
  const now = new Date().toISOString();
  const departmentId = auth.employeeId ? (db.employees.get(auth.employeeId)?.departmentId ?? null) : null;
  return db.announcements
    .filter(
      (a) =>
        a.organizationId === auth.organizationId &&
        a.publishAt <= now &&
        (a.expiresAt === null || a.expiresAt > now) &&
        (a.audienceRole === null || a.audienceRole === auth.role) &&
        (a.departmentId === null || a.departmentId === departmentId),
    )
    .sort((a, b) => b.publishAt.localeCompare(a.publishAt))
    .slice(0, take);
}

orgRouter.get('/announcements', (req) => {
  const auth = requireAuth(req);
  const manageAll = hasPermission(auth.role, 'org:manage') && req.query['all'] === 'true';
  const rows = manageAll
    ? db.announcements
        .filter(inOrg(auth))
        .sort((a, b) => b.publishAt.localeCompare(a.publishAt))
        .slice(0, 50)
    : visibleAnnouncements(auth, 50);
  return { items: rows };
});

orgRouter.post('/announcements', requirePermission('org:manage'), (req) => {
  const auth = requireAuth(req);
  const input = announcementSchema.parse(req.body);
  const row = db.announcements.insert({
    organizationId: auth.organizationId,
    title: input.title,
    body: input.body,
    publishAt: input.publishAt ? isoOf(input.publishAt) : new Date().toISOString(),
    expiresAt: input.expiresAt ? isoOf(input.expiresAt) : null,
    audienceRole: input.audienceRole ?? null,
    departmentId: input.departmentId ?? null,
    createdById: auth.userId,
  });
  writeAudit(auth, auth.organizationId, { action: 'announcement.created', entityType: 'Announcement', entityId: row.id, summary: { title: row.title } });
  return created({ id: row.id });
});

orgRouter.put('/announcements/:id', requirePermission('org:manage'), (req) => {
  const auth = requireAuth(req);
  const id = req.params['id'];
  const input = announcementSchema.parse(req.body);
  const existing = db.announcements.get(id);
  if (!existing || existing.organizationId !== auth.organizationId) throw AppError.notFound('Announcement not found.');
  const row = db.announcements.update(id, {
    title: input.title,
    body: input.body,
    publishAt: input.publishAt ? isoOf(input.publishAt) : existing.publishAt,
    expiresAt: input.expiresAt ? isoOf(input.expiresAt) : null,
    audienceRole: input.audienceRole ?? null,
    departmentId: input.departmentId ?? null,
  });
  writeAudit(auth, auth.organizationId, { action: 'announcement.updated', entityType: 'Announcement', entityId: row.id, summary: { title: row.title } });
  return { id: row.id };
});

orgRouter.delete('/announcements/:id', requirePermission('org:manage'), (req) => {
  const auth = requireAuth(req);
  const id = req.params['id'];
  db.announcements.deleteWhere((a) => a.id === id && a.organizationId === auth.organizationId);
  writeAudit(auth, auth.organizationId, { action: 'announcement.deleted', entityType: 'Announcement', entityId: id });
  return noContent();
});

// -- Audit trail --------------------------------------------------------------------------------------------------

orgRouter.get('/audit-logs', requirePermission('audit:read'), (req) => {
  const auth = requireAuth(req);
  const q = z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
      entityType: z.string().max(40).optional(),
      action: z.string().max(80).optional(),
    })
    .parse(req.query);
  const action = q.action?.toLowerCase();
  const rows = db.auditLogs
    .filter((r) => inOrg(auth)(r) && (!q.entityType || r.entityType === q.entityType) && (!action || r.action.toLowerCase().includes(action)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const start = (q.page - 1) * q.pageSize;
  return {
    page: q.page,
    pageSize: q.pageSize,
    total: rows.length,
    totalPages: Math.max(1, Math.ceil(rows.length / q.pageSize)),
    items: rows.slice(start, start + q.pageSize).map((r) => ({
      id: r.id,
      actor: r.actorEmail,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      summary: r.summary,
      ipAddress: r.ipAddress,
      createdAt: r.createdAt,
    })),
  };
});
