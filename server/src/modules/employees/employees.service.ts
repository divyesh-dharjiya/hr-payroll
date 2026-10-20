import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { writeAudit, changedFields } from '../../lib/audit';
import { decryptField, encryptField, last4, randomToken } from '../../lib/crypto';
import { sendMail } from '../../lib/mailer';
import { env } from '../../config/env';
import { hasPermission } from '../../security/permissions';
import type { AuthContext } from '../../middleware/auth';
import { rupeesToPaise } from '../../lib/money';
import { dateOnly, todayIn, ymdOf } from '../../lib/time';
import { toCsv } from '../../lib/csv';
import { createsReportingCycle, exitStatusFor, nextEmployeeCodeFrom } from './employees.rules';
import * as S from './employees.schemas';

// ---------------------------------------------------------------------------------------------------------------
// Access scope. Enforced in the service, never delegated to the frontend:
//   HR_ADMIN / SUPER_ADMIN -> every employee in the organization
//   MANAGER                -> direct reports only
//   EMPLOYEE               -> own record only
// ---------------------------------------------------------------------------------------------------------------
// Two scopes:
//   employeeScope: whose records the caller may SEE, which always includes their own (a manager's own calendar,
//                  leave, payslips and profile).
//   teamScope:     whose requests the caller may DECIDE or list as their team: HR everyone, a manager their direct
//                  reports, an employee nobody. Deciding on your own request is refused separately.
export function employeeScope(auth: AuthContext): Prisma.EmployeeWhereInput {
  const base: Prisma.EmployeeWhereInput = { organizationId: auth.organizationId };
  if (hasPermission(auth.role, 'employees:read') && auth.role !== 'MANAGER') return base;
  if (auth.role === 'MANAGER' && auth.employeeId) return { ...base, OR: [{ managerId: auth.employeeId }, { id: auth.employeeId }] };
  if (auth.employeeId) return { ...base, id: auth.employeeId };
  return { ...base, id: '__none__' };
}

export function teamScope(auth: AuthContext): Prisma.EmployeeWhereInput {
  const base: Prisma.EmployeeWhereInput = { organizationId: auth.organizationId };
  if (auth.role === 'HR_ADMIN' || auth.role === 'SUPER_ADMIN') return base;
  if (auth.role === 'MANAGER' && auth.employeeId) return { ...base, managerId: auth.employeeId };
  return { ...base, id: '__none__' };
}

const summarySelect = {
  id: true,
  employeeCode: true,
  firstName: true,
  lastName: true,
  workEmail: true,
  phone: true,
  photoUrl: true,
  status: true,
  employmentType: true,
  onboardingStatus: true,
  joiningDate: true,
  workLocation: true,
  department: { select: { id: true, name: true } },
  designation: { select: { id: true, title: true } },
  manager: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.EmployeeSelect;

type EmployeeSummary = Prisma.EmployeeGetPayload<{ select: typeof summarySelect }>;

function toSummary(e: EmployeeSummary) {
  return {
    ...e,
    joiningDate: ymdOf(e.joiningDate),
    name: `${e.firstName} ${e.lastName}`,
    manager: e.manager ? { id: e.manager.id, name: `${e.manager.firstName} ${e.manager.lastName}` } : null,
  };
}

export async function listEmployees(auth: AuthContext, q: S.ListQuery) {
  // The directory lists the team: everyone for HR, direct reports for a manager.
  const where: Prisma.EmployeeWhereInput = { AND: [teamScope(auth)] };
  const and = where.AND as Prisma.EmployeeWhereInput[];
  if (q.q) {
    and.push({
      OR: [
        { firstName: { contains: q.q, mode: 'insensitive' } },
        { lastName: { contains: q.q, mode: 'insensitive' } },
        { employeeCode: { contains: q.q, mode: 'insensitive' } },
        { workEmail: { contains: q.q, mode: 'insensitive' } },
      ],
    });
  }
  if (q.departmentId) and.push({ departmentId: q.departmentId });
  if (q.status) and.push({ status: q.status });
  if (q.employmentType) and.push({ employmentType: q.employmentType });

  const orderBy: Prisma.EmployeeOrderByWithRelationInput[] =
    q.sort === 'code'
      ? [{ employeeCode: q.dir }]
      : q.sort === 'joiningDate'
        ? [{ joiningDate: q.dir }]
        : q.sort === 'department'
          ? [{ department: { name: q.dir } }, { firstName: 'asc' }]
          : [{ firstName: q.dir }, { lastName: q.dir }];

  const [total, rows] = await prisma.$transaction([
    prisma.employee.count({ where }),
    prisma.employee.findMany({
      where,
      orderBy,
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: summarySelect,
    }),
  ]);

  return {
    items: rows.map(toSummary),
    page: q.page,
    pageSize: q.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
  };
}

export async function getEmployee(auth: AuthContext, id: string) {
  const emp = await prisma.employee.findFirst({
    where: { AND: [employeeScope(auth), { id }] },
    select: {
      ...summarySelect,
      personalEmail: true,
      dateOfBirth: true,
      exitDate: true,
      emergencyContactName: true,
      emergencyContactPhone: true,
      addressLine: true,
      city: true,
      state: true,
      postalCode: true,
      bankAccountLast4: true,
      bankName: true,
      bankIfsc: true,
      panLast4: true,
      user: { select: { id: true, role: true, isActive: true, lastLoginAt: true } },
      reports: { select: { id: true, firstName: true, lastName: true, employeeCode: true }, where: { status: 'ACTIVE' } },
    },
  });
  if (!emp) throw AppError.notFound('Employee not found.');

  const canSeePay = hasPermission(auth.role, 'payroll:read');
  // The salary in effect today; a revision dated in the future is not "current" yet (it shows in the history).
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: auth.organizationId }, select: { timezone: true } });
  const today = dateOnly(todayIn(org.timezone));
  const salary = canSeePay
    ? ((await prisma.salaryAssignment.findFirst({ where: { employeeId: id, effectiveFrom: { lte: today } }, orderBy: { effectiveFrom: 'desc' } })) ??
      (await prisma.salaryAssignment.findFirst({ where: { employeeId: id }, orderBy: { effectiveFrom: 'asc' } })))
    : null;

  const { user, reports, bankAccountLast4, panLast4, ...rest } = emp;
  return {
    ...toSummary(rest),
    personalEmail: emp.personalEmail,
    dateOfBirth: emp.dateOfBirth ? ymdOf(emp.dateOfBirth) : null,
    exitDate: emp.exitDate ? ymdOf(emp.exitDate) : null,
    // Restricted fields are masked. Full values require the sensitive endpoint, which is audited.
    bankAccount: bankAccountLast4 ? `•••• ${bankAccountLast4}` : null,
    pan: panLast4 ? `•••••••${panLast4}` : null,
    bankName: emp.bankName,
    bankIfsc: emp.bankIfsc,
    account: user ? { role: user.role, isActive: user.isActive, lastLoginAt: user.lastLoginAt } : null,
    directReports: reports,
    currentSalary: salary
      ? {
          effectiveFrom: ymdOf(salary.effectiveFrom),
          basicPaise: salary.basicPaise,
          hraPaise: salary.hraPaise,
          conveyancePaise: salary.conveyancePaise,
          specialPaise: salary.specialPaise,
          otherAllowancePaise: salary.otherAllowancePaise,
          pfApplicable: salary.pfApplicable,
          esiApplicable: salary.esiApplicable,
          professionalTaxPaise: salary.professionalTaxPaise,
          monthlyTdsPaise: salary.monthlyTdsPaise,
        }
      : null,
  };
}

/** Full, decrypted restricted fields. HR and Super Admin only; every call is audited. */
export async function revealSensitive(auth: AuthContext, id: string, req?: Request) {
  const emp = await prisma.employee.findFirst({
    where: { id, organizationId: auth.organizationId },
    select: { id: true, bankAccountCipher: true, bankIfsc: true, bankName: true, panCipher: true },
  });
  if (!emp) throw AppError.notFound('Employee not found.');
  await writeAudit(auth, auth.organizationId, { action: 'employee.sensitive_viewed', entityType: 'Employee', entityId: id, summary: { fields: ['bankAccount', 'pan'] } }, req);
  return {
    bankAccount: emp.bankAccountCipher ? decryptField(emp.bankAccountCipher) : null,
    bankIfsc: emp.bankIfsc,
    bankName: emp.bankName,
    pan: emp.panCipher ? decryptField(emp.panCipher) : null,
  };
}

async function assertUniqueFields(
  orgId: string,
  values: { workEmail?: string; employeeCode?: string },
  excludeId?: string,
) {
  const or: Prisma.EmployeeWhereInput[] = [];
  if (values.workEmail) or.push({ workEmail: values.workEmail });
  if (values.employeeCode) or.push({ employeeCode: values.employeeCode });
  if (!or.length) return;
  const clash = await prisma.employee.findFirst({
    where: { organizationId: orgId, OR: or, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    select: { workEmail: true, employeeCode: true },
  });
  if (clash) {
    const details: { field: string; message: string }[] = [];
    if (clash.workEmail === values.workEmail) details.push({ field: 'workEmail', message: 'This work email is already used.' });
    if (clash.employeeCode === values.employeeCode) details.push({ field: 'employeeCode', message: 'This employee code is already used.' });
    throw AppError.conflict('Duplicate employee details found.', details);
  }
}

async function assertReferences(orgId: string, departmentId: string, designationId: string, managerId?: string | null) {
  const [dept, desig, mgr] = await Promise.all([
    prisma.department.findFirst({ where: { id: departmentId, organizationId: orgId } }),
    prisma.designation.findFirst({ where: { id: designationId, organizationId: orgId } }),
    managerId ? prisma.employee.findFirst({ where: { id: managerId, organizationId: orgId } }) : Promise.resolve(true),
  ]);
  const details: { field: string; message: string }[] = [];
  if (!dept) details.push({ field: 'departmentId', message: 'Choose a valid department.' });
  if (!desig) details.push({ field: 'designationId', message: 'Choose a valid designation.' });
  if (managerId && !mgr) details.push({ field: 'managerId', message: 'Choose a valid reporting manager.' });
  if (details.length) throw AppError.badRequest('Please correct the highlighted fields.', details);
}

async function nextEmployeeCode(orgId: string): Promise<string> {
  const rows = await prisma.employee.findMany({ where: { organizationId: orgId }, select: { employeeCode: true } });
  return nextEmployeeCodeFrom(rows.map((r) => r.employeeCode));
}

/** Sign-in emails are unique across the whole system, not only within an employee directory. */
async function assertLoginEmailFree(email: string, exceptUserId?: string) {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (user && user.id !== exceptUserId) {
    throw AppError.conflict('This email is already used by a sign-in account.', [{ field: 'workEmail', message: 'Already used by a sign-in account.' }]);
  }
}

/** Rejects a manager change that would make the reporting line loop back to this employee. */
async function assertNoReportingCycle(orgId: string, employeeId: string, managerId: string | null | undefined) {
  if (!managerId) return;
  if (managerId === employeeId) throw AppError.badRequest('An employee cannot report to themselves.', [{ field: 'managerId', message: 'Choose someone else.' }]);
  const rows = await prisma.employee.findMany({ where: { organizationId: orgId }, select: { id: true, managerId: true } });
  const managerOf = new Map(rows.map((r) => [r.id, r.managerId]));
  if (createsReportingCycle(employeeId, managerId, (id) => managerOf.get(id))) {
    throw AppError.badRequest('This manager already reports to this employee, directly or indirectly.', [
      { field: 'managerId', message: 'This would create a reporting loop.' },
    ]);
  }
}

export async function createEmployee(auth: AuthContext, input: S.CreateEmployeeInput, req?: Request) {
  const orgId = auth.organizationId;
  await assertReferences(orgId, input.departmentId, input.designationId, input.managerId);
  const employeeCode = input.employeeCode ?? (await nextEmployeeCode(orgId));
  await assertUniqueFields(orgId, { workEmail: input.workEmail, employeeCode });
  if (input.createAccount) await assertLoginEmailFree(input.workEmail);

  const { createAccount, accountRole, employeeCode: _ignored, ...fields } = input;
  const emp = await prisma.employee.create({
    data: {
      organizationId: orgId,
      employeeCode,
      firstName: fields.firstName,
      lastName: fields.lastName,
      workEmail: fields.workEmail,
      personalEmail: fields.personalEmail,
      phone: fields.phone,
      dateOfBirth: fields.dateOfBirth ? dateOnly(fields.dateOfBirth) : null,
      joiningDate: dateOnly(fields.joiningDate),
      employmentType: fields.employmentType,
      workLocation: fields.workLocation,
      departmentId: fields.departmentId,
      designationId: fields.designationId,
      managerId: fields.managerId ?? null,
      emergencyContactName: fields.emergencyContactName,
      emergencyContactPhone: fields.emergencyContactPhone,
      addressLine: fields.addressLine,
      city: fields.city,
      state: fields.state,
      postalCode: fields.postalCode,
      onboardingStatus: 'IN_PROGRESS',
    },
  });

  let invited = false;
  if (createAccount) {
    // Accounts start with an unusable random password. The employee sets their own via the reset link.
    const placeholder = await bcrypt.hash(randomToken().token, 12);
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email: emp.workEmail,
        name: `${emp.firstName} ${emp.lastName}`,
        passwordHash: placeholder,
        role: accountRole,
        employeeId: emp.id,
      },
    });
    const { token, hash } = randomToken();
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordResetTokenHash: hash, passwordResetExpiresAt: new Date(Date.now() + 72 * 3600_000) },
    });
    await sendMail({
      to: emp.workEmail,
      subject: 'Welcome to PeopleHub: set your password',
      text: `Set your password within 72 hours:\n${env.CLIENT_ORIGIN}/reset-password?token=${token}`,
    });
    invited = true;
  }

  await writeAudit(auth, orgId, {
    action: 'employee.created',
    entityType: 'Employee',
    entityId: emp.id,
    summary: { employeeCode, department: fields.departmentId, accountCreated: createAccount },
  }, req);
  return { id: emp.id, employeeCode, invited };
}

export async function updateEmployee(auth: AuthContext, id: string, input: S.UpdateEmployeeInput, req?: Request) {
  const existing = await prisma.employee.findFirst({ where: { id, organizationId: auth.organizationId }, include: { user: { select: { id: true } } } });
  if (!existing) throw AppError.notFound('Employee not found.');
  if (existing.status === 'EXITED' && input.status) {
    throw AppError.invalidState('Exited employees cannot be reactivated from this screen.');
  }
  if (input.departmentId || input.designationId || input.managerId !== undefined) {
    await assertReferences(
      auth.organizationId,
      input.departmentId ?? existing.departmentId,
      input.designationId ?? existing.designationId,
      input.managerId,
    );
  }
  await assertNoReportingCycle(auth.organizationId, id, input.managerId);
  const emailChanged = Boolean(input.workEmail && input.workEmail !== existing.workEmail);
  if (emailChanged) {
    await assertUniqueFields(auth.organizationId, { workEmail: input.workEmail }, id);
    if (existing.user) await assertLoginEmailFree(input.workEmail!, existing.user.id);
  }
  const joining = input.joiningDate ?? ymdOf(existing.joiningDate);
  if (existing.exitDate && ymdOf(existing.exitDate) < joining) {
    throw AppError.badRequest('The joining date must be before the exit date.', [{ field: 'joiningDate', message: 'Must be before the exit date.' }]);
  }

  // Prisma ignores undefined values, so only fields present in the request are written.
  const { dateOfBirth, joiningDate, ...scalars } = input;
  const data: Prisma.EmployeeUncheckedUpdateInput = {
    ...scalars,
    dateOfBirth: dateOfBirth ? dateOnly(dateOfBirth) : undefined,
    joiningDate: joiningDate ? dateOnly(joiningDate) : undefined,
  };

  const before = snapshotForAudit(existing);
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.employee.update({ where: { id }, data });
    // The sign-in email follows the work email, so the person keeps signing in with the address HR shows.
    if (emailChanged && existing.user) await tx.user.update({ where: { id: existing.user.id }, data: { email: row.workEmail } });
    if (input.firstName || input.lastName) {
      if (existing.user) await tx.user.update({ where: { id: existing.user.id }, data: { name: `${row.firstName} ${row.lastName}` } });
    }
    return row;
  });
  const changed = changedFields(before, snapshotForAudit(updated));
  if (changed.length) {
    await writeAudit(auth, auth.organizationId, { action: 'employee.updated', entityType: 'Employee', entityId: id, summary: { changedFields: changed } }, req);
  }
  return { id };
}

function snapshotForAudit(e: {
  firstName: string; lastName: string; workEmail: string; personalEmail: string | null; phone: string | null;
  joiningDate: Date; employmentType: string; workLocation: string; status: string; departmentId: string;
  designationId: string; managerId: string | null; onboardingStatus: string;
}) {
  return {
    firstName: e.firstName, lastName: e.lastName, workEmail: e.workEmail, personalEmail: e.personalEmail,
    phone: e.phone, joiningDate: ymdOf(e.joiningDate), employmentType: e.employmentType, workLocation: e.workLocation,
    status: e.status, departmentId: e.departmentId, designationId: e.designationId, managerId: e.managerId,
    onboardingStatus: e.onboardingStatus,
  };
}

export async function setBankDetails(auth: AuthContext, id: string, input: S.BankDetailsInput, req?: Request) {
  const emp = await prisma.employee.findFirst({ where: { id, organizationId: auth.organizationId } });
  if (!emp) throw AppError.notFound('Employee not found.');
  await prisma.employee.update({
    where: { id },
    data: {
      bankAccountCipher: encryptField(input.accountNumber),
      bankAccountLast4: last4(input.accountNumber),
      bankIfsc: input.ifsc,
      bankName: input.bankName,
      panCipher: encryptField(input.pan),
      panLast4: last4(input.pan),
    },
  });
  // Log which fields changed, never the values.
  await writeAudit(auth, auth.organizationId, { action: 'employee.bank_details_updated', entityType: 'Employee', entityId: id, summary: { fields: ['bankAccount', 'ifsc', 'bankName', 'pan'] } }, req);
  return { id };
}

export async function offboardEmployee(auth: AuthContext, id: string, input: { exitDate: string; reason: string }, req?: Request) {
  const emp = await prisma.employee.findFirst({ where: { id, organizationId: auth.organizationId }, include: { user: true } });
  if (!emp) throw AppError.notFound('Employee not found.');
  if (emp.status === 'EXITED') throw AppError.invalidState('This employee has already been offboarded.');
  if (auth.employeeId === id) throw AppError.forbidden('You cannot offboard yourself. Ask another HR administrator.');
  if (input.exitDate < ymdOf(emp.joiningDate)) {
    throw AppError.badRequest('The exit date cannot be before the joining date.', [{ field: 'exitDate', message: 'Must be on or after the joining date.' }]);
  }
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: auth.organizationId }, select: { timezone: true } });
  const status = exitStatusFor(input.exitDate, todayIn(org.timezone));
  await prisma.$transaction(async (tx) => {
    await tx.employee.update({
      where: { id },
      data: { status, exitDate: dateOnly(input.exitDate), ...(status === 'EXITED' ? { onboardingStatus: 'COMPLETE' } : {}) },
    });
    if (status === 'EXITED') await closeAccess(tx, id, emp.user?.id ?? null);
  });
  await writeAudit(auth, auth.organizationId, { action: 'employee.offboarded', entityType: 'Employee', entityId: id, summary: { exitDate: input.exitDate, reason: input.reason, status } }, req);
  return { id, status };
}

/** Deactivates sign-in, revokes sessions and releases direct reports once someone has left. */
async function closeAccess(tx: Prisma.TransactionClient, employeeId: string, userId: string | null) {
  if (userId) await tx.user.update({ where: { id: userId }, data: { isActive: false, tokenVersion: { increment: 1 } } });
  await tx.employee.updateMany({ where: { managerId: employeeId }, data: { managerId: null } });
}

/**
 * Moves employees on notice to EXITED once their exit date has passed. Runs at startup and every hour, and is
 * idempotent, so a missed run is caught up by the next one.
 */
export async function completeDueExits(now = new Date()): Promise<number> {
  const orgs = await prisma.organization.findMany({ select: { id: true, timezone: true } });
  let done = 0;
  for (const org of orgs) {
    const today = todayIn(org.timezone, now);
    const due = await prisma.employee.findMany({
      where: { organizationId: org.id, status: 'ON_NOTICE', exitDate: { lt: dateOnly(today) } },
      select: { id: true, user: { select: { id: true } } },
    });
    for (const e of due) {
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.employee.updateMany({ where: { id: e.id, status: 'ON_NOTICE' }, data: { status: 'EXITED', onboardingStatus: 'COMPLETE' } });
        if (claimed.count) await closeAccess(tx, e.id, e.user?.id ?? null);
      });
      await writeAudit(null, org.id, { action: 'employee.exit_completed', entityType: 'Employee', entityId: e.id });
      done++;
    }
  }
  return done;
}

export async function addSalaryAssignment(auth: AuthContext, id: string, input: S.SalaryInputDto, req?: Request) {
  const emp = await prisma.employee.findFirst({ where: { id, organizationId: auth.organizationId }, select: { id: true } });
  if (!emp) throw AppError.notFound('Employee not found.');
  const basicPaise = rupeesToPaise(input.basic);
  if (basicPaise <= 0) throw AppError.badRequest('Basic salary must be greater than zero.', [{ field: 'basic', message: 'Enter a basic salary.' }]);
  const existing = await prisma.salaryAssignment.findUnique({
    where: { employeeId_effectiveFrom: { employeeId: id, effectiveFrom: dateOnly(input.effectiveFrom) } },
  });
  if (existing) throw AppError.conflict('A salary is already effective from this date.', [{ field: 'effectiveFrom', message: 'Choose a different effective date.' }]);

  const row = await prisma.salaryAssignment.create({
    data: {
      organizationId: auth.organizationId,
      employeeId: id,
      effectiveFrom: dateOnly(input.effectiveFrom),
      basicPaise,
      hraPaise: rupeesToPaise(input.hra),
      conveyancePaise: rupeesToPaise(input.conveyance),
      specialPaise: rupeesToPaise(input.special),
      otherAllowancePaise: rupeesToPaise(input.otherAllowance),
      pfApplicable: input.pfApplicable,
      esiApplicable: input.esiApplicable,
      professionalTaxPaise: rupeesToPaise(input.professionalTax),
      monthlyTdsPaise: rupeesToPaise(input.monthlyTds),
      createdById: auth.userId,
    },
  });
  await writeAudit(auth, auth.organizationId, { action: 'salary.assigned', entityType: 'Employee', entityId: id, summary: { effectiveFrom: input.effectiveFrom, salaryAssignmentId: row.id } }, req);
  return { id: row.id };
}

export async function listSalaryHistory(auth: AuthContext, id: string) {
  const rows = await prisma.salaryAssignment.findMany({
    where: { employeeId: id, organizationId: auth.organizationId },
    orderBy: { effectiveFrom: 'desc' },
  });
  return rows.map((r) => ({
    id: r.id,
    effectiveFrom: ymdOf(r.effectiveFrom),
    basicPaise: r.basicPaise,
    hraPaise: r.hraPaise,
    conveyancePaise: r.conveyancePaise,
    specialPaise: r.specialPaise,
    otherAllowancePaise: r.otherAllowancePaise,
    pfApplicable: r.pfApplicable,
    esiApplicable: r.esiApplicable,
    professionalTaxPaise: r.professionalTaxPaise,
    monthlyTdsPaise: r.monthlyTdsPaise,
  }));
}

// -- Import ----------------------------------------------------------------------------------------------------

export interface ImportRowResult {
  row: number;
  valid: boolean;
  errors: { field: string; message: string }[];
  employeeCode?: string;
}

export async function importEmployees(auth: AuthContext, rows: unknown[], commit: boolean, req?: Request) {
  const orgId = auth.organizationId;
  const [departments, designations, existing] = await Promise.all([
    prisma.department.findMany({ where: { organizationId: orgId } }),
    prisma.designation.findMany({ where: { organizationId: orgId } }),
    prisma.employee.findMany({ where: { organizationId: orgId }, select: { workEmail: true, employeeCode: true } }),
  ]);
  const deptByName = new Map(departments.map((d) => [d.name.toLowerCase(), d]));
  const desigByTitle = new Map(designations.map((d) => [d.title.toLowerCase(), d]));
  const takenEmails = new Set(existing.map((e) => e.workEmail));
  const takenCodes = new Set(existing.map((e) => e.employeeCode));
  const seenInFile = { emails: new Set<string>(), codes: new Set<string>() };
  const managerEmails = new Set(existing.map((e) => e.workEmail));

  const results: ImportRowResult[] = [];
  const prepared: { data: S.ImportRowData; rowIndex: number }[] = [];

  rows.forEach((raw, index) => {
    const row = index + 1;
    const parsed = S.importRowSchema.safeParse(raw);
    if (!parsed.success) {
      results.push({ row, valid: false, errors: parsed.error.issues.map((i) => ({ field: String(i.path[0] ?? 'row'), message: i.message })) });
      return;
    }
    const data = parsed.data;
    const errors: { field: string; message: string }[] = [];
    const dept = deptByName.get(data.departmentName.toLowerCase());
    const desig = desigByTitle.get(data.designationTitle.toLowerCase());
    if (!dept) errors.push({ field: 'departmentName', message: `Department "${data.departmentName}" does not exist.` });
    if (!desig) errors.push({ field: 'designationTitle', message: `Designation "${data.designationTitle}" does not exist.` });
    if (takenEmails.has(data.workEmail) || seenInFile.emails.has(data.workEmail)) {
      errors.push({ field: 'workEmail', message: 'Duplicate work email (already exists or appears twice in this file).' });
    }
    if (data.employeeCode && (takenCodes.has(data.employeeCode) || seenInFile.codes.has(data.employeeCode))) {
      errors.push({ field: 'employeeCode', message: 'Duplicate employee code.' });
    }
    if (data.managerEmail && !managerEmails.has(data.managerEmail)) {
      errors.push({ field: 'managerEmail', message: 'Manager not found. Import managers first or leave blank.' });
    }
    seenInFile.emails.add(data.workEmail);
    if (data.employeeCode) seenInFile.codes.add(data.employeeCode);
    results.push({ row, valid: errors.length === 0, errors, employeeCode: data.employeeCode });
    if (errors.length === 0) {
      prepared.push({ data, rowIndex: index });
      managerEmails.add(data.workEmail);
    }
  });

  const summary = { total: rows.length, valid: results.filter((r) => r.valid).length, invalid: results.filter((r) => !r.valid).length };
  if (!commit) return { committed: false, summary, rows: results };
  if (summary.invalid > 0) {
    throw AppError.badRequest('Fix the rows with errors before importing. Nothing was imported.', { summary, rows: results });
  }

  let created = 0;
  await prisma.$transaction(async (tx) => {
    // Generated codes continue after the highest code in use, including codes given in this file.
    const codesInUse = new Set([...takenCodes, ...prepared.flatMap((p) => (p.data.employeeCode ? [p.data.employeeCode] : []))]);
    for (const { data } of prepared) {
      const employeeCode = data.employeeCode ?? nextEmployeeCodeFrom(codesInUse);
      codesInUse.add(employeeCode);
      await tx.employee.create({
        data: {
          organizationId: orgId,
          employeeCode,
          firstName: data.firstName,
          lastName: data.lastName,
          workEmail: data.workEmail,
          phone: data.phone || null,
          joiningDate: dateOnly(data.joiningDate),
          employmentType: data.employmentType,
          departmentId: deptByName.get(data.departmentName.toLowerCase())!.id,
          designationId: desigByTitle.get(data.designationTitle.toLowerCase())!.id,
          managerId: data.managerEmail ? (await tx.employee.findFirst({ where: { organizationId: orgId, workEmail: data.managerEmail }, select: { id: true } }))?.id ?? null : null,
        },
      });
      created += 1;
    }
  });
  await writeAudit(auth, orgId, { action: 'employee.imported', entityType: 'Employee', summary: { created } }, req);
  return { committed: true, summary: { ...summary, created }, rows: results };
}

export async function exportEmployeesCsv(auth: AuthContext, q: S.ListQuery, req?: Request): Promise<string> {
  const where: Prisma.EmployeeWhereInput = {
    AND: [teamScope(auth), ...(q.status ? [{ status: q.status }] : []), ...(q.departmentId ? [{ departmentId: q.departmentId }] : [])],
  };
  const rows = await prisma.employee.findMany({
    where,
    orderBy: { employeeCode: 'asc' },
    select: {
      employeeCode: true, firstName: true, lastName: true, workEmail: true, phone: true, status: true,
      employmentType: true, joiningDate: true, workLocation: true,
      department: { select: { name: true } }, designation: { select: { title: true } },
    },
  });
  await writeAudit(auth, auth.organizationId, { action: 'employee.exported', entityType: 'Employee', summary: { count: rows.length } }, req);
  // Bank and PAN are intentionally excluded from every export.
  const header = ['Employee Code', 'First Name', 'Last Name', 'Work Email', 'Phone', 'Status', 'Employment Type', 'Joining Date', 'Department', 'Designation', 'Location'];
  return toCsv(header, rows.map((r) => [r.employeeCode, r.firstName, r.lastName, r.workEmail, r.phone, r.status, r.employmentType, ymdOf(r.joiningDate), r.department.name, r.designation.title, r.workLocation]));
}
