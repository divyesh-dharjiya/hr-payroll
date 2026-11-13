import { z } from 'zod';
import { AppError } from '../../lib/errors';
import { Router, created, requireAuth, requirePermission } from '../../http/router';
import * as svc from './leave.service';

export const leaveRouter = new Router('/leave');

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

leaveRouter.get('/types', (req) => ({ items: svc.listTypes(requireAuth(req)) }));

leaveRouter.post('/types', requirePermission('leave:manage'), (req) => created(svc.saveLeaveType(requireAuth(req), null, typeSchema.parse(req.body))));

leaveRouter.patch('/types/:id', requirePermission('leave:manage'), (req) => svc.saveLeaveType(requireAuth(req), req.params['id'], typeSchema.parse(req.body)));

leaveRouter.get('/balances', (req) => svc.balancesFor(requireAuth(req), z.string().optional().parse(req.query['employeeId'])));

const requestSchema = z.object({
  leaveTypeId: z.string().min(1, 'Choose a leave type.'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.'),
  isHalfDay: z.boolean().default(false),
  reason: z.string().trim().min(5, 'Give a short reason (at least 5 characters).').max(500),
});

leaveRouter.get('/requests', (req) => {
  const status = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'CANCEL_REQUESTED']).optional().parse(req.query['status']);
  return { items: svc.listRequests(requireAuth(req), status) };
});

leaveRouter.post('/requests', (req) => created(svc.createRequest(requireAuth(req), requestSchema.parse(req.body))));

leaveRouter.post('/requests/:id/decision', (req) => {
  const body = z.object({ decision: z.enum(['APPROVE', 'REJECT']), comment: z.string().trim().max(500).optional() }).parse(req.body);
  if (body.decision === 'REJECT' && !body.comment) {
    throw AppError.badRequest('Add a comment when rejecting leave.', [{ field: 'comment', message: 'Add a reason.' }]);
  }
  return svc.decideRequest(requireAuth(req), req.params['id'], body.decision, body.comment);
});

leaveRouter.post('/requests/:id/cancel', (req) => {
  const body = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
  return svc.cancelRequest(requireAuth(req), req.params['id'], body.reason);
});

leaveRouter.post('/requests/:id/cancellation-decision', (req) => {
  const body = z.object({ decision: z.enum(['APPROVE', 'REJECT']) }).parse(req.body);
  return svc.decideCancellation(requireAuth(req), req.params['id'], body.decision);
});

leaveRouter.get('/calendar', (req) => {
  const q = z.object({ year: z.coerce.number().int(), month: z.coerce.number().int().min(1).max(12) }).parse(req.query);
  return svc.availabilityCalendar(requireAuth(req), q.year, q.month);
});
