import { db } from '../../db';
import type { LeaveAccrual, LeaveRequest, LeaveRequestStatus, LeaveType } from '../../db/schema';
import { AppError, UniqueConstraintError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { addDays, todayIn } from '../../lib/time';
import { hrUserIds, managerUserIdFor, notifyUsers, userIdForEmployee } from '../../lib/notify';
import type { AuthContext } from '../../security/session';
import { employeeScope, fullName, organizationOf, teamScope } from '../employees/employees.service';
import { countLeaveDays, leaveBalance, rangesOverlap } from './leave.rules';

// ---------------------------------------------------------------------------------------------------------------
// Leave service. Balances are derived from request records (approved days + pending reservations) so an approved
// day is counted exactly once. Each request runs as one transaction, so a balance check and the change it guards
// cannot be split by another request.
// ---------------------------------------------------------------------------------------------------------------

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

const ACTIVE_STATUSES: LeaveRequestStatus[] = ['APPROVED', 'PENDING', 'CANCEL_REQUESTED'];

/** Requests of one employee and leave type that count against the balance in the leave year. */
function requestsInYear(employeeId: string, leaveTypeId: string | null, year: LeaveYear): LeaveRequest[] {
  return db.leaveRequests
    .by('employeeId', employeeId)
    .filter((r) => (!leaveTypeId || r.leaveTypeId === leaveTypeId) && ACTIVE_STATUSES.includes(r.status) && r.startDate <= year.end && r.endDate >= year.start);
}

function balanceOf(type: LeaveType, requests: LeaveRequest[], year: LeaveYear) {
  const approvedDays = requests.filter((r) => r.status !== 'PENDING').reduce((s, r) => s + r.days, 0);
  const pendingDays = requests.filter((r) => r.status === 'PENDING').reduce((s, r) => s + r.days, 0);
  return leaveBalance({
    annualQuotaDays: type.annualQuotaDays,
    accrual: type.accrual,
    monthsElapsed: year.monthsElapsed,
    carryForwardDays: type.carryForwardDays,
    approvedDays,
    pendingDays,
    isPaid: type.isPaid,
  });
}

export function listTypes(auth: AuthContext) {
  return db.leaveTypes
    .filter((t) => t.organizationId === auth.organizationId && (auth.role !== 'EMPLOYEE' || t.isActive))
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((t) => ({
      id: t.id,
      code: t.code,
      name: t.name,
      isPaid: t.isPaid,
      annualQuotaDays: t.annualQuotaDays,
      accrual: t.accrual,
      allowHalfDay: t.allowHalfDay,
      carryForwardDays: t.carryForwardDays,
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

export function saveLeaveType(auth: AuthContext, id: string | null, input: LeaveTypeInput) {
  const data = { ...input, code: input.code.toUpperCase() };
  try {
    let row: LeaveType;
    if (id) {
      const existing = db.leaveTypes.get(id);
      if (!existing || existing.organizationId !== auth.organizationId) throw AppError.notFound('Leave type not found.');
      row = db.leaveTypes.update(id, data);
    } else {
      row = db.leaveTypes.insert({ ...data, organizationId: auth.organizationId });
    }
    writeAudit(auth, auth.organizationId, { action: id ? 'leave_type.updated' : 'leave_type.created', entityType: 'LeaveType', entityId: row.id, summary: { code: row.code } });
    return { id: row.id };
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      throw AppError.conflict('A leave type with this code already exists.', [{ field: 'code', message: 'Code already in use.' }]);
    }
    throw err;
  }
}

export function balancesFor(auth: AuthContext, employeeId?: string) {
  const target = employeeId ?? auth.employeeId;
  if (!target) return { items: [], leaveYear: null };
  const emp = db.employees.get(target);
  if (!emp || !employeeScope(auth)(emp)) throw AppError.notFound('Employee not found.');

  const org = organizationOf(auth);
  const year = leaveYearFor(todayIn(org.timezone), org.financialYearStartMonth);
  const types = db.leaveTypes.filter((t) => t.organizationId === auth.organizationId && t.isActive).sort((a, b) => a.code.localeCompare(b.code));
  const requests = requestsInYear(target, null, year);

  const items = types.map((t) => {
    const b = balanceOf(t, requests.filter((r) => r.leaveTypeId === t.id), year);
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
  return { employee: { id: emp.id, name: fullName(emp) }, leaveYear: year, items };
}

export interface RequestInput {
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  isHalfDay: boolean;
  reason: string;
}

export function createRequest(auth: AuthContext, input: RequestInput) {
  if (!auth.employeeId) throw AppError.forbidden('Your account is not linked to an employee profile.');
  const employeeId = auth.employeeId;
  if (input.endDate < input.startDate) {
    throw AppError.badRequest('The end date must be on or after the start date.', [{ field: 'endDate', message: 'Choose a later end date.' }]);
  }
  const org = organizationOf(auth);
  const today = todayIn(org.timezone);
  if (input.startDate < addDays(today, -365)) {
    throw AppError.badRequest('Leave cannot be requested more than a year in the past.');
  }

  const type = db.leaveTypes.get(input.leaveTypeId);
  if (!type || type.organizationId !== auth.organizationId || !type.isActive) {
    throw AppError.badRequest('Choose an active leave type.', [{ field: 'leaveTypeId', message: 'Choose a valid leave type.' }]);
  }
  if (input.isHalfDay && !type.allowHalfDay) {
    throw AppError.badRequest('Half-day leave is not allowed for this leave type.', [{ field: 'isHalfDay', message: 'Not allowed for this type.' }]);
  }
  if (input.isHalfDay && input.startDate !== input.endDate) {
    throw AppError.badRequest('A half-day request must be for a single date.', [{ field: 'endDate', message: 'Use the same date for a half day.' }]);
  }

  const holidays = db.holidays.filter((h) => h.organizationId === auth.organizationId && h.holidayDate >= input.startDate && h.holidayDate <= input.endDate);
  const days = countLeaveDays({
    startDate: input.startDate,
    endDate: input.endDate,
    isHalfDay: input.isHalfDay,
    weeklyOffDays: org.weeklyOffDays,
    holidays: new Set(holidays.map((h) => h.holidayDate)),
  });
  if (days === 0) {
    throw AppError.badRequest('The selected dates contain no working days.', [{ field: 'startDate', message: 'Choose working days.' }]);
  }

  const overlap = db.leaveRequests
    .by('employeeId', employeeId)
    .find((r) => ACTIVE_STATUSES.includes(r.status) && rangesOverlap(input.startDate, input.endDate, r.startDate, r.endDate));
  if (overlap) {
    throw AppError.conflict('This overlaps an existing leave request for these dates.', [{ field: 'startDate', message: 'Overlaps another request.' }]);
  }

  if (type.isPaid) {
    const year = leaveYearFor(today, org.financialYearStartMonth);
    const b = balanceOf(type, requestsInYear(employeeId, type.id, year), year);
    if (b.available < days) {
      throw AppError.invalidState(`Insufficient ${type.name} balance. Available: ${b.available} day(s), requested: ${days}.`);
    }
  }

  const created = db.leaveRequests.insert({
    organizationId: auth.organizationId,
    employeeId,
    leaveTypeId: type.id,
    startDate: input.startDate,
    endDate: input.endDate,
    isHalfDay: input.isHalfDay,
    days,
    reason: input.reason,
  });

  writeAudit(auth, auth.organizationId, { action: 'leave.requested', entityType: 'LeaveRequest', entityId: created.id, summary: { days, type: type.code } });
  // The reporting manager decides; without a manager, HR does.
  const approver = managerUserIdFor(employeeId);
  notifyUsers(auth.organizationId, approver ? [approver] : hrUserIds(auth.organizationId), {
    kind: 'leave.requested',
    title: 'Leave request to review',
    body: `${auth.name} requested ${days} day(s) of ${type.name} from ${input.startDate}.`,
    link: '/leave',
  });
  return { id: created.id, status: created.status, days };
}

export function listRequests(auth: AuthContext, status?: string) {
  const scope = employeeScope(auth);
  return db.leaveRequests
    .filter((r) => {
      if (r.organizationId !== auth.organizationId || (status && r.status !== status)) return false;
      const e = db.employees.get(r.employeeId);
      return Boolean(e && scope(e));
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 300)
    .map((r) => {
      const e = db.employees.get(r.employeeId)!;
      const t = db.leaveTypes.get(r.leaveTypeId)!;
      return {
        id: r.id,
        employee: { id: e.id, name: fullName(e), employeeCode: e.employeeCode },
        leaveType: { code: t.code, name: t.name, isPaid: t.isPaid },
        startDate: r.startDate,
        endDate: r.endDate,
        isHalfDay: r.isHalfDay,
        days: r.days,
        reason: r.reason,
        status: r.status,
        decisionComment: r.decisionComment,
        decidedAt: r.decidedAt,
        createdAt: r.createdAt,
        isOwn: e.id === auth.employeeId,
      };
    });
}

/** A request the caller may decide on: in their organization and their team. 404 otherwise. */
function teamRequest(auth: AuthContext, id: string): LeaveRequest {
  const request = db.leaveRequests.get(id);
  const employee = request ? db.employees.get(request.employeeId) : undefined;
  if (!request || request.organizationId !== auth.organizationId || !employee || !teamScope(auth)(employee)) {
    throw AppError.notFound('Leave request not found.');
  }
  return request;
}

export function decideRequest(auth: AuthContext, id: string, decision: 'APPROVE' | 'REJECT', comment: string | undefined) {
  if (auth.role === 'EMPLOYEE') throw AppError.forbidden();
  const request = teamRequest(auth, id);
  if (request.employeeId === auth.employeeId) throw AppError.forbidden('You cannot approve your own leave.');
  if (request.status !== 'PENDING') throw AppError.invalidState('This request has already been decided.');
  const type = db.leaveTypes.get(request.leaveTypeId)!;

  db.leaveRequests.update(id, {
    status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
    deciderId: auth.userId,
    decisionComment: comment ?? null,
    decidedAt: new Date().toISOString(),
  });
  if (decision === 'APPROVE' && type.isPaid) {
    // Re-check the balance now that the request is approved: approved days must never exceed the entitlement.
    const org = organizationOf(auth);
    const year = leaveYearFor(todayIn(org.timezone), org.financialYearStartMonth);
    const b = balanceOf(type, requestsInYear(request.employeeId, type.id, year), year);
    if (b.available < 0) throw AppError.invalidState('Approving this request would exceed the employee leave balance.');
  }
  writeAudit(auth, auth.organizationId, { action: `leave.${decision.toLowerCase()}d`, entityType: 'LeaveRequest', entityId: id, summary: { days: request.days } });
  notifyUsers(auth.organizationId, [userIdForEmployee(request.employeeId)], {
    kind: decision === 'APPROVE' ? 'leave.approved' : 'leave.rejected',
    title: decision === 'APPROVE' ? 'Leave approved' : 'Leave not approved',
    body: `Your ${type.name} from ${request.startDate} was ${decision === 'APPROVE' ? 'approved' : 'rejected'} by ${auth.name}.${comment ? ` Comment: ${comment}` : ''}`,
    link: '/leave',
  });
  return { id, status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
}

export function cancelRequest(auth: AuthContext, id: string, reason: string) {
  if (!auth.employeeId) throw AppError.forbidden();
  const request = db.leaveRequests.get(id);
  if (!request || request.employeeId !== auth.employeeId || request.organizationId !== auth.organizationId) {
    throw AppError.notFound('Leave request not found.');
  }
  const today = todayIn(organizationOf(auth).timezone);
  const startsInFuture = request.startDate > today;

  let next: 'CANCELLED' | 'CANCEL_REQUESTED';
  if (request.status === 'PENDING') next = 'CANCELLED';
  else if (request.status === 'APPROVED' && startsInFuture) next = 'CANCEL_REQUESTED';
  else throw AppError.invalidState('This leave cannot be cancelled. Approved leave that has started needs HR review.');

  db.leaveRequests.update(id, { status: next, cancelReason: reason });
  writeAudit(auth, auth.organizationId, { action: 'leave.cancel_requested', entityType: 'LeaveRequest', entityId: id, summary: { next } });
  if (next === 'CANCEL_REQUESTED') {
    const approver = managerUserIdFor(auth.employeeId);
    notifyUsers(auth.organizationId, approver ? [approver] : hrUserIds(auth.organizationId), {
      kind: 'leave.cancel_requested',
      title: 'Leave cancellation to review',
      body: `${auth.name} asked to cancel approved leave from ${request.startDate}.`,
      link: '/leave',
    });
  }
  return { id, status: next };
}

export function decideCancellation(auth: AuthContext, id: string, decision: 'APPROVE' | 'REJECT') {
  if (auth.role === 'EMPLOYEE') throw AppError.forbidden();
  const request = teamRequest(auth, id);
  if (request.employeeId === auth.employeeId) throw AppError.forbidden('You cannot decide on your own cancellation.');
  if (request.status !== 'CANCEL_REQUESTED') throw AppError.invalidState('There is no cancellation request for this leave.');
  const next = decision === 'APPROVE' ? 'CANCELLED' : 'APPROVED';
  db.leaveRequests.update(id, { status: next, deciderId: auth.userId, decidedAt: new Date().toISOString() });
  writeAudit(auth, auth.organizationId, { action: `leave.cancellation_${decision.toLowerCase()}d`, entityType: 'LeaveRequest', entityId: id });
  notifyUsers(auth.organizationId, [userIdForEmployee(request.employeeId)], {
    kind: 'leave.cancellation_decided',
    title: decision === 'APPROVE' ? 'Leave cancelled' : 'Leave cancellation declined',
    body:
      decision === 'APPROVE'
        ? `Your leave from ${request.startDate} was cancelled and the days returned to your balance.`
        : `Your leave from ${request.startDate} stays approved.`,
    link: '/leave',
  });
  return { id, status: next };
}

/** Team availability: everyone in scope with leave overlapping the month (pending and approved). */
export function availabilityCalendar(auth: AuthContext, year: number, month: number) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const from = `${year}-${pad(month)}-01`;
  const to = `${year}-${pad(month)}-${pad(last)}`;
  const scope = employeeScope(auth);
  const requests = db.leaveRequests
    .filter((r) => {
      if (r.organizationId !== auth.organizationId || !ACTIVE_STATUSES.includes(r.status) || r.startDate > to || r.endDate < from) return false;
      const e = db.employees.get(r.employeeId);
      return Boolean(e && scope(e));
    })
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  const holidays = db.holidays
    .filter((h) => h.organizationId === auth.organizationId && h.holidayDate >= from && h.holidayDate <= to)
    .sort((a, b) => a.holidayDate.localeCompare(b.holidayDate));
  return {
    from,
    to,
    holidays: holidays.map((h) => ({ date: h.holidayDate, name: h.name })),
    items: requests.map((r) => {
      const e = db.employees.get(r.employeeId)!;
      return {
        employee: fullName(e),
        department: db.departments.get(e.departmentId)?.name ?? '',
        leaveType: db.leaveTypes.get(r.leaveTypeId)?.code ?? '',
        status: r.status,
        startDate: r.startDate,
        endDate: r.endDate,
        days: r.days,
      };
    }),
  };
}
