import { db } from '../../db';
import type { PayrollEntry, PayrollRun, PayrollSnapshot } from '../../db/schema';
import type { Insert } from '../../db/table';
import { AppError, withChangesKept } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { csvRow } from '../../lib/csv';
import { monthRange } from '../../lib/time';
import { hrUserIds, notifyUsers, userIdForEmployee } from '../../lib/notify';
import type { AuthContext } from '../../security/session';
import { dailyStatusesFor } from '../attendance/attendance.service';
import { employeeScope, fullName, organizationOf } from '../employees/employees.service';
import { calculatePayroll, lossOfPayDays, type PayrollException, type PayrollRules, type SalaryInput } from './payroll.calc';

// ---------------------------------------------------------------------------------------------------------------
// Payroll workflow:  DRAFT --validate--> VALIDATED --approve--> APPROVED --finalize--> FINALIZED
//  - DRAFT: entries are (re)calculated from attendance, approved leave, salary and adjustments.
//  - VALIDATED: recalculated once more, then checked for blocking exceptions. Still editable by reopening.
//  - APPROVED: approver must differ from the creator (separation of duties).
//  - FINALIZED: immutable. Entries carry a snapshot of inputs and results. Payment is tracked separately.
// Loss of pay: each unpaid day counts (absent or unpaid leave = 1; half day = 0.5; not yet employed = 1).
// ---------------------------------------------------------------------------------------------------------------

function rulesFor(orgId: string): PayrollRules & { financialYearStartMonth: number } {
  const o = organizationOf({ organizationId: orgId });
  return {
    pfEmployeeRateBps: o.pfEmployeeRateBps,
    pfEmployerRateBps: o.pfEmployerRateBps,
    pfWageCeilingPaise: o.pfWageCeilingPaise,
    esiEmployeeRateBps: o.esiEmployeeRateBps,
    esiEmployerRateBps: o.esiEmployerRateBps,
    esiGrossCeilingPaise: o.esiGrossCeilingPaise,
    overtimeMultiplierBps: o.overtimeMultiplierBps,
    financialYearStartMonth: o.financialYearStartMonth,
  };
}

function assertPeriod(year: number, month: number) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw AppError.badRequest('Enter a valid year.');
  if (!Number.isInteger(month) || month < 1 || month > 12) throw AppError.badRequest('Enter a valid month (1-12).');
}

function loadRun(auth: AuthContext, id: string): PayrollRun {
  const run = db.payrollRuns.get(id);
  if (!run || run.organizationId !== auth.organizationId) throw AppError.notFound('Payroll run not found.');
  return run;
}

function requireStatus(run: { status: string }, allowed: string[], message: string) {
  if (!allowed.includes(run.status)) throw AppError.invalidState(message);
}

function runOf(organizationId: string, year: number, month: number): PayrollRun | undefined {
  return db.payrollRuns.find((r) => r.organizationId === organizationId && r.year === year && r.month === month);
}

/** Entries of a run, ordered by employee code. */
function entriesOf(runId: string): PayrollEntry[] {
  const code = (e: PayrollEntry) => db.employees.get(e.employeeId)?.employeeCode ?? '';
  return db.payrollEntries.by('payrollRunId', runId).sort((a, b) => code(a).localeCompare(code(b)));
}

const byPeriodDesc = (a: { year: number; month: number }, b: { year: number; month: number }) => b.year * 100 + b.month - (a.year * 100 + a.month);

export function listRuns(auth: AuthContext) {
  return db.payrollRuns
    .filter((r) => r.organizationId === auth.organizationId)
    .sort(byPeriodDesc)
    .slice(0, 60)
    .map((r) => ({
      id: r.id,
      year: r.year,
      month: r.month,
      status: r.status,
      employeeCount: db.payrollEntries.by('payrollRunId', r.id).length,
      totalGrossPaise: r.totalGrossPaise,
      totalDeductionsPaise: r.totalDeductionsPaise,
      totalNetPaise: r.totalNetPaise,
      totalEmployerPaise: r.totalEmployerPaise,
      finalizedAt: r.finalizedAt,
    }));
}

export function createRun(auth: AuthContext, year: number, month: number) {
  assertPeriod(year, month);
  const existing = runOf(auth.organizationId, year, month);
  if (existing) throw AppError.conflict('A payroll run already exists for this period.', { id: existing.id });
  const run = db.payrollRuns.insert({ organizationId: auth.organizationId, year, month, createdById: auth.userId });
  writeAudit(auth, auth.organizationId, { action: 'payroll.run_created', entityType: 'PayrollRun', entityId: run.id, summary: { year, month } });
  return { id: run.id, status: run.status };
}

export function getRun(auth: AuthContext, id: string) {
  const run = loadRun(auth, id);
  const entries = entriesOf(run.id);
  const exceptionCount = entries.reduce((n, e) => n + (e.snapshot.exceptions?.length ?? 0), 0);
  return {
    id: run.id,
    year: run.year,
    month: run.month,
    status: run.status,
    validatedAt: run.validatedAt,
    approvedAt: run.approvedAt,
    finalizedAt: run.finalizedAt,
    totals: {
      grossPaise: run.totalGrossPaise,
      deductionsPaise: run.totalDeductionsPaise,
      netPaise: run.totalNetPaise,
      employerPaise: run.totalEmployerPaise,
    },
    exceptionCount,
    entries: entries.map((e) => {
      const emp = db.employees.get(e.employeeId)!;
      return {
        id: e.id,
        employee: {
          id: e.employeeId,
          employeeCode: emp.employeeCode,
          name: fullName(emp),
          department: db.departments.get(emp.departmentId)?.name ?? '',
        },
        paidDays: e.paidDays,
        lopDays: e.lopDays,
        grossPaise: e.grossPaise,
        totalDeductionsPaise: e.totalDeductionsPaise,
        netPaise: e.netPaise,
        employerContribPaise: e.employerContribPaise,
        paymentStatus: e.paymentStatus,
        paymentReference: e.paymentReference,
        paidAt: e.paidAt,
        lines: e.snapshot.lines ?? null,
        exceptions: e.snapshot.exceptions ?? [],
      };
    }),
  };
}

/** Recalculates every entry of a DRAFT run from source data, replacing its earlier entries. */
function recalculate(auth: AuthContext, run: PayrollRun) {
  const rules = rulesFor(auth.organizationId);
  const { from, to } = monthRange(run.year, run.month);
  const daysInMonth = Number(to.slice(8, 10));

  const employees = db.employees.filter(
    (e) => e.organizationId === auth.organizationId && e.joiningDate <= to && (e.exitDate === null || e.exitDate >= from),
  );

  const entries: Insert<PayrollEntry, 'paymentStatus' | 'paidAt' | 'paymentReference'>[] = [];
  const missingSalary: string[] = [];

  for (const emp of employees) {
    const salary = db.salaryAssignments
      .by('employeeId', emp.id)
      .filter((s) => s.effectiveFrom <= to)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    if (!salary) {
      missingSalary.push(emp.employeeCode);
      continue;
    }
    const days = dailyStatusesFor(emp.id, from, to, auth.organizationId);
    const lop = lossOfPayDays(days);
    let overtimeMinutes = 0;
    const counts: Record<string, number> = {};
    for (const d of days) {
      counts[d.status] = (counts[d.status] ?? 0) + 1;
      // Only overtime a manager or HR approved is paid.
      overtimeMinutes += d.overtimeApprovedMinutes ?? 0;
    }

    const adjustments = db.payrollAdjustments
      .by('employeeId', emp.id)
      .filter((a) => a.year === run.year && a.month === run.month && a.organizationId === auth.organizationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((a) => ({ kind: a.kind, label: a.label, amountPaise: a.amountPaise }));

    const salaryInput: SalaryInput = {
      basicPaise: salary.basicPaise,
      hraPaise: salary.hraPaise,
      conveyancePaise: salary.conveyancePaise,
      specialPaise: salary.specialPaise,
      otherAllowancePaise: salary.otherAllowancePaise,
      pfApplicable: salary.pfApplicable,
      esiApplicable: salary.esiApplicable,
      professionalTaxPaise: salary.professionalTaxPaise,
      monthlyTdsPaise: salary.monthlyTdsPaise,
    };
    const result = calculatePayroll(salaryInput, { daysInMonth, lopDays: lop, overtimeMinutes }, adjustments, rules);

    const warnings: PayrollException[] = [...result.exceptions];
    if (salary.effectiveFrom > from) {
      warnings.push({ code: 'SALARY_REVISED', message: `Salary revision effective ${salary.effectiveFrom} falls within this month; verify proration.`, severity: 'warning' });
    }

    const snapshot: PayrollSnapshot = {
      version: 1,
      calculatedAt: new Date().toISOString(),
      period: { year: run.year, month: run.month, daysInMonth },
      rules: { ...rules },
      inputs: {
        salary: { ...salaryInput, effectiveFrom: salary.effectiveFrom },
        attendanceCounts: counts,
        overtimeMinutes,
        lopDays: lop,
        adjustments,
      },
      lines: { earnings: result.earnings, deductions: result.deductions, employerContributions: result.employerContributions },
      exceptions: warnings,
    };
    entries.push({
      organizationId: auth.organizationId,
      payrollRunId: run.id,
      employeeId: emp.id,
      paidDays: result.paidDays,
      lopDays: result.lopDays,
      grossPaise: result.grossPaise,
      totalDeductionsPaise: result.totalDeductionsPaise,
      netPaise: result.netPaise,
      employerContribPaise: result.employerContributionPaise,
      snapshot,
    });
  }

  db.payrollEntries.deleteWhere((e) => e.payrollRunId === run.id);
  for (const e of entries) db.payrollEntries.insert(e);
  const totals = entries.reduce(
    (t, e) => ({ gross: t.gross + e.grossPaise, ded: t.ded + e.totalDeductionsPaise, net: t.net + e.netPaise, employer: t.employer + e.employerContribPaise }),
    { gross: 0, ded: 0, net: 0, employer: 0 },
  );
  db.payrollRuns.update(run.id, {
    totalGrossPaise: totals.gross,
    totalDeductionsPaise: totals.ded,
    totalNetPaise: totals.net,
    totalEmployerPaise: totals.employer,
  });
  return { employeeCount: entries.length, missingSalary };
}

export function recalculateRun(auth: AuthContext, id: string) {
  const run = loadRun(auth, id);
  requireStatus(run, ['DRAFT'], 'Only draft runs can be recalculated. Reopen the run first if you need changes.');
  const result = recalculate(auth, run);
  writeAudit(auth, auth.organizationId, { action: 'payroll.recalculated', entityType: 'PayrollRun', entityId: id, summary: { employees: result.employeeCount } });
  return result;
}

export function validateRun(auth: AuthContext, id: string) {
  const run = loadRun(auth, id);
  requireStatus(run, ['DRAFT'], 'Only draft runs can be validated.');
  const result = recalculate(auth, run);

  const entries = db.payrollEntries.by('payrollRunId', id);
  const blocking: { employeeCode: string; message: string }[] = [];
  const warnings: { employeeCode: string; message: string }[] = [];
  for (const code of result.missingSalary) blocking.push({ employeeCode: code, message: 'No salary assignment effective for this period.' });
  for (const e of entries) {
    const employeeCode = db.employees.get(e.employeeId)!.employeeCode;
    for (const ex of e.snapshot.exceptions) (ex.severity === 'error' ? blocking : warnings).push({ employeeCode, message: ex.message });
  }
  if (blocking.length) {
    const first = blocking[0];
    // The recalculation above is kept (it only refreshes the draft); the status stays DRAFT.
    throw withChangesKept(
      AppError.invalidState(
        `Validation failed with ${blocking.length} blocking exception(s), for example ${first.employeeCode}: ${first.message} Fix them and validate again.`,
        { blocking },
      ),
    );
  }
  db.payrollRuns.update(id, { status: 'VALIDATED', validatedAt: new Date().toISOString() });
  writeAudit(auth, auth.organizationId, { action: 'payroll.validated', entityType: 'PayrollRun', entityId: id, summary: { employees: entries.length, warnings: warnings.length } });
  // Approvers other than the creator (separation of duties).
  const approvers = hrUserIds(auth.organizationId).filter((u) => u !== run.createdById);
  notifyUsers(auth.organizationId, approvers, {
    kind: 'payroll.validated',
    title: 'Payroll ready for approval',
    body: `Payroll for ${run.month}/${run.year} passed validation and needs an approver.`,
    link: `/payroll/${id}`,
  });
  return { status: 'VALIDATED', employeeCount: entries.length, warnings, missingSalary: result.missingSalary };
}

export function reopenRun(auth: AuthContext, id: string, reason: string) {
  const run = loadRun(auth, id);
  requireStatus(run, ['VALIDATED', 'APPROVED'], 'Only validated or approved runs can be reopened. Finalized payroll is immutable.');
  db.payrollRuns.update(id, { status: 'DRAFT', validatedAt: null, approvedAt: null, approvedById: null });
  writeAudit(auth, auth.organizationId, { action: 'payroll.reopened', entityType: 'PayrollRun', entityId: id, summary: { reason, from: run.status } });
  return { status: 'DRAFT' };
}

export function approveRun(auth: AuthContext, id: string) {
  const run = loadRun(auth, id);
  requireStatus(run, ['VALIDATED'], 'Only validated runs can be approved.');
  if (run.createdById === auth.userId) {
    throw AppError.forbidden('The person who created this payroll run cannot approve it.');
  }
  db.payrollRuns.update(id, { status: 'APPROVED', approvedById: auth.userId, approvedAt: new Date().toISOString() });
  writeAudit(auth, auth.organizationId, { action: 'payroll.approved', entityType: 'PayrollRun', entityId: id });
  return { status: 'APPROVED' };
}

export function finalizeRun(auth: AuthContext, id: string) {
  const run = loadRun(auth, id);
  requireStatus(run, ['APPROVED'], 'Only approved runs can be finalized.');
  if (run.createdById === auth.userId) throw AppError.forbidden('Separation of duties: the creator cannot finalize this run.');
  db.payrollRuns.update(id, { status: 'FINALIZED', finalizedById: auth.userId, finalizedAt: new Date().toISOString() });
  writeAudit(auth, auth.organizationId, { action: 'payroll.finalized', entityType: 'PayrollRun', entityId: id, summary: { year: run.year, month: run.month } });
  for (const e of db.payrollEntries.by('payrollRunId', id)) {
    notifyUsers(auth.organizationId, [userIdForEmployee(e.employeeId)], {
      kind: 'payroll.payslip_ready',
      title: 'Your payslip is ready',
      body: `Your payslip for ${run.month}/${run.year} is available. Payment status is shown on the payslip.`,
      link: `/payslips/${e.id}`,
    });
  }
  return { status: 'FINALIZED' };
}

export function markPayment(auth: AuthContext, entryId: string, reference: string) {
  const entry = db.payrollEntries.get(entryId);
  if (!entry || entry.organizationId !== auth.organizationId) throw AppError.notFound('Payslip not found.');
  if (db.payrollRuns.get(entry.payrollRunId)?.status !== 'FINALIZED') throw AppError.invalidState('Payment can be recorded only after the run is finalized.');
  if (entry.paymentStatus === 'PAID') throw AppError.conflict('This salary is already marked as paid.');
  db.payrollEntries.update(entryId, { paymentStatus: 'PAID', paidAt: new Date().toISOString(), paymentReference: reference });
  writeAudit(auth, auth.organizationId, {
    action: 'payroll.payment_recorded',
    entityType: 'PayrollEntry',
    entityId: entryId,
    summary: { employeeCode: db.employees.get(entry.employeeId)?.employeeCode, reference },
  });
  return { id: entryId, paymentStatus: 'PAID' };
}

/** Bank transfer file. Contains full account numbers, so the export is audited. */
export function bankExportCsv(auth: AuthContext, runId: string): string {
  const run = loadRun(auth, runId);
  requireStatus(run, ['FINALIZED'], 'Bank export is available only for finalized runs.');
  const entries = entriesOf(runId);
  writeAudit(auth, auth.organizationId, { action: 'payroll.bank_export', entityType: 'PayrollRun', entityId: runId, summary: { rows: entries.length } });
  const header = ['Employee Code', 'Beneficiary Name', 'Bank Name', 'Account Number', 'IFSC', 'Net Amount (INR)'];
  const lines = entries.map((e) => {
    const emp = db.employees.get(e.employeeId)!;
    return csvRow([emp.employeeCode, fullName(emp), emp.bankName, emp.bankAccountNumber ?? '', emp.bankIfsc, (e.netPaise / 100).toFixed(2)]);
  });
  return [csvRow(header), ...lines].join('\n');
}

// -- Adjustments -------------------------------------------------------------------------------------------------

export function addAdjustment(
  auth: AuthContext,
  input: { employeeId: string; year: number; month: number; kind: 'EARNING' | 'DEDUCTION'; label: string; amountPaise: number },
) {
  assertPeriod(input.year, input.month);
  const run = runOf(auth.organizationId, input.year, input.month);
  if (run && run.status !== 'DRAFT' && run.status !== 'VALIDATED') {
    throw AppError.invalidState('This period is approved or finalized. Adjustments for it are closed.');
  }
  const emp = db.employees.get(input.employeeId);
  if (!emp || emp.organizationId !== auth.organizationId) throw AppError.badRequest('Choose a valid employee.', [{ field: 'employeeId', message: 'Choose an employee.' }]);
  const row = db.payrollAdjustments.insert({ ...input, organizationId: auth.organizationId, createdById: auth.userId });
  if (run?.status === 'VALIDATED') {
    // Validation no longer reflects the data; send the run back to draft.
    db.payrollRuns.update(run.id, { status: 'DRAFT', validatedAt: null });
  }
  writeAudit(auth, auth.organizationId, {
    action: 'payroll.adjustment_added',
    entityType: 'PayrollAdjustment',
    entityId: row.id,
    summary: { kind: input.kind, amountPaise: input.amountPaise, period: `${input.year}-${input.month}` },
  });
  return { id: row.id };
}

export function listAdjustments(auth: AuthContext, year: number, month: number) {
  return db.payrollAdjustments
    .filter((r) => r.organizationId === auth.organizationId && r.year === year && r.month === month)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((r) => {
      const e = db.employees.get(r.employeeId)!;
      return {
        id: r.id,
        employee: { id: r.employeeId, employeeCode: e.employeeCode, name: fullName(e) },
        kind: r.kind,
        label: r.label,
        amountPaise: r.amountPaise,
        createdAt: r.createdAt,
      };
    });
}

// -- Payslips ----------------------------------------------------------------------------------------------------

/** Payslip for one finalized entry. Visible to the employee themself and to HR; a manager sees only their own. */
export function getPayslip(auth: AuthContext, entryId: string) {
  const entry = db.payrollEntries.get(entryId);
  const run = entry ? db.payrollRuns.get(entry.payrollRunId) : undefined;
  const emp = entry ? db.employees.get(entry.employeeId) : undefined;
  if (!entry || !run || !emp || entry.organizationId !== auth.organizationId || run.status !== 'FINALIZED' || !employeeScope(auth)(emp)) {
    throw AppError.notFound('Payslip not found.');
  }
  // Managers see their own payslips only; payslips of their team stay with HR.
  if (auth.role === 'MANAGER' && entry.employeeId !== auth.employeeId) throw AppError.notFound('Payslip not found.');
  if (auth.employeeId !== entry.employeeId) {
    writeAudit(auth, auth.organizationId, { action: 'payroll.payslip_viewed', entityType: 'PayrollEntry', entityId: entryId });
  }

  // Year-to-date figures within the financial year, using finalized runs only.
  const org = organizationOf(auth);
  const fyStart = org.financialYearStartMonth;
  const fyStartYear = run.month >= fyStart ? run.year : run.year - 1;
  const periodKey = (y: number, m: number) => y * 100 + m;
  const fyFrom = periodKey(fyStartYear, fyStart);
  const fyTo = periodKey(fyStartYear + 1, fyStart); // exclusive
  const viewed = periodKey(run.year, run.month);
  // Year to date = finalized periods inside this financial year, up to and including the viewed period.
  const ytd = db.payrollEntries
    .by('employeeId', entry.employeeId)
    .filter((e) => {
      const r = db.payrollRuns.get(e.payrollRunId);
      if (!r || r.status !== 'FINALIZED') return false;
      const key = periodKey(r.year, r.month);
      return key >= fyFrom && key < fyTo && key <= viewed;
    })
    .reduce((t, e) => ({ gross: t.gross + e.grossPaise, deductions: t.deductions + e.totalDeductionsPaise, net: t.net + e.netPaise }), { gross: 0, deductions: 0, net: 0 });

  return {
    id: entry.id,
    runId: entry.payrollRunId,
    organization: { name: org.name, legalName: org.legalName },
    period: { year: run.year, month: run.month },
    employee: {
      id: entry.employeeId,
      employeeCode: emp.employeeCode,
      name: fullName(emp),
      department: db.departments.get(emp.departmentId)?.name ?? '',
      designation: db.designations.get(emp.designationId)?.title ?? '',
      joiningDate: emp.joiningDate,
      bankAccount: emp.bankAccountLast4 ? `•••• ${emp.bankAccountLast4}` : null,
    },
    paidDays: entry.paidDays,
    lopDays: entry.lopDays,
    paymentStatus: entry.paymentStatus,
    paidAt: entry.paidAt,
    lines: entry.snapshot.lines,
    totals: {
      grossPaise: entry.grossPaise,
      deductionsPaise: entry.totalDeductionsPaise,
      netPaise: entry.netPaise,
      employerContribPaise: entry.employerContribPaise,
    },
    ytd: { fromMonth: fyStart, ...ytd },
    finalizedAt: run.finalizedAt,
  };
}

export function listMyPayslips(auth: AuthContext) {
  if (!auth.employeeId) return { items: [] };
  const items = db.payrollEntries
    .by('employeeId', auth.employeeId)
    .map((e) => ({ e, run: db.payrollRuns.get(e.payrollRunId)! }))
    .filter(({ run }) => run?.status === 'FINALIZED')
    .sort((a, b) => byPeriodDesc(a.run, b.run))
    .slice(0, 60)
    .map(({ e, run }) => ({
      id: e.id,
      period: { year: run.year, month: run.month },
      grossPaise: e.grossPaise,
      deductionsPaise: e.totalDeductionsPaise,
      netPaise: e.netPaise,
      paymentStatus: e.paymentStatus,
      paidAt: e.paidAt,
    }));
  return { items };
}

export function payrollSummaryReport(auth: AuthContext, year: number) {
  return db.payrollRuns
    .filter((r) => r.organizationId === auth.organizationId && r.year === year && r.status === 'FINALIZED')
    .sort((a, b) => a.month - b.month)
    .map((r) => ({
      month: r.month,
      employees: db.payrollEntries.by('payrollRunId', r.id).length,
      grossPaise: r.totalGrossPaise,
      deductionsPaise: r.totalDeductionsPaise,
      netPaise: r.totalNetPaise,
      employerPaise: r.totalEmployerPaise,
    }));
}

