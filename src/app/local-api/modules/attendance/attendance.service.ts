import { db } from '../../db';
import type { AttendancePunch, AttendanceRecord, AttendanceStatus } from '../../db/schema';
import { AppError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { addDays, eachDay, minutesBetween, todayIn, weekdayOf, zonedTimeToUtc } from '../../lib/time';
import { hrUserIds, managerUserIdFor, notifyUsers, userIdForEmployee } from '../../lib/notify';
import type { AuthContext } from '../../security/session';
import { employeeScope, fullName, organizationOf, teamScope } from '../employees/employees.service';
import {
  correctionTimeErrors,
  effectiveDayStatus,
  overtimeAfterRecalc,
  shiftWindow,
  summarizeDay,
  type AttendanceRules,
  type PunchSession,
} from './attendance.rules';

// ---------------------------------------------------------------------------------------------------------------
// Attendance service. Business rules live in attendance.rules.ts; this file handles storage and scope.
// ---------------------------------------------------------------------------------------------------------------

export function loadRules(orgId: string): AttendanceRules & { weeklyOffDays: number[] } {
  const org = organizationOf({ organizationId: orgId });
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

const toSession = (p: AttendancePunch): PunchSession => ({ inAt: new Date(p.inAt), outAt: p.outAt ? new Date(p.outAt) : null });
const iso = (d: Date | null) => d?.toISOString() ?? null;

const recordView = (r: AttendanceRecord, rules: AttendanceRules) => ({
  id: r.id,
  workDate: r.workDate,
  status: effectiveDayStatus(r.status, r.workDate, r.lateMinutes, rules),
  checkInAt: r.checkInAt,
  checkOutAt: r.checkOutAt,
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

export interface NonWorkingDay {
  kind: 'HOLIDAY' | 'WEEKLY_OFF';
  label: string;
}

/** Holidays and weekly offs are non-working days: punching in is not offered and is rejected by the API. */
export function nonWorkingDay(orgId: string, workDate: string, weeklyOffDays: number[]): NonWorkingDay | null {
  const holiday = db.holidays.find((h) => h.organizationId === orgId && h.holidayDate === workDate);
  if (holiday) return { kind: 'HOLIDAY', label: holiday.name };
  if (weeklyOffDays.includes(weekdayOf(workDate))) return { kind: 'WEEKLY_OFF', label: 'Weekly off' };
  return null;
}

function punchesOfRecord(recordId: string): AttendancePunch[] {
  return db.attendancePunches.by('attendanceRecordId', recordId).sort((a, b) => a.inAt.localeCompare(b.inAt));
}

function openPunchOf(employeeId: string): AttendancePunch | undefined {
  return db.attendancePunches.by('employeeId', employeeId).find((p) => p.outAt === null);
}

/** Recomputes a day's totals from its punches and stores them on the attendance record. */
function persistDay(recordId: string, rules: AttendanceRules) {
  const record = db.attendanceRecords.get(recordId)!;
  const punches = punchesOfRecord(recordId);
  const s = summarizeDay(punches.map(toSession), record.workDate, rules);
  const overtime = overtimeAfterRecalc(
    { status: record.overtimeStatus, approvedMinutes: record.overtimeApprovedMinutes, overtimeMinutes: record.overtimeMinutes },
    s.overtimeMinutes,
  );
  const decisionKept = overtime.status === record.overtimeStatus && overtime.status !== 'PENDING' && overtime.status !== 'NONE';
  db.attendanceRecords.update(recordId, {
    checkInAt: iso(s.firstInAt),
    checkOutAt: iso(s.lastOutAt),
    breakMinutes: s.breakMinutes,
    workedMinutes: s.workedMinutes,
    lateMinutes: s.lateMinutes,
    overtimeMinutes: s.overtimeMinutes,
    overtimeStatus: overtime.status,
    overtimeApprovedMinutes: overtime.approvedMinutes,
    ...(decisionKept ? {} : { overtimeReviewerId: null, overtimeReviewedAt: null, overtimeComment: null }),
    status: punches.length ? s.status : 'PRESENT',
  });
  return s;
}

function recordFor(employeeId: string, workDate: string): AttendanceRecord | undefined {
  return db.attendanceRecords.by('employeeId', employeeId).find((r) => r.workDate === workDate);
}

function recordForDay(orgId: string, employeeId: string, workDate: string): AttendanceRecord {
  return recordFor(employeeId, workDate) ?? db.attendanceRecords.insert({ organizationId: orgId, employeeId, workDate, status: 'PRESENT' });
}

export function getToday(auth: AuthContext) {
  const rules = loadRules(auth.organizationId);
  const now = new Date();
  const workDate = todayIn(rules.timezone, now);
  const employeeId = auth.employeeId;
  const nonWorking = nonWorkingDay(auth.organizationId, workDate, rules.weeklyOffDays);

  const record = employeeId ? recordFor(employeeId, workDate) : undefined;
  const punches = record ? punchesOfRecord(record.id) : [];
  // An open session can belong to an earlier day (for example a night shift that crosses midnight).
  const openPunch = employeeId ? openPunchOf(employeeId) : undefined;
  const summary = summarizeDay(punches.map(toSession), workDate, rules);
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
    openSince: openPunch?.inAt ?? null,
    punches: punches.map((p) => ({
      id: p.id,
      inAt: p.inAt,
      outAt: p.outAt,
      autoClosed: p.autoClosed,
      minutes: p.outAt ? minutesBetween(new Date(p.inAt), new Date(p.outAt)) : null,
    })),
    summary: {
      sessions: summary.sessions,
      punchedMinutes: summary.punchedMinutes,
      breakMinutes: summary.breakMinutes,
      autoBreakMinutes: summary.autoBreakMinutes,
      workedMinutes: summary.workedMinutes,
      lateMinutes: summary.lateMinutes,
      overtimeMinutes: summary.overtimeMinutes,
      status: punches.length ? displayStatus : null,
      firstInAt: iso(summary.firstInAt),
      lastOutAt: iso(summary.lastOutAt),
    },
    record: record ? recordView(db.attendanceRecords.get(record.id)!, rules) : null,
    serverTime: now.toISOString(),
  };
}

/**
 * Toggles the employee's attendance: punches out of the open session if there is one, otherwise punches in.
 * Timestamps are generated here, never sent by the screen. `expect` lets the check-in / check-out endpoints insist
 * on one direction.
 */
export function punch(auth: AuthContext, expect?: 'in' | 'out') {
  const employeeId = requireEmployeeProfile(auth);
  const rules = loadRules(auth.organizationId);
  const now = new Date();
  const workDate = todayIn(rules.timezone, now);
  const employee = db.employees.get(employeeId);
  if (!employee) throw AppError.notFound('Employee not found.');
  if (employee.status === 'EXITED') throw AppError.invalidState('Attendance is not available for exited employees.');

  let open = openPunchOf(employeeId);

  // Double-tap protection: ignore a second punch within the cooldown window.
  const lastAt = Math.max(0, ...db.attendancePunches.by('employeeId', employeeId).map((p) => Math.max(Date.parse(p.inAt), p.outAt ? Date.parse(p.outAt) : 0)));
  if (lastAt && now.getTime() - lastAt < PUNCH_COOLDOWN_SECONDS * 1000) {
    throw AppError.invalidState('You punched less than a minute ago. Wait a moment before punching again.');
  }

  // A forgotten punch-out from an earlier day is closed at that day's shift end, then a new session starts.
  if (open && now.getTime() - Date.parse(open.inAt) > STALE_OPEN_HOURS * 3_600_000) {
    const openDay = db.attendanceRecords.get(open.attendanceRecordId)!.workDate;
    const { end } = shiftWindow(openDay, rules);
    const closeAt = end.getTime() > Date.parse(open.inAt) ? end : new Date(Date.parse(open.inAt) + 60_000);
    db.attendancePunches.update(open.id, { outAt: closeAt.toISOString(), autoClosed: true });
    persistDay(open.attendanceRecordId, rules);
    open = undefined;
  }

  let action: 'in' | 'out';
  let recordId: string;
  if (open) {
    if (expect === 'in') throw AppError.conflict('You are already punched in. Punch out first.');
    db.attendancePunches.update(open.id, { outAt: now.toISOString() });
    action = 'out';
    recordId = open.attendanceRecordId;
  } else {
    if (expect === 'out') throw AppError.invalidState('You are not punched in.');
    const nonWorking = nonWorkingDay(auth.organizationId, workDate, rules.weeklyOffDays);
    if (nonWorking) {
      throw AppError.invalidState(
        nonWorking.kind === 'HOLIDAY'
          ? `Today is a company holiday (${nonWorking.label}). Punching in is not available.`
          : 'Today is a weekly off. Punching in is not available.',
      );
    }
    const record = recordForDay(auth.organizationId, employeeId, workDate);
    db.attendancePunches.insert({ organizationId: auth.organizationId, employeeId, attendanceRecordId: record.id, inAt: now.toISOString() });
    action = 'in';
    recordId = record.id;
  }
  persistDay(recordId, rules);

  writeAudit(auth, auth.organizationId, { action: `attendance.punch_${action}`, entityType: 'AttendanceRecord', entityId: recordId, summary: { workDate } });
  return { action, today: getToday(auth) };
}

export function checkIn(auth: AuthContext) {
  return punch(auth, 'in').today;
}

export function checkOut(auth: AuthContext) {
  return punch(auth, 'out').today;
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
  /** Overtime approved for payment (see the overtime approval workflow). */
  overtimeApprovedMinutes?: number;
  overtimeStatus?: string;
}

export function dailyStatusesFor(employeeId: string, from: string, to: string, orgId: string): DailyStatus[] {
  const employee = db.employees.get(employeeId);
  if (!employee) throw AppError.notFound('Employee not found.');
  const rules = loadRules(orgId);
  const recordByDate = new Map(
    db.attendanceRecords
      .by('employeeId', employeeId)
      .filter((r) => r.workDate >= from && r.workDate <= to)
      .map((r) => [r.workDate, r]),
  );
  const holidaySet = new Set(
    db.holidays.filter((h) => h.organizationId === orgId && h.holidayDate >= from && h.holidayDate <= to).map((h) => h.holidayDate),
  );
  const leaves = db.leaveRequests
    .by('employeeId', employeeId)
    .filter((l) => l.status === 'APPROVED' && l.startDate <= to && l.endDate >= from)
    .map((l) => ({ ...l, leaveType: db.leaveTypes.get(l.leaveTypeId)! }));
  const today = todayIn(rules.timezone);
  const joining = employee.joiningDate;
  const exiting = employee.exitDate;

  return eachDay(from, to).map((date): DailyStatus => {
    if (date < joining || (exiting && date > exiting)) return { date, status: 'NOT_EMPLOYED' };
    const record = recordByDate.get(date);
    const leave = leaves.find((l) => date >= l.startDate && date <= l.endDate);
    const leaveInfo = leave ? { leaveTypeCode: leave.leaveType.code, isPaid: leave.leaveType.isPaid, days: leave.isHalfDay ? 0.5 : 1 } : undefined;
    if (record) {
      return {
        date,
        status: effectiveDayStatus(record.status, date, record.lateMinutes, rules),
        // Half-day leave plus a worked half: the leave covers the half that was not worked.
        ...(leaveInfo?.days === 0.5 ? { leave: leaveInfo } : {}),
        workedMinutes: record.workedMinutes,
        lateMinutes: record.lateMinutes,
        overtimeMinutes: record.overtimeMinutes,
        overtimeApprovedMinutes: record.overtimeApprovedMinutes,
        overtimeStatus: record.overtimeStatus,
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

export function monthCalendar(auth: AuthContext, employeeId: string, year: number, month: number) {
  const emp = db.employees.get(employeeId);
  if (!emp || !employeeScope(auth)(emp)) throw AppError.notFound('Employee not found.');
  const pad = (n: number) => String(n).padStart(2, '0');
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days = dailyStatusesFor(employeeId, `${year}-${pad(month)}-01`, `${year}-${pad(month)}-${pad(last)}`, auth.organizationId);
  const counts: Record<string, number> = {};
  for (const d of days) counts[d.status] = (counts[d.status] ?? 0) + 1;
  return {
    employee: { id: emp.id, name: fullName(emp) },
    year,
    month,
    days,
    counts,
    totals: {
      workedMinutes: days.reduce((s, d) => s + (d.workedMinutes ?? 0), 0),
      lateMinutes: days.reduce((s, d) => s + (d.lateMinutes ?? 0), 0),
      overtimeMinutes: days.reduce((s, d) => s + (d.overtimeMinutes ?? 0), 0),
      overtimeApprovedMinutes: days.reduce((s, d) => s + (d.overtimeApprovedMinutes ?? 0), 0),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------------------------------------------
/** Parses an instant with an offset as is, and a wall-clock time without one in the organization timezone. */
function orgInstant(value: string, timeZone: string): Date {
  const local = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?$/.exec(value);
  return local ? zonedTimeToUtc(local[1], local[2], timeZone) : new Date(value);
}

export interface CorrectionInput {
  workDate: string;
  requestedCheckIn?: string;
  requestedCheckOut?: string;
  reason: string;
}

export function requestCorrection(auth: AuthContext, input: CorrectionInput) {
  const employeeId = requireEmployeeProfile(auth);
  const rules = loadRules(auth.organizationId);
  const today = todayIn(rules.timezone);
  const minDate = addDays(today, -31);
  if (input.workDate > today || input.workDate < minDate) {
    throw AppError.badRequest('Corrections can be requested for the last 31 days only.', [{ field: 'workDate', message: 'Choose a date within the last 31 days.' }]);
  }
  if (!input.requestedCheckIn && !input.requestedCheckOut) {
    throw AppError.badRequest('Enter a check-in or check-out time to correct.');
  }
  const checkIn = input.requestedCheckIn ? orgInstant(input.requestedCheckIn, rules.timezone) : null;
  const checkOut = input.requestedCheckOut ? orgInstant(input.requestedCheckOut, rules.timezone) : null;
  if (checkIn && checkOut && checkOut <= checkIn) {
    throw AppError.badRequest('Check-out must be after check-in.', [{ field: 'requestedCheckOut', message: 'Check-out must be after check-in.' }]);
  }
  const timeErrors = correctionTimeErrors(input.workDate, checkIn, checkOut, rules);
  if (timeErrors.length) throw AppError.badRequest(timeErrors[0].message, timeErrors);
  if (!checkIn || !checkOut) {
    const record = recordFor(employeeId, input.workDate);
    const punches = record ? db.attendancePunches.by('attendanceRecordId', record.id).length : 0;
    if (punches === 0) {
      throw AppError.badRequest('There are no punches on this day. Enter both the check-in and check-out time.', [
        { field: checkIn ? 'requestedCheckOut' : 'requestedCheckIn', message: 'Required for a day without punches.' },
      ]);
    }
  }
  const pending = db.attendanceCorrections.by('employeeId', employeeId).find((c) => c.workDate === input.workDate && c.status === 'PENDING');
  if (pending) throw AppError.conflict('A correction for this day is already waiting for approval.');

  const row = db.attendanceCorrections.insert({
    organizationId: auth.organizationId,
    employeeId,
    workDate: input.workDate,
    requestedCheckIn: iso(checkIn),
    requestedCheckOut: iso(checkOut),
    reason: input.reason,
  });
  writeAudit(auth, auth.organizationId, { action: 'attendance.correction_requested', entityType: 'AttendanceCorrection', entityId: row.id, summary: { workDate: input.workDate } });
  const approver = managerUserIdFor(employeeId);
  notifyUsers(auth.organizationId, approver ? [approver] : hrUserIds(auth.organizationId), {
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
function applyCorrection(
  orgId: string,
  c: { employeeId: string; workDate: string; requestedCheckIn: string | null; requestedCheckOut: string | null },
  rules: AttendanceRules,
) {
  const record = recordForDay(orgId, c.employeeId, c.workDate);
  const punches = punchesOfRecord(record.id);

  if (c.requestedCheckIn && c.requestedCheckOut) {
    db.attendancePunches.deleteWhere((p) => p.attendanceRecordId === record.id);
    db.attendancePunches.insert({ organizationId: orgId, employeeId: c.employeeId, attendanceRecordId: record.id, inAt: c.requestedCheckIn, outAt: c.requestedCheckOut });
  } else if (punches.length === 0) {
    throw AppError.invalidState('This day has no punches, so the correction needs both a check-in and a check-out time.');
  } else if (c.requestedCheckIn) {
    const first = punches[0];
    if (first.outAt && Date.parse(c.requestedCheckIn) >= Date.parse(first.outAt)) throw AppError.invalidState('The corrected check-in is after the first punch-out.');
    db.attendancePunches.update(first.id, { inAt: c.requestedCheckIn });
  } else if (c.requestedCheckOut) {
    const last = punches[punches.length - 1];
    if (Date.parse(c.requestedCheckOut) <= Date.parse(last.inAt)) throw AppError.invalidState('The corrected check-out is before the last punch-in.');
    db.attendancePunches.update(last.id, { outAt: c.requestedCheckOut, autoClosed: false });
  }
  persistDay(record.id, rules);
}

/** Employee filter for list endpoints: `mine` is the caller only; otherwise their team, without their own rows. */
function listScope(auth: AuthContext, mine: boolean) {
  if (mine) return (employeeId: string) => employeeId === auth.employeeId;
  const team = teamScope(auth);
  return (employeeId: string) => {
    const e = db.employees.get(employeeId);
    return Boolean(e && team(e) && e.id !== auth.employeeId);
  };
}

/** `mine`: the caller's own requests. Otherwise the review queue: the caller's team, without their own requests. */
export function listCorrections(auth: AuthContext, status?: 'PENDING' | 'APPROVED' | 'REJECTED', mine = false) {
  const allowed = listScope(auth, mine);
  return db.attendanceCorrections
    .filter((c) => c.organizationId === auth.organizationId && (!status || c.status === status) && allowed(c.employeeId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 200)
    .map((c) => {
      const e = db.employees.get(c.employeeId)!;
      return {
        id: c.id,
        employee: { name: fullName(e), employeeCode: e.employeeCode },
        workDate: c.workDate,
        requestedCheckIn: c.requestedCheckIn,
        requestedCheckOut: c.requestedCheckOut,
        reason: c.reason,
        status: c.status,
        reviewComment: c.reviewComment,
        createdAt: c.createdAt,
      };
    });
}

export function reviewCorrection(auth: AuthContext, id: string, decision: 'APPROVE' | 'REJECT', comment: string | undefined) {
  const correction = db.attendanceCorrections.get(id);
  const team = teamScope(auth);
  const employee = correction ? db.employees.get(correction.employeeId) : undefined;
  if (!correction || correction.organizationId !== auth.organizationId || !employee || !team(employee)) {
    throw AppError.notFound('Correction request not found.');
  }
  // Managers may review only their direct reports; HR may review everyone (scope already applied above).
  if (auth.role === 'EMPLOYEE') throw AppError.forbidden();
  if (correction.status !== 'PENDING') throw AppError.invalidState('This request has already been reviewed.');
  if (auth.employeeId && correction.employeeId === auth.employeeId) {
    throw AppError.forbidden('You cannot review your own correction request.');
  }

  const rules = loadRules(auth.organizationId);
  db.attendanceCorrections.update(id, {
    status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
    reviewerId: auth.userId,
    reviewComment: comment ?? null,
    reviewedAt: new Date().toISOString(),
  });
  if (decision === 'APPROVE') applyCorrection(auth.organizationId, correction, rules);
  writeAudit(auth, auth.organizationId, { action: `attendance.correction_${decision.toLowerCase()}d`, entityType: 'AttendanceCorrection', entityId: id, summary: { workDate: correction.workDate } });
  notifyUsers(auth.organizationId, [userIdForEmployee(correction.employeeId)], {
    kind: 'attendance.correction_reviewed',
    title: decision === 'APPROVE' ? 'Attendance correction approved' : 'Attendance correction rejected',
    body: `Your correction for ${correction.workDate} was ${decision === 'APPROVE' ? 'approved' : 'rejected'}.${comment ? ` Comment: ${comment}` : ''}`,
    link: '/attendance',
  });
  return { id, status: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED' };
}

// ---------------------------------------------------------------------------------------------------------------
// Records list (scoped) and monthly summary
// ---------------------------------------------------------------------------------------------------------------
export function listRecords(auth: AuthContext, from: string, to: string, employeeId?: string) {
  const rules = loadRules(auth.organizationId);
  const scope = employeeScope(auth);
  return db.attendanceRecords
    .filter((r) => {
      if (r.workDate < from || r.workDate > to || (employeeId && r.employeeId !== employeeId)) return false;
      const e = db.employees.get(r.employeeId);
      return Boolean(e && scope(e));
    })
    .sort((a, b) => b.workDate.localeCompare(a.workDate))
    .slice(0, 1000)
    .map((r) => {
      const e = db.employees.get(r.employeeId)!;
      return { ...recordView(r, rules), employee: { name: fullName(e), employeeCode: e.employeeCode } };
    });
}

export function monthlySummary(auth: AuthContext, year: number, month: number) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const from = `${year}-${pad(month)}-01`;
  const to = `${year}-${pad(month)}-${pad(last)}`;
  const team = teamScope(auth);
  const employees = db.employees
    .filter((e) => team(e) && e.status !== 'EXITED')
    .sort((a, b) => a.firstName.localeCompare(b.firstName))
    .slice(0, 500);
  const rows = employees.map((e) => {
    const days = dailyStatusesFor(e.id, from, to, auth.organizationId);
    const count = (s: string) => days.filter((d) => d.status === s).length;
    return {
      employee: { id: e.id, employeeCode: e.employeeCode, name: fullName(e) },
      present: count('PRESENT') + count('WFH'),
      late: count('LATE'),
      halfDay: count('HALF_DAY'),
      absent: count('ABSENT'),
      onLeave: count('ON_LEAVE'),
      holiday: count('HOLIDAY') + count('WEEKLY_OFF'),
      workedHours: Number((days.reduce((s, d) => s + (d.workedMinutes ?? 0), 0) / 60).toFixed(2)),
      overtimeHours: Number((days.reduce((s, d) => s + (d.overtimeMinutes ?? 0), 0) / 60).toFixed(2)),
      lateMinutes: days.reduce((s, d) => s + (d.lateMinutes ?? 0), 0),
    };
  });
  return { year, month, from, to, rows };
}

// ---------------------------------------------------------------------------------------------------------------
// Overtime approval (rules in attendance.rules.ts). Managers review direct reports, HR reviews everyone, and nobody
// reviews their own overtime. Payroll pays approved minutes only.
// ---------------------------------------------------------------------------------------------------------------

export function listOvertime(auth: AuthContext, status?: 'PENDING' | 'APPROVED' | 'REJECTED', mine = false) {
  const allowed = listScope(auth, mine);
  return db.attendanceRecords
    .filter((r) => r.organizationId === auth.organizationId && (status ? r.overtimeStatus === status : r.overtimeStatus !== 'NONE') && allowed(r.employeeId))
    .sort((a, b) => b.workDate.localeCompare(a.workDate))
    .slice(0, 300)
    .map((r) => {
      const e = db.employees.get(r.employeeId)!;
      return {
        id: r.id,
        employee: { id: e.id, name: fullName(e), employeeCode: e.employeeCode },
        workDate: r.workDate,
        checkInAt: r.checkInAt,
        checkOutAt: r.checkOutAt,
        workedMinutes: r.workedMinutes,
        overtimeMinutes: r.overtimeMinutes,
        approvedMinutes: r.overtimeApprovedMinutes,
        status: r.overtimeStatus,
        comment: r.overtimeComment,
        isOwn: r.employeeId === auth.employeeId,
      };
    });
}

export interface OvertimeReviewInput {
  ids: string[];
  decision: 'APPROVE' | 'REJECT';
  /** Approve only part of the overtime; allowed when reviewing a single day. */
  minutes?: number;
  comment?: string;
}

export function reviewOvertime(auth: AuthContext, input: OvertimeReviewInput) {
  if (auth.role === 'EMPLOYEE') throw AppError.forbidden();
  if (input.minutes !== undefined && input.ids.length !== 1) {
    throw AppError.badRequest('Approve part of the overtime one day at a time.', [{ field: 'minutes', message: 'Review a single day.' }]);
  }
  const team = teamScope(auth);
  const ids = new Set(input.ids);
  const records = [...ids]
    .map((id) => db.attendanceRecords.get(id))
    .filter((r): r is AttendanceRecord => {
      const e = r ? db.employees.get(r.employeeId) : undefined;
      return Boolean(r && r.organizationId === auth.organizationId && e && team(e));
    });
  if (records.length !== ids.size) throw AppError.notFound('Overtime entry not found.');
  for (const r of records) {
    if (r.employeeId === auth.employeeId) throw AppError.forbidden('You cannot review your own overtime.');
    if (r.overtimeStatus !== 'PENDING') {
      throw AppError.invalidState(`Overtime for ${db.employees.get(r.employeeId)!.firstName} on ${r.workDate} has already been reviewed.`);
    }
    if (input.minutes !== undefined && (input.minutes < 1 || input.minutes > r.overtimeMinutes)) {
      throw AppError.badRequest(`Approve between 1 and ${r.overtimeMinutes} minutes.`, [{ field: 'minutes', message: `At most ${r.overtimeMinutes} minutes.` }]);
    }
  }
  // Overtime is paid through payroll: a period that is approved or finalized is closed for changes.
  const periods = new Set(records.map((r) => r.workDate.slice(0, 7)));
  const runs = db.payrollRuns.filter((run) => run.organizationId === auth.organizationId && periods.has(`${run.year}-${String(run.month).padStart(2, '0')}`));
  const closed = runs.find((run) => run.status === 'APPROVED' || run.status === 'FINALIZED');
  if (closed) throw AppError.invalidState(`Payroll for ${closed.month}/${closed.year} is ${closed.status.toLowerCase()}, so its overtime can no longer change.`);

  const approve = input.decision === 'APPROVE';
  const reviewedAt = new Date().toISOString();
  for (const r of records) {
    db.attendanceRecords.update(r.id, {
      overtimeStatus: approve ? 'APPROVED' : 'REJECTED',
      overtimeApprovedMinutes: approve ? (input.minutes ?? r.overtimeMinutes) : 0,
      overtimeReviewerId: auth.userId,
      overtimeReviewedAt: reviewedAt,
      overtimeComment: input.comment ?? null,
    });
  }
  // A validated run no longer reflects the data: send it back to draft (as adjustments do).
  for (const run of runs.filter((x) => x.status === 'VALIDATED')) {
    db.payrollRuns.update(run.id, { status: 'DRAFT', validatedAt: null });
  }
  writeAudit(auth, auth.organizationId, {
    action: approve ? 'attendance.overtime_approved' : 'attendance.overtime_rejected',
    entityType: 'AttendanceRecord',
    entityId: records.length === 1 ? records[0].id : null,
    summary: { days: records.length, minutes: input.minutes ?? null },
  });

  // One notification per person, however many days were reviewed.
  const byEmployee = new Map<string, number>();
  for (const r of records) byEmployee.set(r.employeeId, (byEmployee.get(r.employeeId) ?? 0) + 1);
  for (const [employeeId, days] of byEmployee) {
    notifyUsers(auth.organizationId, [userIdForEmployee(employeeId)], {
      kind: approve ? 'attendance.overtime_approved' : 'attendance.overtime_rejected',
      title: approve ? 'Overtime approved' : 'Overtime not approved',
      body: `${auth.name} ${approve ? 'approved' : 'rejected'} your overtime for ${days} day(s).${input.comment ? ` Comment: ${input.comment}` : ''}`,
      link: '/attendance',
    });
  }
  return { reviewed: records.length, status: approve ? 'APPROVED' : 'REJECTED' };
}
