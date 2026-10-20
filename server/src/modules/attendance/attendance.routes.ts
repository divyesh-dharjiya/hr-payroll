import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth';
import * as svc from './attendance.service';

export const attendanceRouter = Router();

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const isoInstant = z.string().datetime({ offset: true, message: 'Use an ISO date-time such as 2026-10-19T09:45:00+05:30.' });

attendanceRouter.get('/today', async (req, res) => {
  res.json(await svc.getToday(requireAuth(req)));
});

// Toggle: punches out of the open session, or punches in (working days only). Returns today's updated state.
attendanceRouter.post('/punch', async (req, res) => {
  res.json(await svc.punch(requireAuth(req), req));
});

attendanceRouter.post('/check-in', async (req, res) => {
  res.status(201).json(await svc.checkIn(requireAuth(req), req));
});

attendanceRouter.post('/check-out', async (req, res) => {
  res.json(await svc.checkOut(requireAuth(req), req));
});

const rangeQuery = z.object({
  from: ymd,
  to: ymd,
  employeeId: z.string().optional(),
});

attendanceRouter.get('/', async (req, res) => {
  const q = rangeQuery.parse(req.query);
  if (q.to < q.from) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'The end date must be after the start date.' } });
  res.json({ items: await svc.listRecords(requireAuth(req), q.from, q.to, q.employeeId) });
});

attendanceRouter.get('/calendar', async (req, res) => {
  const q = z.object({ employeeId: z.string(), year: z.coerce.number().int().min(2000).max(2100), month: z.coerce.number().int().min(1).max(12) }).parse(req.query);
  res.json(await svc.monthCalendar(requireAuth(req), q.employeeId, q.year, q.month));
});

attendanceRouter.get('/summary', async (req, res) => {
  const q = z.object({ year: z.coerce.number().int(), month: z.coerce.number().int().min(1).max(12) }).parse(req.query);
  res.json(await svc.monthlySummary(requireAuth(req), q.year, q.month));
});

const correctionSchema = z
  .object({
    workDate: ymd,
    requestedCheckIn: isoInstant.optional(),
    requestedCheckOut: isoInstant.optional(),
    reason: z.string().trim().min(5, 'Explain the correction in at least 5 characters.').max(500),
  });

attendanceRouter.post('/corrections', async (req, res) => {
  const input = correctionSchema.parse(req.body);
  res.status(201).json(await svc.requestCorrection(requireAuth(req), input, req));
});

attendanceRouter.get('/corrections', async (req, res) => {
  const status = z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional().parse(req.query.status);
  res.json({ items: await svc.listCorrections(requireAuth(req), status) });
});

attendanceRouter.post('/corrections/:id/review', async (req, res) => {
  const body = z
    .object({ decision: z.enum(['APPROVE', 'REJECT']), comment: z.string().trim().max(500).optional() })
    .parse(req.body);
  if (body.decision === 'REJECT' && !body.comment) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Add a comment when rejecting a request.', details: [{ field: 'comment', message: 'Add a reason.' }] } });
  }
  res.json(await svc.reviewCorrection(requireAuth(req), req.params.id as string, body.decision, body.comment, req));
});
