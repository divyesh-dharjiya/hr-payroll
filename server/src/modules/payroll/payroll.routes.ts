import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../../middleware/auth';
import * as svc from './payroll.service';

export const payrollRouter = Router();

const periodSchema = z.object({
  year: z.coerce.number().int(),
  month: z.coerce.number().int().min(1).max(12),
});

payrollRouter.get('/runs', requirePermission('payroll:read'), async (req, res) => {
  res.json({ items: await svc.listRuns(requireAuth(req)) });
});

payrollRouter.post('/runs', requirePermission('payroll:manage'), async (req, res) => {
  const body = periodSchema.parse(req.body);
  res.status(201).json(await svc.createRun(requireAuth(req), body.year, body.month, req));
});

payrollRouter.get('/runs/:id', requirePermission('payroll:read'), async (req, res) => {
  res.json(await svc.getRun(requireAuth(req), req.params.id as string));
});

payrollRouter.post('/runs/:id/recalculate', requirePermission('payroll:manage'), async (req, res) => {
  res.json(await svc.recalculateRun(requireAuth(req), req.params.id as string, req));
});

payrollRouter.post('/runs/:id/validate', requirePermission('payroll:manage'), async (req, res) => {
  res.json(await svc.validateRun(requireAuth(req), req.params.id as string, req));
});

payrollRouter.post('/runs/:id/reopen', requirePermission('payroll:manage'), async (req, res) => {
  const body = z.object({ reason: z.string().trim().min(5, 'Give a reason for reopening.').max(300) }).parse(req.body);
  res.json(await svc.reopenRun(requireAuth(req), req.params.id as string, body.reason, req));
});

payrollRouter.post('/runs/:id/approve', requirePermission('payroll:approve'), async (req, res) => {
  res.json(await svc.approveRun(requireAuth(req), req.params.id as string, req));
});

payrollRouter.post('/runs/:id/finalize', requirePermission('payroll:approve'), async (req, res) => {
  res.json(await svc.finalizeRun(requireAuth(req), req.params.id as string, req));
});

payrollRouter.get('/runs/:id/bank-export.csv', requirePermission('payroll:bank-export'), async (req, res) => {
  const csv = await svc.bankExportCsv(requireAuth(req), req.params.id as string, req);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="bank-transfer.csv"');
  res.send(csv);
});

payrollRouter.post('/entries/:entryId/payment', requirePermission('payroll:manage'), async (req, res) => {
  const body = z.object({ reference: z.string().trim().min(3, 'Enter the bank transaction reference.').max(64) }).parse(req.body);
  res.json(await svc.markPayment(requireAuth(req), req.params.entryId as string, body.reference, req));
});

const adjustmentSchema = z.object({
  employeeId: z.string().min(1),
  year: z.coerce.number().int(),
  month: z.coerce.number().int().min(1).max(12),
  kind: z.enum(['EARNING', 'DEDUCTION']),
  label: z.string().trim().min(2, 'Describe the adjustment.').max(100),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Enter a positive amount, for example 1500 or 1500.50'),
});

payrollRouter.get('/adjustments', requirePermission('payroll:read'), async (req, res) => {
  const q = periodSchema.parse(req.query);
  res.json({ items: await svc.listAdjustments(requireAuth(req), q.year, q.month) });
});

payrollRouter.post('/adjustments', requirePermission('payroll:manage'), async (req, res) => {
  const body = adjustmentSchema.parse(req.body);
  const amountPaise = Math.round(Number(body.amount) * 100);
  if (amountPaise <= 0) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Enter an amount greater than zero.', details: [{ field: 'amount', message: 'Must be greater than zero.' }] } });
  }
  res.status(201).json(await svc.addAdjustment(requireAuth(req), { ...body, amountPaise }, req));
});

// Employees see their own payslips; the service enforces scope for everyone else.
payrollRouter.get('/payslips/mine', async (req, res) => {
  res.json(await svc.listMyPayslips(requireAuth(req)));
});

payrollRouter.get('/payslips/:entryId', async (req, res) => {
  res.json(await svc.getPayslip(requireAuth(req), req.params.entryId as string, req));
});

payrollRouter.get('/reports/summary', requirePermission('payroll:read'), async (req, res) => {
  const q = z.object({ year: z.coerce.number().int() }).parse(req.query);
  res.json({ items: await svc.payrollSummaryReport(requireAuth(req), q.year) });
});
