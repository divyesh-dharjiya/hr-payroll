import type { Request } from 'express';
import { Prisma, type AttendanceStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import type { AuthContext } from '../../middleware/auth';
import { employeeScope } from '../employees/employees.service';
import { dateOnly, eachDay, minutesBetween, todayIn, weekdayOf, ymdOf } from '../../lib/time';
import { correctionTimeErrors, effectiveDayStatus, shiftWindow, summarizeDay, type AttendanceRules } from './attendance.rules';
import { hrUserIds, managerUserIdFor, notifyUsers, userIdForEmployee } from '../../lib/notify';

// ---------------------------------------------------------------------------------------------------------------
// Attendance service. Business rules live in attendance.rules.ts; this file handles persistence and scope.
// ---------------------------------------------------------------------------------------------------------------

export async function loadRules(orgId: string): Promise<AttendanceRules & { weeklyOffDays: number[] }> {
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
  return {
    timezone: org.timezone,
    shiftStart: org.shiftStart,
    shiftEnd: org.shiftEnd,
    graceMinutes: org.graceMinutes,
    standardBreakMinutes: org.standardBreakMinutes,
    breakDeductionAfterMinutes: org.breakDeductionAfterMinutes,
    weeklyOffDays: org.weeklyOffDays,
  };
}

function requireEmployeeProfile(auth: AuthContext): string {
  if (!auth.employeeId) {
    throw AppError.forbidden('Your account is not linked to an employee profile, so you cannot check in.');
  }
  return auth.employeeId;
}

const recordView = (
  r: {
    id: string;
    workDate: Date;
    status: AttendanceStatus;
    checkInAt: Date | null;
    checkOutAt: Date | null;
    breakMinutes: number;
    workedMinutes: number;
    lateMinutes: number;
    overtimeMinutes: number;
  },
  rules: AttendanceRules,
) => ({
  id: r.id,
  workDate: ymdOf(r.workDate),
  status: effectiveDayStatus(r.status, ymdOf(r.workDate), r.lateMinutes, rules),
  checkInAt: r.checkInAt?.toISOString() ?? null,
  checkOutAt: r.checkOutAt?.toISOString() ?? null,
  breakMinutes: r.breakMinutes,
  workedMinutes: r.workedMinutes,
  lateMinutes: r.lateMinutes,
  overtimeMinutes: r.overtimeMinutes,
});

// ---------------------------------------------------------------------------------------------------------------
// Punch in / punch out (many sessions per day)
// ---------------------------------------------------------------------------------------------------------------

/** An open session older than this is treated as a forgotten punch-out and closed at its day's shift end. */
const STALE_OPEN_HOURS = 16;
/** Two punches within this many seconds are almost always a double tap; the second is rejected. */
const PUNCH_COOLDOWN_SECONDS = 60;

type Tx = Prisma.TransactionClient;

export interface NonWorkingDay {
  kind: 'HOLIDAY' | 'WEEKLY_OFF';
  label: string;
}

/** Holidays and weekly offs are non-working days: punching in is not offered and is rejected by the API. */
export async function nonWorkingDay(orgId: string, workDate: string, weeklyOffDays: number[]): Promise<NonWorkingDay | null> {
  const holiday = await prisma.holiday.findUnique({
    where: { organizationId_holidayDate: { organizationId: orgId, holidayDate: dateOnly(workDate) } },
    select: { name: true },
  });
  if (holiday) return { kind: 'HOLIDAY', label: holiday.name };
  if (weeklyOffDays.includes(weekdayOf(workDate))) return { kind: 'WEEKLY_OFF', label: 'Weekly off' };
  return null;
}

/** Recomputes a day's totals from its punches and stores them on the attendance record. */
async function persistDay(tx: Tx, recordId: string, rules: AttendanceRules) {
  const record = await tx.attendanceRecord.findUniqueOrThrow({ where: { id: recordId }, select: { workDate: true } });
  const punches = await tx.attendancePunch.findMany({ where: { attendanceRecordId: recordId }, orderBy: { inAt: 'asc' } });
  const s = summarizeDay(punches, ymdOf(record.workDate), rules);
  await tx.attendanceRecord.update({
    where: { id: recordId },
    data: {
      checkInAt: s.firstInAt,
      checkOutAt: s.lastOutAt,
      breakMinutes: s.breakMinutes,
      workedMinutes: s.workedMinutes,
      lateMinutes: s.lateMinutes,
      overtimeMinutes: s.overtimeMinutes,
      status: punches.length ? s.status : 'PRESENT',
    },
  });
  return s;
}

async function recordForDay(tx: Tx, orgId: string, employeeId: string, workDate: string) {
  return tx.attendanceRecord.upsert({
    where: { employeeId_workDate: { employeeId, workDate: dateOnly(workDate) } },
    create: { organizationId: orgId, employeeId, workDate: dateOnly(workDate), status: 'PRESENT' },
    update: {},
  });
}

export async function getToday(auth: AuthContext) {
  const rules = await loadRules(auth.organizationId);
  const now = new Date();
  const workDate = todayIn(rules.timezone, now);
  const employeeId = auth.employeeId;
  const nonWorking = await nonWorkingDay(auth.organizationId, workDate, rules.weeklyOffDays);

  const record = employeeId
    ? await prisma.attendanceRecord.findUnique({
        where: { employeeId_workDate: { employeeId, workDate: dateOnly(workDate) } },
        include: { punches: { orderBy: { inAt: 'asc' } } },
      })
    : null;
  // An open session can belong to an earlier day (for example a night shift that crosses midnight).
  const openPunch = employeeId
    ? await prisma.attendancePunch.findFirst({ where: { employeeId, outAt: null }, select: { id: true, inAt: true } })
    : null;
  const summary = summarizeDay(record?.punches ?? [], workDate, rules);
  // While the shift is still running, a short day is "in progress", not yet a half day.
  const dayOver = now.getTime() >= shiftWindow(workDate, rules).end.getTime();
  const displayStatus = summary.isHalfDay && !dayOver ? (summary.lateMinutes > 0 ? 'LATE' : 'PRESENT') : summary.status;

  return {
    workDate,
    timezone: rules.timezone,
    shift: { start: rules.shiftStart, end: rules.shiftEnd, graceMinutes: rules.graceMinutes, standardBreakMinutes: rules.standardBreakMinutes },
    hasProfile: Boolean(employeeId),
    nonWorking,
    // Punching in is offered on working days; punching out is always allowed so an open session can be closed.
    canPunchIn: Boolean(employeeId) && !nonWorking && !openPunch,
    canPunchOut: Boolean(openPunch),
    openSince: openPunch?.inAt.toISOString() ?? null,
    punches: (record?.punches ?? []).map((p) => ({
      id: p.id,
      inAt: p.inAt.toISOString(),
      outAt: p.outAt?.toISOString() ?? null,
      autoClosed: p.autoClosed,
      minutes: p.outAt ? minutesBetween(p.inAt, p.outAt) : null,
    })),
    summary: {
      sessions: summary.sessions,
      punchedMinutes: summary.punchedMinutes,
      breakMinutes: summary.breakMinutes,
      autoBreakMinutes: summary.autoBreakMinutes,
      workedMinutes: summary.workedMinutes,
      lateMinutes: summary.lateMinutes,
      overtimeMinutes: summary.overtimeMinutes,
      status: record?.punches.length ? displayStatus : null,
      firstInAt: summary.firstInAt?.toISOString() ?? null,
      lastOutAt: summary.lastOutAt?.toISOString() ?? null,
    },
    record: record ? recordView(record, rules) : null,
    serverTime: now.toISOString(),
  };
}

/**
 * Toggles the employee's attendance: punches out of the open session if there is one, otherwise punches in.
 * Timestamps are server-generated. `expect` lets the legacy check-in / check-out endpoints insist on one direction.
 */
export async function punch(auth: AuthContext, req?: Request, expect?: 'in' | 'out') {
  const employeeId = requireEmployeeProfile(auth);
  const rules = await loadRules(auth.organizationId);
  const now = new Date();
  const workDate = todayIn(rules.timezone, now);
  const employee = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { status: true } });
  if (employee.status === 'EXITED') throw AppError.invalidState('Attendance is not available for exited employees.');

  let action: 'in' | 'out' = 'in';
  let recordId = '';
  try {
    await prisma.$transaction(async (tx) => {
      let open = await tx.attendancePunch.findFirst({ where: { employeeId, outAt: null }, include: { record: { select: { workDate: true } } } });

      // Double-tap protection: ignore a second punch within the cooldown window.
      const lastEvent = await tx.attendancePunch.findFirst({ where: { employeeId }, orderBy: { inAt: 'desc' }, select: { inAt: true, outAt: true } });
      const lastAt = lastEvent ? Math.max(lastEvent.inAt.getTime(), lastEvent.outAt?.getTime() ?? 0) : 0;
      if (lastAt && now.getTime() - lastAt < PUNCH_COOLDOWN_SECONDS * 1000) {
        throw AppError.invalidState('You punched less than a minute ago. Wait a moment before punching again.');
      }

      // A forgotten punch-out from an earlier day is closed at that day's shift end, then a new session starts.
      if (open && now.getTime() - open.inAt.getTime() > STALE_OPEN_HOURS * 3_600_000) {
        const { end } = shiftWindow(ymdOf(open.record.workDate), rules);
        const closeAt = end.getTime() > open.inAt.getTime() ? end : new Date(open.inAt.getTime() + 60_000);
        await tx.attendancePunch.update({ where: { id: open.id }, data: { outAt: closeAt, autoClosed: true } });
        await persistDay(tx, open.attendanceRecordId, rules);
        open = null;
      }

      if (open) {
        if (expect === 'in') throw AppError.conflict('You are already punched in. Punch out first.');
        const closed = await tx.attendancePunch.updateMany({ where: { id: open.id, outAt: null }, data: { outAt: now } });
        if (closed.count === 0) throw AppError.conflict('This session was already closed. Refresh and try again.');
        action = 'out';
        recordId = open.attendanceRecordId;
        await persistDay(tx, recordId, rules);
        return;
      }

      if (expect === 'out') throw AppError.invalidState('You are not punched in.');
      const nonWorking = await nonWorkingDay(auth.organizationId, workDate, rules.weeklyOffDays);
      if (nonWorking) {
        throw AppError.invalidState(
          nonWorking.kind === 'HOLIDAY'
            ? `Today is a company holiday (${nonWorking.label}). Punching in is not available.`
            : 'Today is a weekly off. Punching in is not available.',
        );
      }
      const record = await recordForDay(tx, auth.organizationId, employeeId, workDate);
      await tx.attendancePunch.create({ data: { organizationId: auth.organizationId, employeeId, attendanceRecordId: record.id, inAt: now } });
      action = 'in';
      recordId = record.id;
      await persistDay(tx, recordId, rules);
    });
  } catch (err) {
    // The partial unique index allows one open session per employee; a concurrent second punch-in lands here.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw AppError.conflict('You are already punched in.');
    }
    throw err;
  }

  await writeAudit(auth, auth.organizationId, { action: `attendance.punch_${action}`, entityType: 'AttendanceRecord', entityId: recordId, summary: { workDate } }, req);
  return { action, today: await getToday(auth) };
}

/** Legacy endpoints kept for API compatibility: they behave like a punch in a fixed direction. */
export async function checkIn(auth: AuthContext, req?: Request) {
  return (await punch(auth, req, 'in')).today;
}

export async function checkOut(auth: AuthContext, req?: Request) {
  return (await punch(auth, req, 'out')).today;
}

// ---------------------------------------------------------------------------------------------------------------
// Derived daily statuses: one shared function used by the calendar, monthly summaries and payroll so they agree.
// ---------------------------------------------------------------------------------------------------------------
export interface DailyStatus {
  date: string;
  status: AttendanceStatus | 'NOT_EMPLOYED' | 'FUTURE' | 'ABSENT';
  /** Approved leave on this day. A half-day leave can sit on a worked day (status HALF_DAY, PRESENT, ...). */
  leave?: { leaveTypeCode: string; isPaid: boolean; days: number };
  /** Half-day leave on a past day with no attendance at all: the other half was not worked either. */
  absentOtherHalf?: boolean;
  workedMinutes?: number;
  lateMinutes?: number;
  overtimeMinutes?: number;
}

export async function dailyStatusesFor(
  employeeId: string,
  from: string,
  to: string,
  orgId: string,
): Promise<DailyStatus[]> {
  const [employee, rules, records, holidays, leaves] = await Promise.all([
    prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { joiningDate: true, exitDate: true } }),
    loadRules(orgId),
    prisma.attendanceRecord.findMany({
      where: { employeeId, workDate: { gte: dateOnly(from), lte: dateOnly(to) } },
    }),
    prisma.holiday.findMany({ where: { organizationId: orgId, holidayDate: { gte: dateOnly(from), lte: dateOnly(to) } } }),
    prisma.leaveRequest.findMany({
      where: {
        employeeId,
        status: 'APPROVED',
        startDate: { lte: dateOnly(to) },
        endDate: { gte: dateOnly(from) },
      },
      include: { leaveType: { select: { code: true, isPaid: true } } },
    }),
  ]);

  const recordByDate = new Map(records.map((r) => [ymdOf(r.workDate), r]));
  const holidaySet = new Set(holidays.map((h) => ymdOf(h.holidayDate)));
  const today = todayIn(rules.timezone);
  const joining = ymdOf(employee.joiningDate);
  const exiting = employee.exitDate ? ymdOf(employee.exitDate) : null;

  return eachDay(from, to).map((date): DailyStatus => {
    if (date < joining || (exiting && date > exiting)) return { date, status: 'NOT_EMPLOYED' };
    const record = recordByDate.get(date);
    const leave = leaves.find((l) => date >= ymdOf(l.startDate) && date <= ymdOf(l.endDate));
    const leaveInfo = leave
      ? { leaveTypeCode: leave.leaveType.code, isPaid: leave.leaveType.isPaid, days: leave.isHalfDay ? 0.5 : 1 }
      : undefined;
    if (record) {
      return {
        date,
        status: effectiveDayStatus(record.status, date, record.lateMinutes, rules),
        // Half-day leave plus a worked half: the leave covers the half that was not worked.
        ...(leaveInfo?.days === 0.5 ? { leave: leaveInfo } : {}),
        workedMinutes: record.workedMinutes,
        lateMinutes: record.lateMinutes,
        overtimeMinutes: record.overtimeMinutes,
      };
    }
    if (holidaySet.has(date)) return { date, status: 'HOLIDAY' };
    if (rules.weeklyOffDays.includes(weekdayOf(date))) return { date, status: 'WEEKLY_OFF' };
    if (leaveInfo) {
      return { date, status: 'ON_LEAVE', leave: leaveInfo, ...(leaveInfo.days === 0.5 && date < today ? { absentOtherHalf: true } : {}) };
    }
    // Today stays pending until the day closes; absence is only inferred for past working days.
    if (date >= today) return { date, status: 'FUTURE' };
    return { date, status: 'ABSENT' };
  });
}

export async function monthCalendar(auth: AuthContext, employeeId: string, year: number, month: number) {
  const emp = await prisma.employee.findFirst({
    where: { AND: [employeeScope(auth), { id: employeeId }] },
    select: { id: true, firstName: true, lastName: true },
  });
  if (!emp) throw AppError.notFound('Employee not found.');
  const pad = (n: number) => String(n).padStart(2, '0');
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days = await dailyStatusesFor(employeeId, `${year}-${pad(month)}-01`, `${year}-${pad(month)}-${pad(last)}`, auth.organizationId);
  const counts: Record<string, number> = {};
  for (const d of days) counts[d.status] = (counts[d.status] ?? 0) + 1;
  return {
    employee: { id: emp.id, name: `${emp.firstName} ${emp.lastName}` },
    year,
    month,
    days,
    counts,
    totals: {
      workedMinutes: days.reduce((s, d) => s + (d.workedMinutes ?? 0), 0),
      lateMinutes: days.reduce((s, d) => s + (d.lateMinutes ?? 0), 0),
      overtimeMinutes: days.reduce((s, d) => s + (d.overtimeMinutes ?? 0), 0),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------------------------------------------
export interface CorrectionInput {
  workDate: string;
  requestedCheckIn?: string;
  requestedCheckOut?: string;
  reason: string;
}

export async function requestCorrection(auth: AuthContext, input: CorrectionInput, req?: Request) {
  const employeeId = requireEmployeeProfile(auth);
  const rules = await loadRules(auth.organizationId);
  const today = todayIn(rules.timezone);
  const minDate = ymdOf(new Date(Date.parse(`${today}T00:00:00Z`) - 31 * 86_400_000));
  if (input.workDate > today || input.workDate < minDate) {
    throw AppError.badRequest('Corrections can be requested for the last 31 days only.', [{ field: 'workDate', message: 'Choose a date within the last 31 days.' }]);
  }
  if (!input.requestedCheckIn && !input.requestedCheckOut) {
    throw AppError.badRequest('Enter a check-in or check-out time to correct.');
  }
  const checkIn = input.requestedCheckIn ? new Date(input.requestedCheckIn) : null;
  const checkOut = input.requestedCheckOut ? new Date(input.requestedCheckOut) : null;
  if (checkIn && checkOut && checkOut <= checkIn) {
    throw AppError.badRequest('Check-out must be after check-in.', [{ field: 'requestedCheckOut', message: 'Check-out must be after check-in.' }]);
  }
  const timeErrors = correctionTimeErrors(input.workDate, checkIn, checkOut, rules);
  if (timeErrors.length) throw AppError.badRequest(timeErrors[0].message, timeErrors);
  if (!checkIn || !checkOut) {
    const punches = await prisma.attendancePunch.count({ where: { employeeId, record: { workDate: dateOnly(input.workDate) } } });
    if (punches === 0) {
      throw AppError.badRequest('There are no punches on this day. Enter both the check-in and check-out time.', [
        { field: checkIn ? 'requestedCheckOut' : 'requestedCheckIn', message: 'Required for a day without punches.' },
      ]);
    }
  }
  const pending = await prisma.attendanceCorrection.findFirst({
    where: { employeeId, workDate: dateOnly(input.workDate), status: 'PENDING' },
  });
  if (pending) throw AppError.conflict('A correction for this day is already waiting for approval.');

  const row = await prisma.attendanceCorrection.create({
    data: {
      organizationId: auth.organizationId,
      employeeId,
      workDate: dateOnly(input.workDate),
      requestedCheckIn: checkIn,
      requestedCheckOut: checkOut,
      reason: input.reason,
    },
  });
  await writeAudit(auth, auth.organizationId, { action: 'attendance.correction_requested', entityType: 'AttendanceCorrection', entityId: row.id, summary: { workDate: input.workDate } }, req);
  const approver = await managerUserIdFor(employeeId);
  await notifyUsers(auth.organizationId, approver ? [approver] : await hrUserIds(auth.organizationId), {
    kind: 'attendance.correction_requested',
    title: 'Attendance correction to review',
    body: `${auth.name} asked to correct attendance for ${input.workDate}.`,
    link: '/attendance',
  });
  return { id: row.id, status: row.status };
}

/**
 * Applies an approved correction to the day's punches:
 *  - both times given: the day is replaced by one session from check-in to check-out;
 *  - only check-in: the first session's start moves;
 *  - only check-out: the last session's end moves (closing it if it was still open).
 */
async function applyCorrection(
  tx: Tx,
  orgId: string,
  c: { employeeId: string; workDate: Date; requestedCheckIn: Date | null; requestedCheckOut: Date | null },
  rules: AttendanceRules,
) {
  const record = await recordForDay(tx, orgId, c.employeeId, ymdOf(c.workDate));
  const punches = await tx.attendancePunch.findMany({ where: { attendanceRecordId: record.id }, orderBy: { inAt: 'asc' } });

  if (c.requestedCheckIn && c.requestedCheckOut) {
    await tx.attendancePunch.deleteMany({ where: { attendanceRecordId: record.id } });
    await tx.attendancePunch.create({
      data: { organizationId: orgId, employeeId: c.employeeId, attendanceRecordId: record.id, inAt: c.requestedCheckIn, outAt: c.requestedCheckOut },
    });
  } else if (punches.length === 0) {
    throw AppError.invalidState('This day has no punches, so the correction needs both a check-in and a check-out time.');
  } else if (c.requestedCheckIn) {
    const first = punches[0];
    if (first.outAt && c.requestedCheckIn >= first.outAt) throw AppError.invalidState('The corrected check-in is after the first punch-out.');
    await tx.attendancePunch.update({ where: { id: first.id }, data: { inAt: c.requestedCheckIn } });
  } else if (c.requestedCheckOut) {
    const last = punches[punches.length - 1];
    if (c.requestedCheckOut <= last.inAt) throw AppError.invalidState('The corrected check-out is before the last punch-in.');
    await tx.attendancePunch.update({ where: { id: last.id }, data: { outAt: c.requestedCheckOut, autoClosed: false } });
  }
  await persistDay(tx, record.id, rules);
}

export async function listCorrections(auth: AuthContext, status?: 'PENDING' | 'APPROVED' | 'REJECTED') {
  const rows = await prisma.attendanceCorrection.findMany({
    where: {
      organizationId: auth.organizationId,
      ...(status ? { status } : {}),
      employee: employeeScope(auth),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { employee: { select: { firstName: true, lastName: true, employeeCode: true } } },
  });
  return rows.map((c) => ({
    id: c.id,
    employee: { name: `${c.employee.firstName} ${c.employee.lastName}`, employeeCode: c.employee.employeeCode },
    workDate: ymdOf(c.workDate),
    requestedCheckIn: c.requestedCheckIn?.toISOString() ?? null,
    requestedCheckOut: c.requestedCheckOut?.toISOString() ?? null,
    reason: c.reason,
    status: c.status,
    reviewComment: c.reviewComment,
    createdAt: c.createdAt.toISOString(),
  }));
}

export async function reviewCorrection(
  auth: AuthContext,
  id: string,
  decision: 'APPROVE' | 'REJECT',
  comment: string | undefined,
  req?: Request,
) {
  const correction = await prisma.attendanceCorrection.findFirst({
    where: { id, organizationId: auth.organizationId, employee: employeeScope(auth) },
    include: { employee: { select: { managerId: true } } },
  });
  if (!correction) throw AppError.notFound('Correction request not found.');
  // Managers may review only their direct reports; HR may review everyone (scope already applied above).
  if (auth.role === 'EMPLOYEE') throw AppError.forbidden();
  if (correction.status !== 'PENDING') throw AppError.invalidState('This request has already been reviewed.');
  if (auth.employeeId && correction.employeeId === auth.employeeId) {
    throw AppError.forbidden('You cannot review your own correction request.');
  }

  const rules = await loadRules(auth.organizationId);
  await prisma.$transaction(async (tx) => {
    // Claim the request first so two reviewers cannot both approve it.
    const claimed = await tx.attendanceCorrection.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
        reviewerId: auth.userId,
        reviewComment: comment,
        reviewedAt: new Date(),
      },
    });
    if (claimed.count === 0) throw AppError.invalidState('This request has already been reviewed.');

    if (decision === 'APPROVE') {
      await applyCorrection(tx, auth.organizationId, correction, rules);
    }
    await writeAudit(auth, auth.organizationId, { action: `attendance.correction_${decision.toLowerCase()}d`, entityType: 'AttendanceCorrection', entityId: id, summary: { workDate: ymdOf(correction.workDate) } }, req, tx);
  });
  await notifyUsers(auth.organizationId, [await userIdForEmployee(correction.employeeId)], {
    kind: 'attendance.correction_reviewed',
    title: decision === 'APPROVE' ? 'Attendance correction approved' : 'Attendance correction rejected',
    body: `Your correction for ${ymdOf(correction.workDate)} was ${decision === 'APPROVE' ? 'approved' : 'rejected'}.${comment ? ` Comment: ${comment}` : ''}`,
    link: '/attendance',
  });
  return { id, status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
}

// ---------------------------------------------------------------------------------------------------------------
// Records list (scoped) and monthly summary
// ---------------------------------------------------------------------------------------------------------------
export async function listRecords(auth: AuthContext, from: string, to: string, employeeId?: string) {
  const rules = await loadRules(auth.organizationId);
  const rows = await prisma.attendanceRecord.findMany({
    where: {
      workDate: { gte: dateOnly(from), lte: dateOnly(to) },
      ...(employeeId ? { employeeId } : {}),
      employee: employeeScope(auth),
    },
    orderBy: [{ workDate: 'desc' }],
    take: 1000,
    include: { employee: { select: { firstName: true, lastName: true, employeeCode: true } } },
  });
  return rows.map((r) => ({
    ...recordView(r, rules),
    employee: { name: `${r.employee.firstName} ${r.employee.lastName}`, employeeCode: r.employee.employeeCode },
  }));
}

export async function monthlySummary(auth: AuthContext, year: number, month: number) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const from = `${year}-${pad(month)}-01`;
  const to = `${year}-${pad(month)}-${pad(last)}`;
  const employees = await prisma.employee.findMany({
    where: { AND: [employeeScope(auth), { status: { not: 'EXITED' } }] },
    select: { id: true, employeeCode: true, firstName: true, lastName: true },
    orderBy: { firstName: 'asc' },
    take: 500,
  });
  const rows = [];
  for (const e of employees) {
    const days = await dailyStatusesFor(e.id, from, to, auth.organizationId);
    const count = (s: string) => days.filter((d) => d.status === s).length;
    rows.push({
      employee: { id: e.id, employeeCode: e.employeeCode, name: `${e.firstName} ${e.lastName}` },
      present: count('PRESENT') + count('WFH'),
      late: count('LATE'),
      halfDay: count('HALF_DAY'),
      absent: count('ABSENT'),
      onLeave: count('ON_LEAVE'),
      holiday: count('HOLIDAY') + count('WEEKLY_OFF'),
      workedHours: Number((days.reduce((s, d) => s + (d.workedMinutes ?? 0), 0) / 60).toFixed(2)),
      overtimeHours: Number((days.reduce((s, d) => s + (d.overtimeMinutes ?? 0), 0) / 60).toFixed(2)),
      lateMinutes: days.reduce((s, d) => s + (d.lateMinutes ?? 0), 0),
    });
  }
  return { year, month, from, to, rows };
}
