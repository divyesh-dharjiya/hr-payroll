import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { requireAuth, requirePermission } from '../../middleware/auth';
import * as S from './employees.schemas';
import * as svc from './employees.service';
import { photoSchema, removePhoto, setPhoto } from './employees.photos';

export const employeesRouter = Router();

// Lookups used by forms. Managers see only their own direct reports in the manager picker, HR sees all.
employeesRouter.get('/meta', requirePermission('employees:read'), async (req, res) => {
  const auth = requireAuth(req);
  const [departments, designations, managers] = await Promise.all([
    prisma.department.findMany({ where: { organizationId: auth.organizationId }, orderBy: { name: 'asc' }, select: { id: true, name: true, code: true } }),
    prisma.designation.findMany({ where: { organizationId: auth.organizationId }, orderBy: { title: 'asc' }, select: { id: true, title: true } }),
    prisma.employee.findMany({
      where: { organizationId: auth.organizationId, status: { not: 'EXITED' } },
      orderBy: { firstName: 'asc' },
      select: { id: true, firstName: true, lastName: true, employeeCode: true },
    }),
  ]);
  res.json({
    departments,
    designations,
    managers: managers.map((m) => ({ id: m.id, name: `${m.firstName} ${m.lastName}`, employeeCode: m.employeeCode })),
  });
});

employeesRouter.get('/', requirePermission('employees:read'), async (req, res) => {
  const auth = requireAuth(req);
  const query = S.listQuerySchema.parse(req.query);
  res.json(await svc.listEmployees(auth, query));
});

employeesRouter.get('/export.csv', requirePermission('employees:export'), async (req, res) => {
  const auth = requireAuth(req);
  const query = S.listQuerySchema.parse(req.query);
  const csv = await svc.exportEmployeesCsv(auth, query, req);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="employees.csv"');
  res.send(csv);
});

const importSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1, 'The file has no data rows.').max(1000, 'Import at most 1000 rows at a time.'),
  commit: z.boolean().default(false),
});

employeesRouter.post('/import', requirePermission('employees:write'), async (req, res) => {
  const auth = requireAuth(req);
  const body = importSchema.parse(req.body);
  res.json(await svc.importEmployees(auth, body.rows, body.commit, req));
});

employeesRouter.post('/', requirePermission('employees:write'), async (req, res) => {
  const auth = requireAuth(req);
  const input = S.createEmployeeSchema.parse(req.body);
  res.status(201).json(await svc.createEmployee(auth, input, req));
});

// Profile: reachable by HR, by the manager for direct reports, and by the employee for their own record.
employeesRouter.get('/:id', async (req, res) => {
  const auth = requireAuth(req);
  res.json(await svc.getEmployee(auth, req.params.id as string));
});

employeesRouter.patch('/:id', requirePermission('employees:write'), async (req, res) => {
  const auth = requireAuth(req);
  const input = S.updateEmployeeSchema.parse(req.body);
  res.json(await svc.updateEmployee(auth, req.params.id as string, input, req));
});

employeesRouter.put('/:id/bank-details', requirePermission('employees:sensitive'), async (req, res) => {
  const auth = requireAuth(req);
  const input = S.bankDetailsSchema.parse(req.body);
  res.json(await svc.setBankDetails(auth, req.params.id as string, input, req));
});

employeesRouter.get('/:id/sensitive', requirePermission('employees:sensitive'), async (req, res) => {
  const auth = requireAuth(req);
  res.json(await svc.revealSensitive(auth, req.params.id as string, req));
});

employeesRouter.post('/:id/offboard', requirePermission('employees:write'), async (req, res) => {
  const auth = requireAuth(req);
  const input = S.offboardSchema.parse(req.body);
  res.json(await svc.offboardEmployee(auth, req.params.id as string, input, req));
});

// Photo: HR for anyone, employees for themselves (checked in the service).
employeesRouter.put('/:id/photo', async (req, res) => {
  const auth = requireAuth(req);
  const { dataUrl } = photoSchema.parse(req.body);
  res.json(await setPhoto(auth, req.params.id as string, dataUrl, req));
});

employeesRouter.delete('/:id/photo', async (req, res) => {
  await removePhoto(requireAuth(req), req.params.id as string, req);
  res.status(204).end();
});

employeesRouter.get('/:id/salary-history', requirePermission('payroll:read'), async (req, res) => {
  const auth = requireAuth(req);
  res.json({ items: await svc.listSalaryHistory(auth, req.params.id as string) });
});

employeesRouter.post('/:id/salary', requirePermission('payroll:manage'), async (req, res) => {
  const auth = requireAuth(req);
  const input = S.salarySchema.parse(req.body);
  res.status(201).json(await svc.addSalaryAssignment(auth, req.params.id as string, input, req));
});
