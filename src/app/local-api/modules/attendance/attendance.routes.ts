import { z } from 'zod';
import { AppError } from '../../lib/errors';
import { Router, created, requireAuth } from '../../http/router';
import * as svc from './attendance.service';

export const attendanceRouter = new Router('/attendance');

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
// An instant with an offset, or a wall-clock time without one (read in the organization timezone).
const isoInstant = z.union(
  [z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/)],
  { message: 'Use a date-time such as 2026-10-19T09:45 or 2026-10-19T09:45:00+05:30.' },
);

attendanceRouter.get('/today', (req) => svc.getToday(requireAuth(req)));

// Toggle: punches out of the open session, or punches in (working days only). Returns today's updated state.
attendanceRouter.post('/punch', (req) => svc.punch(requireAuth(req)));

attendanceRouter.post('/check-in', (req) => created(svc.checkIn(requireAuth(req))));

attendanceRouter.post('/check-out', (req) => svc.checkOut(requireAuth(req)));

const rangeQuery = z.object({
  from: ymd,
  to: ymd,
  employeeId: z.string().optional(),
});

attendanceRouter.get('/', (req) => {
  const q = rangeQuery.parse(req.query);
  if (q.to < q.from) throw AppError.badRequest('The end date must be after the start date.');
  return { items: svc.listRecords(requireAuth(req), q.from, q.to, q.employeeId) };
});

attendanceRouter.get('/calendar', (req) => {
  const q = z
    .object({ employeeId: z.string(), year: z.coerce.number().int().min(2000).max(2100), month: z.coerce.number().int().min(1).max(12) })
    .parse(req.query);
  return svc.monthCalendar(requireAuth(req), q.employeeId, q.year, q.month);
});

attendanceRouter.get('/summary', (req) => {
  const q = z.object({ year: z.coerce.number().int(), month: z.coerce.number().int().min(1).max(12) }).parse(req.query);
  return svc.monthlySummary(requireAuth(req), q.year, q.month);
});

const correctionSchema = z.object({
  workDate: ymd,
  requestedCheckIn: isoInstant.optional(),
  requestedCheckOut: isoInstant.optional(),
  reason: z.string().trim().min(5, 'Explain the correction in at least 5 characters.').max(500),
});

attendanceRouter.post('/corrections', (req) => created(svc.requestCorrection(requireAuth(req), correctionSchema.parse(req.body))));

attendanceRouter.get('/corrections', (req) => {
  const status = z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional().parse(req.query['status']);
  const mine = z.enum(['true', 'false']).optional().parse(req.query['mine']) === 'true';
  return { items: svc.listCorrections(requireAuth(req), status, mine) };
});

// Overtime: `mine=true` lists the caller's own claims; otherwise the reviewer's scope (team or company).
attendanceRouter.get('/overtime', (req) => {
  const q = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(), mine: z.enum(['true', 'false']).optional() }).parse(req.query);
  return { items: svc.listOvertime(requireAuth(req), q.status, q.mine === 'true') };
});

attendanceRouter.post('/overtime/review', (req) => {
  const body = z
    .object({
      ids: z.array(z.string().min(1)).min(1, 'Choose at least one day.').max(200),
      decision: z.enum(['APPROVE', 'REJECT']),
      minutes: z.number().int().positive().optional(),
      comment: z.string().trim().max(500).optional(),
    })
    .parse(req.body);
  if (body.decision === 'REJECT' && !body.comment) {
    throw AppError.badRequest('Add a comment when rejecting overtime.', [{ field: 'comment', message: 'Add a reason.' }]);
  }
  return svc.reviewOvertime(requireAuth(req), body);
});

attendanceRouter.post('/corrections/:id/review', (req) => {
  const body = z.object({ decision: z.enum(['APPROVE', 'REJECT']), comment: z.string().trim().max(500).optional() }).parse(req.body);
  if (body.decision === 'REJECT' && !body.comment) {
    throw AppError.badRequest('Add a comment when rejecting a request.', [{ field: 'comment', message: 'Add a reason.' }]);
  }
  return svc.reviewCorrection(requireAuth(req), req.params['id'], body.decision, body.comment);
});
