import { db } from '../../db';
import type { Employee, Organization } from '../../db/schema';
import { AppError, UniqueConstraintError } from '../../lib/errors';
import { changedFields, writeAudit } from '../../lib/audit';
import { hashPassword, last4, randomToken } from '../../lib/crypto';
import { appLink, sendMail } from '../../lib/mailer';
import { rupeesToPaise } from '../../lib/money';
import { todayIn } from '../../lib/time';
import { toCsv } from '../../lib/csv';
import { hasPermission } from '../../security/permissions';
import type { AuthContext } from '../../security/session';
import { createsReportingCycle, exitStatusFor, nextEmployeeCodeFrom } from './employees.rules';
import * as S from './employees.schemas';

// ---------------------------------------------------------------------------------------------------------------
// Access scope. Enforced here in the API, never left to the screens:
//   HR_ADMIN / SUPER_ADMIN -> every employee in the organization
//   MANAGER                -> direct reports only
//   EMPLOYEE               -> own record only
// ---------------------------------------------------------------------------------------------------------------
// Two scopes:
//   employeeScope: whose records the caller may SEE, which always includes their own (a manager's own calendar,
//                  leave, payslips and profile).
//   teamScope:     whose requests the caller may DECIDE or list as their team: HR everyone, a manager their direct
//                  reports, an employee nobody. Deciding on your own request is refused separately.
export type EmployeeFilter = (e: Employee) => boolean;

export function employeeScope(auth: AuthContext): EmployeeFilter {
  const inOrg = (e: Employee) => e.organizationId === auth.organizationId;
  if (hasPermission(auth.role, 'employees:read') && auth.role !== 'MANAGER') return inOrg;
  if (auth.role === 'MANAGER' && auth.employeeId) return (e) => inOrg(e) && (e.managerId === auth.employeeId || e.id === auth.employeeId);
  if (auth.employeeId) return (e) => inOrg(e) && e.id === auth.employeeId;
  return () => false;
}

export function teamScope(auth: AuthContext): EmployeeFilter {
  const inOrg = (e: Employee) => e.organizationId === auth.organizationId;
  if (auth.role === 'HR_ADMIN' || auth.role === 'SUPER_ADMIN') return inOrg;
  if (auth.role === 'MANAGER' && auth.employeeId) return (e) => inOrg(e) && e.managerId === auth.employeeId;
  return () => false;
}

/** True when the employee with this id passes the scope filter. */
export function inScope(scope: EmployeeFilter, employeeId: string | null | undefined): boolean {
  const e = db.employees.get(employeeId);
  return Boolean(e && scope(e));
}

export function fullName(e: Pick<Employee, 'firstName' | 'lastName'>): string {
  return `${e.firstName} ${e.lastName}`;
}

export function organizationOf(auth: Pick<AuthContext, 'organizationId'>): Organization {
  const org = db.organizations.get(auth.organizationId);
  if (!org) throw AppError.notFound('Organization not found.');
  return org;
}

function toSummary(e: Employee) {
  const department = db.departments.get(e.departmentId)!;
  const designation = db.designations.get(e.designationId)!;
  const manager = db.employees.get(e.managerId);
  return {
    id: e.id,
    employeeCode: e.employeeCode,
    firstName: e.firstName,
    lastName: e.lastName,
    workEmail: e.workEmail,
    phone: e.phone,
    photoUrl: e.photoUrl,
    status: e.status,
    employmentType: e.employmentType,
    onboardingStatus: e.onboardingStatus,
    joiningDate: e.joiningDate,
    workLocation: e.workLocation,
    department: { id: department.id, name: department.name },
    designation: { id: designation.id, title: designation.title },
    name: fullName(e),
    manager: manager ? { id: manager.id, name: fullName(manager) } : null,
  };
}

const compareText = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' });

export function listEmployees(auth: AuthContext, q: S.ListQuery) {
  // The directory lists the team: everyone for HR, direct reports for a manager.
  const scope = teamScope(auth);
  const needle = q.q?.toLowerCase();
  const rows = db.employees.filter((e) => {
    if (!scope(e)) return false;
    if (needle && ![e.firstName, e.lastName, e.employeeCode, e.workEmail].some((v) => v.toLowerCase().includes(needle))) return false;
    if (q.departmentId && e.departmentId !== q.departmentId) return false;
    if (q.status && e.status !== q.status) return false;
    if (q.employmentType && e.employmentType !== q.employmentType) return false;
    return true;
  });

  const dir = q.dir === 'desc' ? -1 : 1;
  const deptName = (e: Employee) => db.departments.get(e.departmentId)?.name ?? '';
  rows.sort((a, b) => {
    switch (q.sort) {
      case 'code':
        return dir * compareText(a.employeeCode, b.employeeCode);
      case 'joiningDate':
        return dir * a.joiningDate.localeCompare(b.joiningDate);
      case 'department':
        return dir * compareText(deptName(a), deptName(b)) || compareText(a.firstName, b.firstName);
      default:
        return dir * (compareText(a.firstName, b.firstName) || compareText(a.lastName, b.lastName));
    }
  });

  const total = rows.length;
  const start = (q.page - 1) * q.pageSize;
  return {
    items: rows.slice(start, start + q.pageSize).map(toSummary),
    page: q.page,
    pageSize: q.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
  };
}

/** The salary in effect today; a revision dated in the future is not "current" yet (it shows in the history). */
function currentSalaryOf(employeeId: string, today: string) {
  const all = db.salaryAssignments.by('employeeId', employeeId).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return all.filter((s) => s.effectiveFrom <= today).at(-1) ?? all[0] ?? null;
}

export function getEmployee(auth: AuthContext, id: string) {
  const emp = db.employees.get(id);
  if (!emp || !employeeScope(auth)(emp)) throw AppError.notFound('Employee not found.');

  const canSeePay = hasPermission(auth.role, 'payroll:read');
  const salary = canSeePay ? currentSalaryOf(id, todayIn(organizationOf(auth).timezone)) : null;
  const user = db.users.find((u) => u.employeeId === id);
  const reports = db.employees
    .by('managerId', id)
    .filter((r) => r.status === 'ACTIVE')
    .map((r) => ({ id: r.id, firstName: r.firstName, lastName: r.lastName, employeeCode: r.employeeCode }));

  return {
    ...toSummary(emp),
    personalEmail: emp.personalEmail,
    dateOfBirth: emp.dateOfBirth,
    exitDate: emp.exitDate,
    emergencyContactName: emp.emergencyContactName,
    emergencyContactPhone: emp.emergencyContactPhone,
    addressLine: emp.addressLine,
    city: emp.city,
    state: emp.state,
    postalCode: emp.postalCode,
    // Restricted fields are masked. Full values require the sensitive endpoint, which is audited.
    bankAccount: emp.bankAccountLast4 ? `•••• ${emp.bankAccountLast4}` : null,
    pan: emp.panLast4 ? `•••••••${emp.panLast4}` : null,
    bankName: emp.bankName,
    bankIfsc: emp.bankIfsc,
    account: user ? { role: user.role, isActive: user.isActive, lastLoginAt: user.lastLoginAt } : null,
    directReports: reports,
    currentSalary: salary
      ? {
          effectiveFrom: salary.effectiveFrom,
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

function employeeInOrg(auth: AuthContext, id: string): Employee {
  const emp = db.employees.get(id);
  if (!emp || emp.organizationId !== auth.organizationId) throw AppError.notFound('Employee not found.');
  return emp;
}

/** Full restricted fields. HR and Super Admin only; every call is audited. */
export function revealSensitive(auth: AuthContext, id: string) {
  const emp = employeeInOrg(auth, id);
  writeAudit(auth, auth.organizationId, { action: 'employee.sensitive_viewed', entityType: 'Employee', entityId: id, summary: { fields: ['bankAccount', 'pan'] } });
  return {
    bankAccount: emp.bankAccountNumber,
    bankIfsc: emp.bankIfsc,
    bankName: emp.bankName,
    pan: emp.panNumber,
  };
}

function assertUniqueFields(orgId: string, values: { workEmail?: string; employeeCode?: string }, excludeId?: string) {
  if (!values.workEmail && !values.employeeCode) return;
  const clash = db.employees.find(
    (e) =>
      e.organizationId === orgId &&
      e.id !== excludeId &&
      ((values.workEmail !== undefined && e.workEmail === values.workEmail) || (values.employeeCode !== undefined && e.employeeCode === values.employeeCode)),
  );
  if (clash) {
    const details: { field: string; message: string }[] = [];
    if (clash.workEmail === values.workEmail) details.push({ field: 'workEmail', message: 'This work email is already used.' });
    if (clash.employeeCode === values.employeeCode) details.push({ field: 'employeeCode', message: 'This employee code is already used.' });
    throw AppError.conflict('Duplicate employee details found.', details);
  }
}

function assertReferences(orgId: string, departmentId: string, designationId: string, managerId?: string | null) {
  const dept = db.departments.get(departmentId);
  const desig = db.designations.get(designationId);
  const mgr = managerId ? db.employees.get(managerId) : undefined;
  const details: { field: string; message: string }[] = [];
  if (dept?.organizationId !== orgId) details.push({ field: 'departmentId', message: 'Choose a valid department.' });
  if (desig?.organizationId !== orgId) details.push({ field: 'designationId', message: 'Choose a valid designation.' });
  if (managerId && mgr?.organizationId !== orgId) details.push({ field: 'managerId', message: 'Choose a valid reporting manager.' });
  if (details.length) throw AppError.badRequest('Please correct the highlighted fields.', details);
}

function nextEmployeeCode(orgId: string): string {
  return nextEmployeeCodeFrom(db.employees.filter((e) => e.organizationId === orgId).map((e) => e.employeeCode));
}

/** Sign-in emails are unique across the whole system, not only within an employee directory. */
function assertLoginEmailFree(email: string, exceptUserId?: string) {
  const user = db.users.find((u) => u.email === email);
  if (user && user.id !== exceptUserId) {
    throw AppError.conflict('This email is already used by a sign-in account.', [{ field: 'workEmail', message: 'Already used by a sign-in account.' }]);
  }
}

/** Rejects a manager change that would make the reporting line loop back to this employee. */
function assertNoReportingCycle(orgId: string, employeeId: string, managerId: string | null | undefined) {
  if (!managerId) return;
  if (managerId === employeeId) throw AppError.badRequest('An employee cannot report to themselves.', [{ field: 'managerId', message: 'Choose someone else.' }]);
  const managerOf = new Map(db.employees.filter((e) => e.organizationId === orgId).map((e) => [e.id, e.managerId]));
  if (createsReportingCycle(employeeId, managerId, (id) => managerOf.get(id))) {
    throw AppError.badRequest('This manager already reports to this employee, directly or indirectly.', [
      { field: 'managerId', message: 'This would create a reporting loop.' },
    ]);
  }
}

export function createEmployee(auth: AuthContext, input: S.CreateEmployeeInput) {
  const orgId = auth.organizationId;
  assertReferences(orgId, input.departmentId, input.designationId, input.managerId);
  const employeeCode = input.employeeCode ?? nextEmployeeCode(orgId);
  assertUniqueFields(orgId, { workEmail: input.workEmail, employeeCode });
  if (input.createAccount) assertLoginEmailFree(input.workEmail);

  const emp = db.employees.insert({
    organizationId: orgId,
    employeeCode,
    firstName: input.firstName,
    lastName: input.lastName,
    workEmail: input.workEmail,
    personalEmail: input.personalEmail ?? null,
    phone: input.phone ?? null,
    dateOfBirth: input.dateOfBirth ?? null,
    joiningDate: input.joiningDate,
    employmentType: input.employmentType,
    workLocation: input.workLocation,
    departmentId: input.departmentId,
    designationId: input.designationId,
    managerId: input.managerId ?? null,
    emergencyContactName: input.emergencyContactName ?? null,
    emergencyContactPhone: input.emergencyContactPhone ?? null,
    addressLine: input.addressLine ?? null,
    city: input.city ?? null,
    state: input.state ?? null,
    postalCode: input.postalCode ?? null,
    onboardingStatus: 'IN_PROGRESS',
  });

  let invited = false;
  if (input.createAccount) {
    // Accounts start with an unusable random password. The employee sets their own via the reset link.
    const { token, hash } = randomToken();
    db.users.insert({
      organizationId: orgId,
      email: emp.workEmail,
      name: fullName(emp),
      passwordHash: hashPassword(randomToken().token),
      role: input.accountRole,
      employeeId: emp.id,
      passwordResetTokenHash: hash,
      passwordResetExpiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
    });
    sendMail({
      to: emp.workEmail,
      subject: 'Welcome to PeopleHub: set your password',
      text: `Set your password within 72 hours:\n${appLink(`/reset-password?token=${token}`)}`,
    });
    invited = true;
  }

  writeAudit(auth, orgId, {
    action: 'employee.created',
    entityType: 'Employee',
    entityId: emp.id,
    summary: { employeeCode, department: input.departmentId, accountCreated: input.createAccount },
  });
  return { id: emp.id, employeeCode, invited };
}

export function updateEmployee(auth: AuthContext, id: string, input: S.UpdateEmployeeInput) {
  const existing = employeeInOrg(auth, id);
  const user = db.users.find((u) => u.employeeId === id);
  if (existing.status === 'EXITED' && input.status) {
    throw AppError.invalidState('Exited employees cannot be reactivated from this screen.');
  }
  if (input.departmentId || input.designationId || input.managerId !== undefined) {
    assertReferences(auth.organizationId, input.departmentId ?? existing.departmentId, input.designationId ?? existing.designationId, input.managerId);
  }
  assertNoReportingCycle(auth.organizationId, id, input.managerId);
  const emailChanged = Boolean(input.workEmail && input.workEmail !== existing.workEmail);
  if (emailChanged) {
    assertUniqueFields(auth.organizationId, { workEmail: input.workEmail }, id);
    if (user) assertLoginEmailFree(input.workEmail!, user.id);
  }
  const joining = input.joiningDate ?? existing.joiningDate;
  if (existing.exitDate && existing.exitDate < joining) {
    throw AppError.badRequest('The joining date must be before the exit date.', [{ field: 'joiningDate', message: 'Must be before the exit date.' }]);
  }

  // Only fields present in the request are written (an omitted or blank optional field keeps its value).
  const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<Employee>;
  const updated = db.employees.update(id, patch);
  // The sign-in email follows the work email, so the person keeps signing in with the address HR shows.
  if (user && (emailChanged || input.firstName || input.lastName)) {
    db.users.update(user.id, { email: updated.workEmail, name: fullName(updated) });
  }
  const changed = changedFields(snapshotForAudit(existing), snapshotForAudit(updated));
  if (changed.length) {
    writeAudit(auth, auth.organizationId, { action: 'employee.updated', entityType: 'Employee', entityId: id, summary: { changedFields: changed } });
  }
  return { id };
}

function snapshotForAudit(e: Employee) {
  return {
    firstName: e.firstName, lastName: e.lastName, workEmail: e.workEmail, personalEmail: e.personalEmail,
    phone: e.phone, joiningDate: e.joiningDate, employmentType: e.employmentType, workLocation: e.workLocation,
    status: e.status, departmentId: e.departmentId, designationId: e.designationId, managerId: e.managerId,
    onboardingStatus: e.onboardingStatus,
  };
}

export function setBankDetails(auth: AuthContext, id: string, input: S.BankDetailsInput) {
  employeeInOrg(auth, id);
  db.employees.update(id, {
    bankAccountNumber: input.accountNumber,
    bankAccountLast4: last4(input.accountNumber),
    bankIfsc: input.ifsc,
    bankName: input.bankName,
    panNumber: input.pan,
    panLast4: last4(input.pan),
  });
  // Log which fields changed, never the values.
  writeAudit(auth, auth.organizationId, { action: 'employee.bank_details_updated', entityType: 'Employee', entityId: id, summary: { fields: ['bankAccount', 'ifsc', 'bankName', 'pan'] } });
  return { id };
}

export function offboardEmployee(auth: AuthContext, id: string, input: { exitDate: string; reason: string }) {
  const emp = employeeInOrg(auth, id);
  if (emp.status === 'EXITED') throw AppError.invalidState('This employee has already been offboarded.');
  if (auth.employeeId === id) throw AppError.forbidden('You cannot offboard yourself. Ask another HR administrator.');
  if (input.exitDate < emp.joiningDate) {
    throw AppError.badRequest('The exit date cannot be before the joining date.', [{ field: 'exitDate', message: 'Must be on or after the joining date.' }]);
  }
  const status = exitStatusFor(input.exitDate, todayIn(organizationOf(auth).timezone));
  db.employees.update(id, { status, exitDate: input.exitDate, ...(status === 'EXITED' ? { onboardingStatus: 'COMPLETE' as const } : {}) });
  if (status === 'EXITED') closeAccess(id);
  writeAudit(auth, auth.organizationId, { action: 'employee.offboarded', entityType: 'Employee', entityId: id, summary: { exitDate: input.exitDate, reason: input.reason, status } });
  return { id, status };
}

/** Deactivates sign-in, revokes sessions and releases direct reports once someone has left. */
function closeAccess(employeeId: string) {
  const user = db.users.find((u) => u.employeeId === employeeId);
  if (user) db.users.update(user.id, { isActive: false, tokenVersion: user.tokenVersion + 1 });
  db.employees.updateWhere((e) => e.managerId === employeeId, { managerId: null });
}

/**
 * Moves employees on notice to EXITED once their exit date has passed. Runs when the app starts and then hourly,
 * and is idempotent, so a missed run is caught up by the next one.
 */
export function completeDueExits(now = new Date()): number {
  let done = 0;
  for (const org of db.organizations.all()) {
    const today = todayIn(org.timezone, now);
    const due = db.employees.filter((e) => e.organizationId === org.id && e.status === 'ON_NOTICE' && e.exitDate !== null && e.exitDate < today);
    for (const e of due) {
      db.employees.update(e.id, { status: 'EXITED', onboardingStatus: 'COMPLETE' });
      closeAccess(e.id);
      writeAudit(null, org.id, { action: 'employee.exit_completed', entityType: 'Employee', entityId: e.id });
      done++;
    }
  }
  return done;
}

export function addSalaryAssignment(auth: AuthContext, id: string, input: S.SalaryInputDto) {
  employeeInOrg(auth, id);
  const basicPaise = rupeesToPaise(input.basic);
  if (basicPaise <= 0) throw AppError.badRequest('Basic salary must be greater than zero.', [{ field: 'basic', message: 'Enter a basic salary.' }]);
  try {
    const row = db.salaryAssignments.insert({
      organizationId: auth.organizationId,
      employeeId: id,
      effectiveFrom: input.effectiveFrom,
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
    });
    writeAudit(auth, auth.organizationId, { action: 'salary.assigned', entityType: 'Employee', entityId: id, summary: { effectiveFrom: input.effectiveFrom, salaryAssignmentId: row.id } });
    return { id: row.id };
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      throw AppError.conflict('A salary is already effective from this date.', [{ field: 'effectiveFrom', message: 'Choose a different effective date.' }]);
    }
    throw err;
  }
}

export function listSalaryHistory(auth: AuthContext, id: string) {
  return db.salaryAssignments
    .by('employeeId', id)
    .filter((r) => r.organizationId === auth.organizationId)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
    .map((r) => ({
      id: r.id,
      effectiveFrom: r.effectiveFrom,
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

export function importEmployees(auth: AuthContext, rows: unknown[], commit: boolean) {
  const orgId = auth.organizationId;
  const departments = db.departments.filter((d) => d.organizationId === orgId);
  const designations = db.designations.filter((d) => d.organizationId === orgId);
  const existing = db.employees.filter((e) => e.organizationId === orgId);
  const deptByName = new Map(departments.map((d) => [d.name.toLowerCase(), d]));
  const desigByTitle = new Map(designations.map((d) => [d.title.toLowerCase(), d]));
  const takenEmails = new Set(existing.map((e) => e.workEmail));
  const takenCodes = new Set(existing.map((e) => e.employeeCode));
  const seenInFile = { emails: new Set<string>(), codes: new Set<string>() };
  const managerEmails = new Set(existing.map((e) => e.workEmail));

  const results: ImportRowResult[] = [];
  const prepared: S.ImportRowData[] = [];

  rows.forEach((raw, index) => {
    const row = index + 1;
    const parsed = S.importRowSchema.safeParse(raw);
    if (!parsed.success) {
      results.push({ row, valid: false, errors: parsed.error.issues.map((i) => ({ field: String(i.path[0] ?? 'row'), message: i.message })) });
      return;
    }
    const data = parsed.data;
    const errors: { field: string; message: string }[] = [];
    if (!deptByName.has(data.departmentName.toLowerCase())) errors.push({ field: 'departmentName', message: `Department "${data.departmentName}" does not exist.` });
    if (!desigByTitle.has(data.designationTitle.toLowerCase())) errors.push({ field: 'designationTitle', message: `Designation "${data.designationTitle}" does not exist.` });
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
      prepared.push(data);
      managerEmails.add(data.workEmail);
    }
  });

  const summary = { total: rows.length, valid: results.filter((r) => r.valid).length, invalid: results.filter((r) => !r.valid).length };
  if (!commit) return { committed: false, summary, rows: results };
  if (summary.invalid > 0) {
    throw AppError.badRequest('Fix the rows with errors before importing. Nothing was imported.', { summary, rows: results });
  }

  // Generated codes continue after the highest code in use, including codes given in this file.
  const codesInUse = new Set([...takenCodes, ...prepared.flatMap((p) => (p.employeeCode ? [p.employeeCode] : []))]);
  let created = 0;
  for (const data of prepared) {
    const employeeCode = data.employeeCode ?? nextEmployeeCodeFrom(codesInUse);
    codesInUse.add(employeeCode);
    const manager = data.managerEmail ? db.employees.find((e) => e.organizationId === orgId && e.workEmail === data.managerEmail) : undefined;
    db.employees.insert({
      organizationId: orgId,
      employeeCode,
      firstName: data.firstName,
      lastName: data.lastName,
      workEmail: data.workEmail,
      phone: data.phone || null,
      joiningDate: data.joiningDate,
      employmentType: data.employmentType,
      departmentId: deptByName.get(data.departmentName.toLowerCase())!.id,
      designationId: desigByTitle.get(data.designationTitle.toLowerCase())!.id,
      managerId: manager?.id ?? null,
    });
    created += 1;
  }
  writeAudit(auth, orgId, { action: 'employee.imported', entityType: 'Employee', summary: { created } });
  return { committed: true, summary: { ...summary, created }, rows: results };
}

export function exportEmployeesCsv(auth: AuthContext, q: S.ListQuery): string {
  const scope = teamScope(auth);
  const rows = db.employees
    .filter((e) => scope(e) && (!q.status || e.status === q.status) && (!q.departmentId || e.departmentId === q.departmentId))
    .sort((a, b) => a.employeeCode.localeCompare(b.employeeCode));
  writeAudit(auth, auth.organizationId, { action: 'employee.exported', entityType: 'Employee', summary: { count: rows.length } });
  // Bank and PAN are intentionally excluded from every export.
  const header = ['Employee Code', 'First Name', 'Last Name', 'Work Email', 'Phone', 'Status', 'Employment Type', 'Joining Date', 'Department', 'Designation', 'Location'];
  return toCsv(
    header,
    rows.map((r) => [
      r.employeeCode, r.firstName, r.lastName, r.workEmail, r.phone, r.status, r.employmentType, r.joiningDate,
      db.departments.get(r.departmentId)?.name, db.designations.get(r.designationId)?.title, r.workLocation,
    ]),
  );
}
