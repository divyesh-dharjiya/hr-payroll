import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../../middleware/auth';
import * as svc from './leave.service';

export const leaveRouter = Router();

const typeSchema = z.object({
  code: z.string().trim().regex(/^[A-Za-z]{2,10}$/, 'Use 2-10 letters, for example CL or SL.'),
  name: z.string().trim().min(2).max(60),
  isPaid: z.boolean(),
  annualQuotaDays: z.number().min(0).max(366).multipleOf(0.5, 'Use whole or half days.'),
  accrual: z.enum(['UPFRONT', 'MONTHLY']),
  allowHalfDay: z.boolean(),
  carryForwardDays: z.number().min(0).max(366).multipleOf(0.5, 'Use whole or half days.').default(0),
  isActive: z.boolean().default(true),
});

leaveRouter.get('/types', async (req, res) => {
  res.json({ items: await svc.listTypes(requireAuth(req)) });
});

leaveRouter.post('/types', requirePermission('leave:manage'), async (req, res) => {
  res.status(201).json(await svc.saveLeaveType(requireAuth(req), null, typeSchema.parse(req.body), req));
});

leaveRouter.patch('/types/:id', requirePermission('leave:manage'), async (req, res) => {
  res.json(await svc.saveLeaveType(requireAuth(req), req.params.id as string, typeSchema.parse(req.body), req));
});

leaveRouter.get('/balances', async (req, res) => {
  const employeeId = z.string().optional().parse(req.query.employeeId);
  res.json(await svc.balancesFor(requireAuth(req), employeeId));
});

const requestSchema = z.object({
  leaveTypeId: z.string().min(1, 'Choose a leave type.'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.'),
  isHalfDay: z.boolean().default(false),
  reason: z.string().trim().min(5, 'Give a short reason (at least 5 characters).').max(500),
});

leaveRouter.get('/requests', async (req, res) => {
  const status = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'CANCEL_REQUESTED']).optional().parse(req.query.status);
  res.json({ items: await svc.listRequests(requireAuth(req), status) });
});

leaveRouter.post('/requests', async (req, res) => {
  res.status(201).json(await svc.createRequest(requireAuth(req), requestSchema.parse(req.body), req));
});

leaveRouter.post('/requests/:id/decision', async (req, res) => {
  const body = z.object({ decision: z.enum(['APPROVE', 'REJECT']), comment: z.string().trim().max(500).optional() }).parse(req.body);
  if (body.decision === 'REJECT' && !body.comment) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Add a comment when rejecting leave.', details: [{ field: 'comment', message: 'Add a reason.' }] } });
  }
  res.json(await svc.decideRequest(requireAuth(req), req.params.id as string, body.decision, body.comment, req));
});

leaveRouter.post('/requests/:id/cancel', async (req, res) => {
  const body = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
  res.json(await svc.cancelRequest(requireAuth(req), req.params.id as string, body.reason, req));
});

leaveRouter.post('/requests/:id/cancellation-decision', async (req, res) => {
  const body = z.object({ decision: z.enum(['APPROVE', 'REJECT']) }).parse(req.body);
  res.json(await svc.decideCancellation(requireAuth(req), req.params.id as string, body.decision, req));
});

leaveRouter.get('/calendar', async (req, res) => {
  const q = z.object({ year: z.coerce.number().int(), month: z.coerce.number().int().min(1).max(12) }).parse(req.query);
  res.json(await svc.availabilityCalendar(requireAuth(req), q.year, q.month));
});
