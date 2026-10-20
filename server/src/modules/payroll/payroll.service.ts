import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { decryptField } from '../../lib/crypto';
import { csvRow } from '../../lib/csv';
import type { AuthContext } from '../../middleware/auth';
import { dateOnly, monthRange, ymdOf } from '../../lib/time';
import { dailyStatusesFor } from '../attendance/attendance.service';
import { employeeScope } from '../employees/employees.service';
import { calculatePayroll, lossOfPayDays, type PayrollException, type PayrollRules, type SalaryInput } from './payroll.calc';
import { hrUserIds, notifyUsers } from '../../lib/notify';

// ---------------------------------------------------------------------------------------------------------------
// Payroll workflow:  DRAFT --validate--> VALIDATED --approve--> APPROVED --finalize--> FINALIZED
//  - DRAFT: entries are (re)calculated from attendance, approved leave, salary and adjustments.
//  - VALIDATED: recalculated once more, then checked for blocking exceptions. Still editable by reopening.
//  - APPROVED: approver must differ from the creator (separation of duties).
//  - FINALIZED: immutable. Entries carry a snapshot of inputs and results. Payment is tracked separately.
// Loss of pay: each unpaid day counts (absent or unpaid leave = 1; half day = 0.5; not yet employed = 1).
// ---------------------------------------------------------------------------------------------------------------

async function rulesFor(orgId: string): Promise<PayrollRules & { financialYearStartMonth: number }> {
  const o = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
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

async function loadRun(auth: AuthContext, id: string) {
  const run = await prisma.payrollRun.findFirst({ where: { id, organizationId: auth.organizationId } });
  if (!run) throw AppError.notFound('Payroll run not found.');
  return run;
}

function requireStatus(run: { status: string }, allowed: string[], message: string) {
  if (!allowed.includes(run.status)) throw AppError.invalidState(message);
}

export async function listRuns(auth: AuthContext) {
  const runs = await prisma.payrollRun.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
    take: 60,
    include: { _count: { select: { entries: true } } },
  });
  return runs.map((r) => ({
    id: r.id,
    year: r.year,
    month: r.month,
    status: r.status,
    employeeCount: r._count.entries,
    totalGrossPaise: r.totalGrossPaise,
    totalDeductionsPaise: r.totalDeductionsPaise,
    totalNetPaise: r.totalNetPaise,
    totalEmployerPaise: r.totalEmployerPaise,
    finalizedAt: r.finalizedAt?.toISOString() ?? null,
  }));
}

export async function createRun(auth: AuthContext, year: number, month: number, req?: Request) {
  assertPeriod(year, month);
  const existing = await prisma.payrollRun.findUnique({
    where: { organizationId_year_month: { organizationId: auth.organizationId, year, month } },
  });
  if (existing) throw AppError.conflict('A payroll run already exists for this period.', { id: existing.id });
  const run = await prisma.payrollRun.create({
    data: { organizationId: auth.organizationId, year, month, createdById: auth.userId },
  });
  await writeAudit(auth, auth.organizationId, { action: 'payroll.run_created', entityType: 'PayrollRun', entityId: run.id, summary: { year, month } }, req);
  return { id: run.id, status: run.status };
}

export async function getRun(auth: AuthContext, id: string) {
  const run = await prisma.payrollRun.findFirst({
    where: { id, organizationId: auth.organizationId },
    include: {
      entries: {
        orderBy: { employee: { employeeCode: 'asc' } },
        include: { employee: { select: { employeeCode: true, firstName: true, lastName: true, department: { select: { name: true } } } } },
      },
    },
  });
  if (!run) throw AppError.notFound('Payroll run not found.');
  const exceptionCount = run.entries.reduce((n, e) => n + ((e.snapshot as { exceptions?: unknown[] })?.exceptions?.length ?? 0), 0);
  return {
    id: run.id,
    year: run.year,
    month: run.month,
    status: run.status,
    validatedAt: run.validatedAt?.toISOString() ?? null,
    approvedAt: run.approvedAt?.toISOString() ?? null,
    finalizedAt: run.finalizedAt?.toISOString() ?? null,
    totals: {
      grossPaise: run.totalGrossPaise,
      deductionsPaise: run.totalDeductionsPaise,
      netPaise: run.totalNetPaise,
      employerPaise: run.totalEmployerPaise,
    },
    exceptionCount,
    entries: run.entries.map((e) => ({
      id: e.id,
      employee: {
        id: e.employeeId,
        employeeCode: e.employee.employeeCode,
        name: `${e.employee.firstName} ${e.employee.lastName}`,
        department: e.employee.department.name,
      },
      paidDays: Number(e.paidDays),
      lopDays: Number(e.lopDays),
      grossPaise: e.grossPaise,
      totalDeductionsPaise: e.totalDeductionsPaise,
      netPaise: e.netPaise,
      employerContribPaise: e.employerContribPaise,
      paymentStatus: e.paymentStatus,
      paymentReference: e.paymentReference,
      paidAt: e.paidAt?.toISOString() ?? null,
      lines: (e.snapshot as { lines?: unknown }).lines ?? null,
      exceptions: (e.snapshot as { exceptions?: PayrollException[] }).exceptions ?? [],
    })),
  };
}

/** Recalculates every entry of a DRAFT run from source data. Replaces prior DRAFT entries atomically. */
async function recalculate(auth: AuthContext, run: { id: string; year: number; month: number }) {
  const rules = await rulesFor(auth.organizationId);
  const { from, to } = monthRange(run.year, run.month);
  const periodStart = dateOnly(from);
  const periodEnd = dateOnly(to);
  const daysInMonth = Number(to.slice(8, 10));

  const employees = await prisma.employee.findMany({
    where: {
      organizationId: auth.organizationId,
      joiningDate: { lte: periodEnd },
      OR: [{ exitDate: null }, { exitDate: { gte: periodStart } }],
    },
    select: { id: true, employeeCode: true, firstName: true, lastName: true, joiningDate: true, exitDate: true },
  });

  const entries: Prisma.PayrollEntryCreateManyInput[] = [];
  const missingSalary: string[] = [];

  for (const emp of employees) {
    const salary = await prisma.salaryAssignment.findFirst({
      where: { employeeId: emp.id, effectiveFrom: { lte: periodEnd } },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (!salary) {
      missingSalary.push(emp.employeeCode);
      continue;
    }
    const days = await dailyStatusesFor(emp.id, from, to, auth.organizationId);
    const lop = lossOfPayDays(days);
    let overtimeMinutes = 0;
    const counts: Record<string, number> = {};
    for (const d of days) {
      counts[d.status] = (counts[d.status] ?? 0) + 1;
      // Only overtime a manager or HR approved is paid.
      overtimeMinutes += d.overtimeApprovedMinutes ?? 0;
    }

    const adjustments = await prisma.payrollAdjustment.findMany({
      where: { employeeId: emp.id, year: run.year, month: run.month, organizationId: auth.organizationId },
      orderBy: { createdAt: 'asc' },
    });

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
    const result = calculatePayroll(
      salaryInput,
      { daysInMonth, lopDays: lop, overtimeMinutes },
      adjustments.map((a) => ({ kind: a.kind, label: a.label, amountPaise: a.amountPaise })),
      rules,
    );

    const warnings: PayrollException[] = [...result.exceptions];
    if (ymdOf(salary.effectiveFrom) > from) {
      warnings.push({ code: 'SALARY_REVISED', message: `Salary revision effective ${ymdOf(salary.effectiveFrom)} falls within this month; verify proration.`, severity: 'warning' });
    }

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
      snapshot: {
        version: 1,
        calculatedAt: new Date().toISOString(),
        period: { year: run.year, month: run.month, daysInMonth },
        rules,
        inputs: {
          salary: { ...salaryInput, effectiveFrom: ymdOf(salary.effectiveFrom) },
          attendanceCounts: counts,
          overtimeMinutes,
          lopDays: lop,
          adjustments: adjustments.map((a) => ({ kind: a.kind, label: a.label, amountPaise: a.amountPaise })),
        },
        lines: {
          earnings: result.earnings,
          deductions: result.deductions,
          employerContributions: result.employerContributions,
        },
        exceptions: warnings,
      } as unknown as Prisma.InputJsonValue,
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.payrollEntry.deleteMany({ where: { payrollRunId: run.id } });
    if (entries.length) await tx.payrollEntry.createMany({ data: entries });
    const totals = entries.reduce(
      (t, e) => ({
        gross: t.gross + e.grossPaise,
        ded: t.ded + e.totalDeductionsPaise,
        net: t.net + e.netPaise,
        employer: t.employer + e.employerContribPaise,
      }),
      { gross: 0, ded: 0, net: 0, employer: 0 },
    );
    await tx.payrollRun.update({
      where: { id: run.id },
      data: {
        totalGrossPaise: totals.gross,
        totalDeductionsPaise: totals.ded,
        totalNetPaise: totals.net,
        totalEmployerPaise: totals.employer,
      },
    });
  });
  return { employeeCount: entries.length, missingSalary };
}

export async function recalculateRun(auth: AuthContext, id: string, req?: Request) {
  const run = await loadRun(auth, id);
  requireStatus(run, ['DRAFT'], 'Only draft runs can be recalculated. Reopen the run first if you need changes.');
  const result = await recalculate(auth, run);
  await writeAudit(auth, auth.organizationId, { action: 'payroll.recalculated', entityType: 'PayrollRun', entityId: id, summary: { employees: result.employeeCount } }, req);
  return result;
}

export async function validateRun(auth: AuthContext, id: string, req?: Request) {
  const run = await loadRun(auth, id);
  requireStatus(run, ['DRAFT'], 'Only draft runs can be validated.');
  const result = await recalculate(auth, run);

  const entries = await prisma.payrollEntry.findMany({ where: { payrollRunId: id }, include: { employee: { select: { employeeCode: true, firstName: true, lastName: true } } } });
  const blocking: { employeeCode: string; message: string }[] = [];
  const warnings: { employeeCode: string; message: string }[] = [];
  for (const code of result.missingSalary) blocking.push({ employeeCode: code, message: 'No salary assignment effective for this period.' });
  for (const e of entries) {
    for (const ex of (e.snapshot as unknown as { exceptions: PayrollException[] }).exceptions) {
      (ex.severity === 'error' ? blocking : warnings).push({ employeeCode: e.employee.employeeCode, message: ex.message });
    }
  }
  if (blocking.length) {
    const first = blocking[0];
    throw AppError.invalidState(
      `Validation failed with ${blocking.length} blocking exception(s), for example ${first.employeeCode}: ${first.message} Fix them and validate again.`,
      { blocking },
    );
  }
  const claimed = await prisma.payrollRun.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'VALIDATED', validatedAt: new Date() } });
  if (claimed.count === 0) throw AppError.invalidState('This run was changed by someone else. Refresh and try again.');
  await writeAudit(auth, auth.organizationId, { action: 'payroll.validated', entityType: 'PayrollRun', entityId: id, summary: { employees: entries.length, warnings: warnings.length } }, req);
  // Approvers other than the creator (separation of duties).
  const approvers = (await hrUserIds(auth.organizationId)).filter((u) => u !== run.createdById);
  await notifyUsers(auth.organizationId, approvers, {
    kind: 'payroll.validated',
    title: 'Payroll ready for approval',
    body: `Payroll for ${run.month}/${run.year} passed validation and needs an approver.`,
    link: `/payroll/${id}`,
  });
  return { status: 'VALIDATED', employeeCount: entries.length, warnings, missingSalary: result.missingSalary };
}

export async function reopenRun(auth: AuthContext, id: string, reason: string, req?: Request) {
  const run = await loadRun(auth, id);
  requireStatus(run, ['VALIDATED', 'APPROVED'], 'Only validated or approved runs can be reopened. Finalized payroll is immutable.');
  await prisma.payrollRun.updateMany({ where: { id, status: run.status }, data: { status: 'DRAFT', validatedAt: null, approvedAt: null, approvedById: null } });
  await writeAudit(auth, auth.organizationId, { action: 'payroll.reopened', entityType: 'PayrollRun', entityId: id, summary: { reason, from: run.status } }, req);
  return { status: 'DRAFT' };
}

export async function approveRun(auth: AuthContext, id: string, req?: Request) {
  const run = await loadRun(auth, id);
  requireStatus(run, ['VALIDATED'], 'Only validated runs can be approved.');
  if (run.createdById === auth.userId) {
    throw AppError.forbidden('The person who created this payroll run cannot approve it.');
  }
  const claimed = await prisma.payrollRun.updateMany({
    where: { id, status: 'VALIDATED' },
    data: { status: 'APPROVED', approvedById: auth.userId, approvedAt: new Date() },
  });
  if (claimed.count === 0) throw AppError.invalidState('This run was changed by someone else. Refresh and try again.');
  await writeAudit(auth, auth.organizationId, { action: 'payroll.approved', entityType: 'PayrollRun', entityId: id }, req);
  return { status: 'APPROVED' };
}

export async function finalizeRun(auth: AuthContext, id: string, req?: Request) {
  const run = await loadRun(auth, id);
  requireStatus(run, ['APPROVED'], 'Only approved runs can be finalized.');
  if (run.createdById === auth.userId) throw AppError.forbidden('Separation of duties: the creator cannot finalize this run.');
  // The conditional update makes finalization idempotent: a second request finds status FINALIZED and fails.
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.payrollRun.updateMany({
      where: { id, status: 'APPROVED' },
      data: { status: 'FINALIZED', finalizedById: auth.userId, finalizedAt: new Date() },
    });
    if (claimed.count === 0) throw AppError.invalidState('This run has already been finalized.');
    await writeAudit(auth, auth.organizationId, { action: 'payroll.finalized', entityType: 'PayrollRun', entityId: id, summary: { year: run.year, month: run.month } }, req, tx);
  });
  const entries = await prisma.payrollEntry.findMany({
    where: { payrollRunId: id },
    select: { id: true, employee: { select: { user: { select: { id: true, isActive: true } } } } },
  });
  for (const e of entries) {
    if (!e.employee.user?.isActive) continue;
    await notifyUsers(auth.organizationId, [e.employee.user.id], {
      kind: 'payroll.payslip_ready',
      title: 'Your payslip is ready',
      body: `Your payslip for ${run.month}/${run.year} is available. Payment status is shown on the payslip.`,
      link: `/payslips/${e.id}`,
    });
  }
  return { status: 'FINALIZED' };
}

export async function markPayment(auth: AuthContext, entryId: string, reference: string, req?: Request) {
  const entry = await prisma.payrollEntry.findFirst({
    where: { id: entryId, organizationId: auth.organizationId },
    include: { run: { select: { status: true } }, employee: { select: { employeeCode: true } } },
  });
  if (!entry) throw AppError.notFound('Payslip not found.');
  if (entry.run.status !== 'FINALIZED') throw AppError.invalidState('Payment can be recorded only after the run is finalized.');
  if (entry.paymentStatus === 'PAID') throw AppError.conflict('This salary is already marked as paid.');
  await prisma.payrollEntry.updateMany({
    where: { id: entryId, paymentStatus: 'NOT_PAID' },
    data: { paymentStatus: 'PAID', paidAt: new Date(), paymentReference: reference },
  });
  await writeAudit(auth, auth.organizationId, { action: 'payroll.payment_recorded', entityType: 'PayrollEntry', entityId: entryId, summary: { employeeCode: entry.employee.employeeCode, reference } }, req);
  return { id: entryId, paymentStatus: 'PAID' };
}

/** Bank transfer file. Contains full account numbers, so the export is audited. */
export async function bankExportCsv(auth: AuthContext, runId: string, req?: Request): Promise<string> {
  const run = await loadRun(auth, runId);
  requireStatus(run, ['FINALIZED'], 'Bank export is available only for finalized runs.');
  const entries = await prisma.payrollEntry.findMany({
    where: { payrollRunId: runId },
    orderBy: { employee: { employeeCode: 'asc' } },
    include: { employee: { select: { employeeCode: true, firstName: true, lastName: true, bankAccountCipher: true, bankIfsc: true, bankName: true } } },
  });
  await writeAudit(auth, auth.organizationId, { action: 'payroll.bank_export', entityType: 'PayrollRun', entityId: runId, summary: { rows: entries.length } }, req);
  const header = ['Employee Code', 'Beneficiary Name', 'Bank Name', 'Account Number', 'IFSC', 'Net Amount (INR)'];
  const lines = entries.map((e) => {
    const amount = (e.netPaise / 100).toFixed(2);
    const account = e.employee.bankAccountCipher ? decryptField(e.employee.bankAccountCipher) : '';
    return csvRow([e.employee.employeeCode, `${e.employee.firstName} ${e.employee.lastName}`, e.employee.bankName, account, e.employee.bankIfsc, amount]);
  });
  return [csvRow(header), ...lines].join('\n');
}

// -- Adjustments -------------------------------------------------------------------------------------------------

export async function addAdjustment(
  auth: AuthContext,
  input: { employeeId: string; year: number; month: number; kind: 'EARNING' | 'DEDUCTION'; label: string; amountPaise: number },
  req?: Request,
) {
  assertPeriod(input.year, input.month);
  const run = await prisma.payrollRun.findUnique({ where: { organizationId_year_month: { organizationId: auth.organizationId, year: input.year, month: input.month } } });
  if (run && run.status !== 'DRAFT' && run.status !== 'VALIDATED') {
    throw AppError.invalidState('This period is approved or finalized. Adjustments for it are closed.');
  }
  const emp = await prisma.employee.findFirst({ where: { id: input.employeeId, organizationId: auth.organizationId }, select: { id: true } });
  if (!emp) throw AppError.badRequest('Choose a valid employee.', [{ field: 'employeeId', message: 'Choose an employee.' }]);
  const row = await prisma.payrollAdjustment.create({
    data: { ...input, organizationId: auth.organizationId, createdById: auth.userId },
  });
  if (run?.status === 'VALIDATED') {
    // Validation no longer reflects the data; send the run back to draft.
    await prisma.payrollRun.updateMany({ where: { id: run.id, status: 'VALIDATED' }, data: { status: 'DRAFT', validatedAt: null } });
  }
  await writeAudit(auth, auth.organizationId, { action: 'payroll.adjustment_added', entityType: 'PayrollAdjustment', entityId: row.id, summary: { kind: input.kind, amountPaise: input.amountPaise, period: `${input.year}-${input.month}` } }, req);
  return { id: row.id };
}

export async function listAdjustments(auth: AuthContext, year: number, month: number) {
  const rows = await prisma.payrollAdjustment.findMany({
    where: { organizationId: auth.organizationId, year, month },
    include: { employee: { select: { employeeCode: true, firstName: true, lastName: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => ({
    id: r.id,
    employee: { id: r.employeeId, employeeCode: r.employee.employeeCode, name: `${r.employee.firstName} ${r.employee.lastName}` },
    kind: r.kind,
    label: r.label,
    amountPaise: r.amountPaise,
    createdAt: r.createdAt.toISOString(),
  }));
}

// -- Payslips ----------------------------------------------------------------------------------------------------

/** Payslip for one finalized entry. Visible to the employee themself, their manager's team scope excluded, and HR. */
export async function getPayslip(auth: AuthContext, entryId: string, req?: Request) {
  const entry = await prisma.payrollEntry.findFirst({
    where: { id: entryId, organizationId: auth.organizationId, employee: employeeScope(auth), run: { status: 'FINALIZED' } },
    include: {
      run: { select: { year: true, month: true, status: true, finalizedAt: true } },
      employee: {
        select: {
          employeeCode: true, firstName: true, lastName: true, joiningDate: true,
          department: { select: { name: true } }, designation: { select: { title: true } },
          bankName: true, bankAccountLast4: true,
        },
      },
    },
  });
  if (!entry) throw AppError.notFound('Payslip not found.');
  if (auth.role === 'MANAGER') throw AppError.forbidden('Managers cannot view payslips.');
  if (auth.employeeId !== entry.employeeId) {
    await writeAudit(auth, auth.organizationId, { action: 'payroll.payslip_viewed', entityType: 'PayrollEntry', entityId: entryId }, req);
  }

  // Year-to-date figures within the financial year, using finalized runs only.
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: auth.organizationId }, select: { financialYearStartMonth: true, name: true, legalName: true } });
  const fyStart = org.financialYearStartMonth;
  const { run } = entry;
  const fyStartYear = run.month >= fyStart ? run.year : run.year - 1;
  const periodKey = (y: number, m: number) => y * 100 + m;
  const fyFrom = periodKey(fyStartYear, fyStart);
  const fyTo = periodKey(fyStartYear + 1, fyStart); // exclusive
  const ytdEntries = await prisma.payrollEntry.findMany({
    where: { employeeId: entry.employeeId, run: { status: 'FINALIZED', year: { in: [fyStartYear, fyStartYear + 1] } } },
    select: { grossPaise: true, totalDeductionsPaise: true, netPaise: true, run: { select: { year: true, month: true } } },
  });
  // Year to date = finalized periods inside this financial year, up to and including the viewed period.
  const ytd = ytdEntries
    .filter((e) => {
      const key = periodKey(e.run.year, e.run.month);
      return key >= fyFrom && key < fyTo && key <= periodKey(run.year, run.month);
    })
    .reduce((t, e) => ({ gross: t.gross + e.grossPaise, deductions: t.deductions + e.totalDeductionsPaise, net: t.net + e.netPaise }), { gross: 0, deductions: 0, net: 0 });

  const snap = entry.snapshot as unknown as { lines: unknown; inputs: unknown; period: unknown; calculatedAt: string };
  return {
    id: entry.id,
    runId: entry.payrollRunId,
    organization: { name: org.name, legalName: org.legalName },
    period: { year: run.year, month: run.month },
    employee: {
      id: entry.employeeId,
      employeeCode: entry.employee.employeeCode,
      name: `${entry.employee.firstName} ${entry.employee.lastName}`,
      department: entry.employee.department.name,
      designation: entry.employee.designation.title,
      joiningDate: ymdOf(entry.employee.joiningDate),
      bankAccount: entry.employee.bankAccountLast4 ? `•••• ${entry.employee.bankAccountLast4}` : null,
    },
    paidDays: Number(entry.paidDays),
    lopDays: Number(entry.lopDays),
    paymentStatus: entry.paymentStatus,
    paidAt: entry.paidAt?.toISOString() ?? null,
    lines: snap.lines,
    totals: {
      grossPaise: entry.grossPaise,
      deductionsPaise: entry.totalDeductionsPaise,
      netPaise: entry.netPaise,
      employerContribPaise: entry.employerContribPaise,
    },
    ytd: { fromMonth: fyStart, ...ytd },
    finalizedAt: run.finalizedAt?.toISOString() ?? null,
  };
}

export async function listMyPayslips(auth: AuthContext) {
  if (!auth.employeeId) return { items: [] };
  const entries = await prisma.payrollEntry.findMany({
    where: { employeeId: auth.employeeId, run: { status: 'FINALIZED' } },
    include: { run: { select: { year: true, month: true } } },
    orderBy: { run: { year: 'desc' } },
    take: 60,
  });
  return {
    items: entries
      .sort((a, b) => b.run.year * 100 + b.run.month - (a.run.year * 100 + a.run.month))
      .map((e) => ({
        id: e.id,
        period: { year: e.run.year, month: e.run.month },
        grossPaise: e.grossPaise,
        deductionsPaise: e.totalDeductionsPaise,
        netPaise: e.netPaise,
        paymentStatus: e.paymentStatus,
        paidAt: e.paidAt?.toISOString() ?? null,
      })),
  };
}

export async function payrollSummaryReport(auth: AuthContext, year: number) {
  const runs = await prisma.payrollRun.findMany({
    where: { organizationId: auth.organizationId, year, status: 'FINALIZED' },
    orderBy: { month: 'asc' },
    select: { month: true, totalGrossPaise: true, totalDeductionsPaise: true, totalNetPaise: true, totalEmployerPaise: true, _count: { select: { entries: true } } },
  });
  return runs.map((r) => ({
    month: r.month,
    employees: r._count.entries,
    grossPaise: r.totalGrossPaise,
    deductionsPaise: r.totalDeductionsPaise,
    netPaise: r.totalNetPaise,
    employerPaise: r.totalEmployerPaise,
  }));
}
