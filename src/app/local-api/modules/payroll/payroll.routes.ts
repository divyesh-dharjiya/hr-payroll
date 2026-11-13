import { z } from 'zod';
import { AppError } from '../../lib/errors';
import { Router, created, requireAuth, requirePermission } from '../../http/router';
import * as svc from './payroll.service';
import { renderPayslipPdf, type PayslipForPdf } from './payslip.pdf';

export const payrollRouter = new Router('/payroll');

const periodSchema = z.object({
  year: z.coerce.number().int(),
  month: z.coerce.number().int().min(1).max(12),
});

payrollRouter.get('/runs', requirePermission('payroll:read'), (req) => ({ items: svc.listRuns(requireAuth(req)) }));

payrollRouter.post('/runs', requirePermission('payroll:manage'), (req) => {
  const body = periodSchema.parse(req.body);
  return created(svc.createRun(requireAuth(req), body.year, body.month));
});

payrollRouter.get('/runs/:id', requirePermission('payroll:read'), (req) => svc.getRun(requireAuth(req), req.params['id']));

payrollRouter.post('/runs/:id/recalculate', requirePermission('payroll:manage'), (req) => svc.recalculateRun(requireAuth(req), req.params['id']));

payrollRouter.post('/runs/:id/validate', requirePermission('payroll:manage'), (req) => svc.validateRun(requireAuth(req), req.params['id']));

payrollRouter.post('/runs/:id/reopen', requirePermission('payroll:manage'), (req) => {
  const body = z.object({ reason: z.string().trim().min(5, 'Give a reason for reopening.').max(300) }).parse(req.body);
  return svc.reopenRun(requireAuth(req), req.params['id'], body.reason);
});

payrollRouter.post('/runs/:id/approve', requirePermission('payroll:approve'), (req) => svc.approveRun(requireAuth(req), req.params['id']));

payrollRouter.post('/runs/:id/finalize', requirePermission('payroll:approve'), (req) => svc.finalizeRun(requireAuth(req), req.params['id']));

payrollRouter.get('/runs/:id/bank-export.csv', requirePermission('payroll:bank-export'), (req) => svc.bankExportCsv(requireAuth(req), req.params['id']));

payrollRouter.post('/entries/:entryId/payment', requirePermission('payroll:manage'), (req) => {
  const body = z.object({ reference: z.string().trim().min(3, 'Enter the bank transaction reference.').max(64) }).parse(req.body);
  return svc.markPayment(requireAuth(req), req.params['entryId'], body.reference);
});

const adjustmentSchema = z.object({
  employeeId: z.string().min(1),
  year: z.coerce.number().int(),
  month: z.coerce.number().int().min(1).max(12),
  kind: z.enum(['EARNING', 'DEDUCTION']),
  label: z.string().trim().min(2, 'Describe the adjustment.').max(100),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Enter a positive amount, for example 1500 or 1500.50'),
});

payrollRouter.get('/adjustments', requirePermission('payroll:read'), (req) => {
  const q = periodSchema.parse(req.query);
  return { items: svc.listAdjustments(requireAuth(req), q.year, q.month) };
});

payrollRouter.post('/adjustments', requirePermission('payroll:manage'), (req) => {
  const { amount, ...body } = adjustmentSchema.parse(req.body);
  const amountPaise = Math.round(Number(amount) * 100);
  if (amountPaise <= 0) {
    throw AppError.badRequest('Enter an amount greater than zero.', [{ field: 'amount', message: 'Must be greater than zero.' }]);
  }
  return created(svc.addAdjustment(requireAuth(req), { ...body, amountPaise }));
});

// Employees see their own payslips; the service enforces scope for everyone else.
payrollRouter.get('/payslips/mine', (req) => svc.listMyPayslips(requireAuth(req)));

// PDF of a finalized payslip, rendered from the same data as the page (same access rules and audit).
payrollRouter.get('/payslips/:entryId/pdf', (req) => {
  const slip = svc.getPayslip(requireAuth(req), req.params['entryId']);
  return renderPayslipPdf(slip as PayslipForPdf);
});

payrollRouter.get('/payslips/:entryId', (req) => svc.getPayslip(requireAuth(req), req.params['entryId']));

payrollRouter.get('/reports/summary', requirePermission('payroll:read'), (req) => {
  const q = z.object({ year: z.coerce.number().int() }).parse(req.query);
  return { items: svc.payrollSummaryReport(requireAuth(req), q.year) };
});
