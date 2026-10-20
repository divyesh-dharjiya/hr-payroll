import type { Request } from 'express';
import { Prisma, type LeaveAccrual } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import type { AuthContext } from '../../middleware/auth';
import { employeeScope, teamScope } from '../employees/employees.service';
import { dateOnly, todayIn, ymdOf } from '../../lib/time';
import { loadRules } from '../attendance/attendance.service';
import { countLeaveDays, leaveBalance, rangesOverlap } from './leave.rules';
import { hrUserIds, managerUserIdFor, notifyUsers, userIdForEmployee } from '../../lib/notify';

// ---------------------------------------------------------------------------------------------------------------
// Leave service. Balances are derived from request records (approved days + pending reservations) so an approved
// day is counted exactly once. Balance checks and status changes run in SERIALIZABLE transactions.
// ---------------------------------------------------------------------------------------------------------------

const SERIALIZABLE = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable } as const;

export interface LeaveYear {
  start: string; // YYYY-MM-DD
  end: string;
  monthsElapsed: number;
}

/** Financial year window that contains `today`, given the organization's FY start month (1-12). */
export function leaveYearFor(today: string, fyStartMonth: number): LeaveYear {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const startYear = m >= fyStartMonth ? y : y - 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  const start = `${startYear}-${pad(fyStartMonth)}-01`;
  const endYear = fyStartMonth === 1 ? startYear : startYear + 1;
  const endMonth = fyStartMonth === 1 ? 12 : fyStartMonth - 1;
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  const end = `${endYear}-${pad(endMonth)}-${pad(lastDay)}`;
  const monthsElapsed = (y - startYear) * 12 + (m - fyStartMonth) + 1;
  return { start, end, monthsElapsed };
}

export async function listTypes(auth: AuthContext) {
  const types = await prisma.leaveType.findMany({
    where: { organizationId: auth.organizationId, ...(auth.role === 'EMPLOYEE' ? { isActive: true } : {}) },
    orderBy: { code: 'asc' },
  });
  return types.map((t) => ({
    id: t.id,
    code: t.code,
    name: t.name,
    isPaid: t.isPaid,
    annualQuotaDays: Number(t.annualQuotaDays),
    accrual: t.accrual,
    allowHalfDay: t.allowHalfDay,
    carryForwardDays: Number(t.carryForwardDays),
    isActive: t.isActive,
  }));
}

export interface LeaveTypeInput {
  code: string;
  name: string;
  isPaid: boolean;
  annualQuotaDays: number;
  accrual: LeaveAccrual;
  allowHalfDay: boolean;
  carryForwardDays: number;
  isActive: boolean;
}

export async function saveLeaveType(auth: AuthContext, id: string | null, input: LeaveTypeInput, req?: Request) {
  const data = {
    code: input.code.toUpperCase(),
    name: input.name,
    isPaid: input.isPaid,
    annualQuotaDays: input.annualQuotaDays,
    accrual: input.accrual,
    allowHalfDay: input.allowHalfDay,
    carryForwardDays: input.carryForwardDays,
    isActive: input.isActive,
  };
  try {
    const row = id
      ? await prisma.leaveType.update({ where: { id, organizationId: auth.organizationId }, data })
      : await prisma.leaveType.create({ data: { ...data, organizationId: auth.organizationId } });
    await writeAudit(auth, auth.organizationId, { action: id ? 'leave_type.updated' : 'leave_type.created', entityType: 'LeaveType', entityId: row.id, summary: { code: row.code } }, req);
    return { id: row.id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw AppError.conflict('A leave type with this code already exists.', [{ field: 'code', message: 'Code already in use.' }]);
    }
    throw err;
  }
}

export async function balancesFor(auth: AuthContext, employeeId?: string) {
  const target = employeeId ?? auth.employeeId;
  if (!target) return { items: [], leaveYear: null };
  const emp = await prisma.employee.findFirst({ where: { AND: [employeeScope(auth), { id: target }] }, select: { id: true, firstName: true, lastName: true } });
  if (!emp) throw AppError.notFound('Employee not found.');

  const rules = await loadRules(auth.organizationId);
  const year = leaveYearFor(todayIn(rules.timezone), (await prisma.organization.findUniqueOrThrow({ where: { id: auth.organizationId } })).financialYearStartMonth);
  const [types, requests] = await Promise.all([
    prisma.leaveType.findMany({ where: { organizationId: auth.organizationId, isActive: true }, orderBy: { code: 'asc' } }),
    prisma.leaveRequest.findMany({
      where: {
        employeeId: target,
        status: { in: ['APPROVED', 'PENDING', 'CANCEL_REQUESTED'] },
        startDate: { lte: dateOnly(year.end) },
        endDate: { gte: dateOnly(year.start) },
      },
      select: { leaveTypeId: true, status: true, days: true },
    }),
  ]);

  const items = types.map((t) => {
    const mine = requests.filter((r) => r.leaveTypeId === t.id);
    const approvedDays = mine.filter((r) => r.status === 'APPROVED' || r.status === 'CANCEL_REQUESTED').reduce((s, r) => s + Number(r.days), 0);
    const pendingDays = mine.filter((r) => r.status === 'PENDING').reduce((s, r) => s + Number(r.days), 0);
    const b = leaveBalance({
      annualQuotaDays: Number(t.annualQuotaDays),
      accrual: t.accrual,
      monthsElapsed: year.monthsElapsed,
      carryForwardDays: Number(t.carryForwardDays),
      approvedDays,
      pendingDays,
      isPaid: t.isPaid,
    });
    return {
      leaveTypeId: t.id,
      code: t.code,
      name: t.name,
      isPaid: t.isPaid,
      entitled: b.entitled,
      used: b.used,
      pending: b.pending,
      available: b.unlimited ? null : b.available,
      unlimited: b.unlimited,
    };
  });
  return { employee: { id: emp.id, name: `${emp.firstName} ${emp.lastName}` }, leaveYear: year, items };
}

export interface RequestInput {
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  isHalfDay: boolean;
  reason: string;
}

export async function createRequest(auth: AuthContext, input: RequestInput, req?: Request) {
  if (!auth.employeeId) throw AppError.forbidden('Your account is not linked to an employee profile.');
  const employeeId = auth.employeeId;
  if (input.endDate < input.startDate) {
    throw AppError.badRequest('The end date must be on or after the start date.', [{ field: 'endDate', message: 'Choose a later end date.' }]);
  }
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: auth.organizationId } });
  const today = todayIn(org.timezone);
  if (input.startDate < ymdOf(new Date(Date.parse(`${today}T00:00:00Z`) - 365 * 86_400_000))) {
    throw AppError.badRequest('Leave cannot be requested more than a year in the past.');
  }

  const type = await prisma.leaveType.findFirst({ where: { id: input.leaveTypeId, organizationId: auth.organizationId, isActive: true } });
  if (!type) throw AppError.badRequest('Choose an active leave type.', [{ field: 'leaveTypeId', message: 'Choose a valid leave type.' }]);
  if (input.isHalfDay && !type.allowHalfDay) {
    throw AppError.badRequest('Half-day leave is not allowed for this leave type.', [{ field: 'isHalfDay', message: 'Not allowed for this type.' }]);
  }
  if (input.isHalfDay && input.startDate !== input.endDate) {
    throw AppError.badRequest('A half-day request must be for a single date.', [{ field: 'endDate', message: 'Use the same date for a half day.' }]);
  }

  const holidays = await prisma.holiday.findMany({
    where: { organizationId: auth.organizationId, holidayDate: { gte: dateOnly(input.startDate), lte: dateOnly(input.endDate) } },
  });
  const days = countLeaveDays({
    startDate: input.startDate,
    endDate: input.endDate,
    isHalfDay: input.isHalfDay,
    weeklyOffDays: org.weeklyOffDays,
    holidays: new Set(holidays.map((h) => ymdOf(h.holidayDate))),
  });
  if (days === 0) {
    throw AppError.badRequest('The selected dates contain no working days.', [{ field: 'startDate', message: 'Choose working days.' }]);
  }

  const created = await prisma.$transaction(async (tx) => {
    const overlap = await tx.leaveRequest.findFirst({
      where: {
        employeeId,
        status: { in: ['PENDING', 'APPROVED', 'CANCEL_REQUESTED'] },
        startDate: { lte: dateOnly(input.endDate) },
        endDate: { gte: dateOnly(input.startDate) },
      },
      select: { id: true, startDate: true, endDate: true },
    });
    if (overlap && rangesOverlap(input.startDate, input.endDate, ymdOf(overlap.startDate), ymdOf(overlap.endDate))) {
      throw AppError.conflict('This overlaps an existing leave request for these dates.', [{ field: 'startDate', message: 'Overlaps another request.' }]);
    }

    if (type.isPaid) {
      const year = leaveYearFor(today, org.financialYearStartMonth);
      const reqs = await tx.leaveRequest.findMany({
        where: {
          employeeId,
          leaveTypeId: type.id,
          status: { in: ['APPROVED', 'PENDING', 'CANCEL_REQUESTED'] },
          startDate: { lte: dateOnly(year.end) },
          endDate: { gte: dateOnly(year.start) },
        },
        select: { status: true, days: true },
      });
      const approvedDays = reqs.filter((r) => r.status !== 'PENDING').reduce((s, r) => s + Number(r.days), 0);
      const pendingDays = reqs.filter((r) => r.status === 'PENDING').reduce((s, r) => s + Number(r.days), 0);
      const b = leaveBalance({
        annualQuotaDays: Number(type.annualQuotaDays),
        accrual: type.accrual,
        monthsElapsed: year.monthsElapsed,
        carryForwardDays: Number(type.carryForwardDays),
        approvedDays,
        pendingDays,
        isPaid: true,
      });
      if (b.available < days) {
        throw AppError.invalidState(`Insufficient ${type.name} balance. Available: ${b.available} day(s), requested: ${days}.`);
      }
    }

    return tx.leaveRequest.create({
      data: {
        organizationId: auth.organizationId,
        employeeId,
        leaveTypeId: type.id,
        startDate: dateOnly(input.startDate),
        endDate: dateOnly(input.endDate),
        isHalfDay: input.isHalfDay,
        days,
        reason: input.reason,
      },
    });
  }, SERIALIZABLE);

  await writeAudit(auth, auth.organizationId, { action: 'leave.requested', entityType: 'LeaveRequest', entityId: created.id, summary: { days, type: type.code } }, req);
  // The reporting manager decides; without a manager, HR does.
  const approver = await managerUserIdFor(employeeId);
  await notifyUsers(auth.organizationId, approver ? [approver] : await hrUserIds(auth.organizationId), {
    kind: 'leave.requested',
    title: 'Leave request to review',
    body: `${auth.name} requested ${days} day(s) of ${type.name} from ${input.startDate}.`,
    link: '/leave',
  });
  return { id: created.id, status: created.status, days };
}

export async function listRequests(auth: AuthContext, status?: string) {
  const rows = await prisma.leaveRequest.findMany({
    where: {
      organizationId: auth.organizationId,
      ...(status ? { status: status as never } : {}),
      employee: employeeScope(auth),
    },
    orderBy: { createdAt: 'desc' },
    take: 300,
    include: {
      employee: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
      leaveType: { select: { code: true, name: true, isPaid: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    employee: { id: r.employee.id, name: `${r.employee.firstName} ${r.employee.lastName}`, employeeCode: r.employee.employeeCode },
    leaveType: r.leaveType,
    startDate: ymdOf(r.startDate),
    endDate: ymdOf(r.endDate),
    isHalfDay: r.isHalfDay,
    days: Number(r.days),
    reason: r.reason,
    status: r.status,
    decisionComment: r.decisionComment,
    decidedAt: r.decidedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    isOwn: r.employee.id === auth.employeeId,
  }));
}

export async function decideRequest(auth: AuthContext, id: string, decision: 'APPROVE' | 'REJECT', comment: string | undefined, req?: Request) {
  if (auth.role === 'EMPLOYEE') throw AppError.forbidden();
  const request = await prisma.leaveRequest.findFirst({
    where: { id, organizationId: auth.organizationId, employee: teamScope(auth) },
    include: { leaveType: true },
  });
  if (!request) throw AppError.notFound('Leave request not found.');
  if (request.employeeId === auth.employeeId) throw AppError.forbidden('You cannot approve your own leave.');

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.leaveRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        deciderId: auth.userId,
        decisionComment: comment,
        decidedAt: new Date(),
      },
    });
    if (claimed.count === 0) throw AppError.invalidState('This request has already been decided.');
    if (decision === 'APPROVE' && request.leaveType.isPaid) {
      // Re-check the balance now that the request is approved: approved days must never exceed the entitlement.
      const org = await tx.organization.findUniqueOrThrow({ where: { id: auth.organizationId } });
      const year = leaveYearFor(todayIn(org.timezone), org.financialYearStartMonth);
      const reqs = await tx.leaveRequest.findMany({
        where: {
          employeeId: request.employeeId,
          leaveTypeId: request.leaveTypeId,
          status: { in: ['APPROVED', 'PENDING', 'CANCEL_REQUESTED'] },
          startDate: { lte: dateOnly(year.end) },
          endDate: { gte: dateOnly(year.start) },
        },
        select: { status: true, days: true },
      });
      const approvedDays = reqs.filter((r) => r.status !== 'PENDING').reduce((s, r) => s + Number(r.days), 0);
      const pendingDays = reqs.filter((r) => r.status === 'PENDING').reduce((s, r) => s + Number(r.days), 0);
      const b = leaveBalance({
        annualQuotaDays: Number(request.leaveType.annualQuotaDays),
        accrual: request.leaveType.accrual,
        monthsElapsed: year.monthsElapsed,
        carryForwardDays: Number(request.leaveType.carryForwardDays),
        approvedDays,
        pendingDays,
        isPaid: true,
      });
      if (b.available < 0) throw AppError.invalidState('Approving this request would exceed the employee leave balance.');
    }
    await writeAudit(auth, auth.organizationId, { action: `leave.${decision.toLowerCase()}d`, entityType: 'LeaveRequest', entityId: id, summary: { days: Number(request.days) } }, req, tx);
  }, SERIALIZABLE);
  await notifyUsers(auth.organizationId, [await userIdForEmployee(request.employeeId)], {
    kind: decision === 'APPROVE' ? 'leave.approved' : 'leave.rejected',
    title: decision === 'APPROVE' ? 'Leave approved' : 'Leave not approved',
    body: `Your ${request.leaveType.name} from ${ymdOf(request.startDate)} was ${decision === 'APPROVE' ? 'approved' : 'rejected'} by ${auth.name}.${comment ? ` Comment: ${comment}` : ''}`,
    link: '/leave',
  });
  return { id, status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
}

export async function cancelRequest(auth: AuthContext, id: string, reason: string, req?: Request) {
  if (!auth.employeeId) throw AppError.forbidden();
  const request = await prisma.leaveRequest.findFirst({ where: { id, employeeId: auth.employeeId, organizationId: auth.organizationId } });
  if (!request) throw AppError.notFound('Leave request not found.');
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: auth.organizationId } });
  const today = todayIn(org.timezone);
  const startsInFuture = ymdOf(request.startDate) > today;

  let next: 'CANCELLED' | 'CANCEL_REQUESTED';
  if (request.status === 'PENDING') next = 'CANCELLED';
  else if (request.status === 'APPROVED' && startsInFuture) next = 'CANCEL_REQUESTED';
  else throw AppError.invalidState('This leave cannot be cancelled. Approved leave that has started needs HR review.');

  const updated = await prisma.leaveRequest.updateMany({
    where: { id, status: request.status },
    data: { status: next, cancelReason: reason },
  });
  if (updated.count === 0) throw AppError.invalidState('The request changed. Refresh and try again.');
  await writeAudit(auth, auth.organizationId, { action: 'leave.cancel_requested', entityType: 'LeaveRequest', entityId: id, summary: { next } }, req);
  if (next === 'CANCEL_REQUESTED') {
    const approver = await managerUserIdFor(auth.employeeId);
    await notifyUsers(auth.organizationId, approver ? [approver] : await hrUserIds(auth.organizationId), {
      kind: 'leave.cancel_requested',
      title: 'Leave cancellation to review',
      body: `${auth.name} asked to cancel approved leave from ${ymdOf(request.startDate)}.`,
      link: '/leave',
    });
  }
  return { id, status: next };
}

export async function decideCancellation(auth: AuthContext, id: string, decision: 'APPROVE' | 'REJECT', req?: Request) {
  if (auth.role === 'EMPLOYEE') throw AppError.forbidden();
  const request = await prisma.leaveRequest.findFirst({ where: { id, organizationId: auth.organizationId, employee: teamScope(auth) } });
  if (!request) throw AppError.notFound('Leave request not found.');
  if (request.employeeId === auth.employeeId) throw AppError.forbidden('You cannot decide on your own cancellation.');
  if (request.status !== 'CANCEL_REQUESTED') throw AppError.invalidState('There is no cancellation request for this leave.');
  const next = decision === 'APPROVE' ? 'CANCELLED' : 'APPROVED';
  await prisma.leaveRequest.updateMany({ where: { id, status: 'CANCEL_REQUESTED' }, data: { status: next, deciderId: auth.userId, decidedAt: new Date() } });
  await writeAudit(auth, auth.organizationId, { action: `leave.cancellation_${decision.toLowerCase()}d`, entityType: 'LeaveRequest', entityId: id }, req);
  await notifyUsers(auth.organizationId, [await userIdForEmployee(request.employeeId)], {
    kind: 'leave.cancellation_decided',
    title: decision === 'APPROVE' ? 'Leave cancelled' : 'Leave cancellation declined',
    body: decision === 'APPROVE'
      ? `Your leave from ${ymdOf(request.startDate)} was cancelled and the days returned to your balance.`
      : `Your leave from ${ymdOf(request.startDate)} stays approved.`,
    link: '/leave',
  });
  return { id, status: next };
}

/** Team availability: everyone in scope with leave overlapping the month (pending and approved). */
export async function availabilityCalendar(auth: AuthContext, year: number, month: number) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const from = `${year}-${pad(month)}-01`;
  const to = `${year}-${pad(month)}-${pad(last)}`;
  const [requests, holidays] = await Promise.all([
    prisma.leaveRequest.findMany({
      where: {
        organizationId: auth.organizationId,
        status: { in: ['APPROVED', 'PENDING', 'CANCEL_REQUESTED'] },
        startDate: { lte: dateOnly(to) },
        endDate: { gte: dateOnly(from) },
        employee: employeeScope(auth),
      },
      include: {
        employee: { select: { firstName: true, lastName: true, department: { select: { name: true } } } },
        leaveType: { select: { code: true, name: true } },
      },
      orderBy: { startDate: 'asc' },
    }),
    prisma.holiday.findMany({ where: { organizationId: auth.organizationId, holidayDate: { gte: dateOnly(from), lte: dateOnly(to) } }, orderBy: { holidayDate: 'asc' } }),
  ]);
  return {
    from,
    to,
    holidays: holidays.map((h) => ({ date: ymdOf(h.holidayDate), name: h.name })),
    items: requests.map((r) => ({
      employee: `${r.employee.firstName} ${r.employee.lastName}`,
      department: r.employee.department.name,
      leaveType: r.leaveType.code,
      status: r.status,
      startDate: ymdOf(r.startDate),
      endDate: ymdOf(r.endDate),
      days: Number(r.days),
    })),
  };
}
