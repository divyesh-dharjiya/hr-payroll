import { z } from 'zod';
import { db } from '../../db';
import { Router, created, noContent, requireAuth, requirePermission } from '../../http/router';
import * as S from './employees.schemas';
import * as svc from './employees.service';
import { photoSchema, removePhoto, setPhoto } from './employees.photos';

export const employeesRouter = new Router('/employees');

const byName = <T>(key: (row: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b), 'en', { sensitivity: 'base' });

// Lookups used by forms. Managers see only their own direct reports in the manager picker, HR sees all.
employeesRouter.get('/meta', requirePermission('employees:read'), (req) => {
  const auth = requireAuth(req);
  const inOrg = (r: { organizationId: string }) => r.organizationId === auth.organizationId;
  return {
    departments: db.departments.filter(inOrg).sort(byName((d) => d.name)).map((d) => ({ id: d.id, name: d.name, code: d.code })),
    designations: db.designations.filter(inOrg).sort(byName((d) => d.title)).map((d) => ({ id: d.id, title: d.title })),
    managers: db.employees
      .filter((e) => inOrg(e) && e.status !== 'EXITED')
      .sort(byName((e) => e.firstName))
      .map((m) => ({ id: m.id, name: svc.fullName(m), employeeCode: m.employeeCode })),
  };
});

employeesRouter.get('/', requirePermission('employees:read'), (req) => {
  return svc.listEmployees(requireAuth(req), S.listQuerySchema.parse(req.query));
});

employeesRouter.get('/export.csv', requirePermission('employees:export'), (req) => {
  return svc.exportEmployeesCsv(requireAuth(req), S.listQuerySchema.parse(req.query));
});

const importSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1, 'The file has no data rows.').max(1000, 'Import at most 1000 rows at a time.'),
  commit: z.boolean().default(false),
});

employeesRouter.post('/import', requirePermission('employees:write'), (req) => {
  const body = importSchema.parse(req.body);
  return svc.importEmployees(requireAuth(req), body.rows, body.commit);
});

employeesRouter.post('/', requirePermission('employees:write'), (req) => {
  return created(svc.createEmployee(requireAuth(req), S.createEmployeeSchema.parse(req.body)));
});

// Profile: reachable by HR, by the manager for direct reports, and by the employee for their own record.
employeesRouter.get('/:id', (req) => svc.getEmployee(requireAuth(req), req.params['id']));

employeesRouter.patch('/:id', requirePermission('employees:write'), (req) => {
  return svc.updateEmployee(requireAuth(req), req.params['id'], S.updateEmployeeSchema.parse(req.body));
});

employeesRouter.put('/:id/bank-details', requirePermission('employees:sensitive'), (req) => {
  return svc.setBankDetails(requireAuth(req), req.params['id'], S.bankDetailsSchema.parse(req.body));
});

employeesRouter.get('/:id/sensitive', requirePermission('employees:sensitive'), (req) => {
  return svc.revealSensitive(requireAuth(req), req.params['id']);
});

employeesRouter.post('/:id/offboard', requirePermission('employees:write'), (req) => {
  return svc.offboardEmployee(requireAuth(req), req.params['id'], S.offboardSchema.parse(req.body));
});

// Photo: HR for anyone, employees for themselves (checked in the photo service).
employeesRouter.put('/:id/photo', (req) => {
  return setPhoto(requireAuth(req), req.params['id'], photoSchema.parse(req.body).dataUrl);
});

employeesRouter.delete('/:id/photo', (req) => {
  removePhoto(requireAuth(req), req.params['id']);
  return noContent();
});

employeesRouter.get('/:id/salary-history', requirePermission('payroll:read'), (req) => {
  return { items: svc.listSalaryHistory(requireAuth(req), req.params['id']) };
});

employeesRouter.post('/:id/salary', requirePermission('payroll:manage'), (req) => {
  return created(svc.addSalaryAssignment(requireAuth(req), req.params['id'], S.salarySchema.parse(req.body)));
});
