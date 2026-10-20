import { AppError } from '../../lib/errors';
import { calendarDate, minutesBetween, zonedTimeToUtc } from '../../lib/time';

// ---------------------------------------------------------------------------------------------------------------
// Attendance rules (pure functions, unit-tested in tests/attendance.rules.test.ts)
//
//  - Check-in and check-out instants are server-generated (`new Date()`); clients never supply them.
//  - Shift start/end are wall-clock times in the organization timezone. A shift that ends at or before its start
//    is treated as overnight (end is on the next day).
//  - LATE: check-in strictly after shiftStart + graceMinutes. lateMinutes = minutes after shiftStart.
//  - Break: standardBreakMinutes is deducted only when elapsed time (check-out minus check-in) exceeds
//    breakDeductionAfterMinutes. Breaks are not individually tracked in this release.
//  - Worked minutes = elapsed - break.
//  - Scheduled minutes = shift length - standardBreakMinutes.
//  - Overtime minutes = max(0, worked - scheduled).
//  - HALF_DAY: worked minutes < floor(scheduled / 2).
//  - Limitation: browser check-in does not verify physical location or identity.
// ---------------------------------------------------------------------------------------------------------------

export interface AttendanceRules {
  timezone: string;
  shiftStart: string; // HH:mm
  shiftEnd: string; // HH:mm
  graceMinutes: number;
  standardBreakMinutes: number;
  breakDeductionAfterMinutes: number;
}

export interface ShiftWindow {
  start: Date;
  end: Date;
  scheduledMinutes: number;
}

export function shiftWindow(workDate: string, rules: AttendanceRules): ShiftWindow {
  const start = zonedTimeToUtc(workDate, rules.shiftStart, rules.timezone);
  let end = zonedTimeToUtc(workDate, rules.shiftEnd, rules.timezone);
  if (end.getTime() <= start.getTime()) {
    end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  }
  const length = minutesBetween(start, end);
  return { start, end, scheduledMinutes: Math.max(0, length - rules.standardBreakMinutes) };
}

export interface CheckInEvaluation {
  status: 'PRESENT' | 'LATE';
  lateMinutes: number;
}

export function evaluateCheckIn(checkInAt: Date, workDate: string, rules: AttendanceRules): CheckInEvaluation {
  const { start } = shiftWindow(workDate, rules);
  const threshold = new Date(start.getTime() + rules.graceMinutes * 60_000);
  if (checkInAt.getTime() <= threshold.getTime()) {
    return { status: 'PRESENT', lateMinutes: 0 };
  }
  return { status: 'LATE', lateMinutes: Math.max(0, minutesBetween(start, checkInAt)) };
}

export interface CheckOutEvaluation {
  breakMinutes: number;
  workedMinutes: number;
  overtimeMinutes: number;
  isHalfDay: boolean;
}

export function evaluateCheckOut(
  checkInAt: Date,
  checkOutAt: Date,
  workDate: string,
  rules: AttendanceRules,
): CheckOutEvaluation {
  if (checkOutAt.getTime() <= checkInAt.getTime()) {
    throw AppError.invalidState('Check-out time must be after the check-in time.');
  }
  const elapsed = minutesBetween(checkInAt, checkOutAt);
  const breakMinutes = elapsed > rules.breakDeductionAfterMinutes ? rules.standardBreakMinutes : 0;
  const workedMinutes = Math.max(0, elapsed - breakMinutes);
  const { scheduledMinutes } = shiftWindow(workDate, rules);
  return {
    breakMinutes,
    workedMinutes,
    overtimeMinutes: Math.max(0, workedMinutes - scheduledMinutes),
    isHalfDay: workedMinutes < Math.floor(scheduledMinutes / 2),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Multiple punches per day
//
//  - A day is a list of sessions (punch in -> punch out). Total punched time = sum of closed sessions.
//  - Breaks = gaps between sessions. If the day spans more than breakDeductionAfterMinutes and the recorded gaps
//    are shorter than standardBreakMinutes, the shortfall is deducted as an unpaid break ("autoBreakMinutes"),
//    so a person who never punches out for lunch is treated the same as one who does.
//  - Worked minutes = punched minutes - autoBreakMinutes.
//  - Late is measured from the first punch-in. Overtime and half day are judged only when no session is open.
// ---------------------------------------------------------------------------------------------------------------

export interface PunchSession {
  inAt: Date;
  outAt: Date | null;
}

export interface DaySummary {
  firstInAt: Date | null;
  lastOutAt: Date | null;
  openSince: Date | null;
  sessions: number;
  punchedMinutes: number;
  gapMinutes: number;
  autoBreakMinutes: number;
  breakMinutes: number;
  workedMinutes: number;
  lateMinutes: number;
  overtimeMinutes: number;
  isHalfDay: boolean;
  status: 'PRESENT' | 'LATE' | 'HALF_DAY';
}

export function summarizeDay(punches: PunchSession[], workDate: string, rules: AttendanceRules): DaySummary {
  const sorted = [...punches].sort((a, b) => a.inAt.getTime() - b.inAt.getTime());
  const open = sorted.find((p) => p.outAt === null) ?? null;
  const closed = sorted.filter((p): p is { inAt: Date; outAt: Date } => p.outAt !== null);

  const punchedMinutes = closed.reduce((s, p) => s + Math.max(0, minutesBetween(p.inAt, p.outAt)), 0);
  let gapMinutes = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prevOut = sorted[i - 1].outAt;
    if (prevOut) gapMinutes += Math.max(0, minutesBetween(prevOut, sorted[i].inAt));
  }

  const firstInAt = sorted[0]?.inAt ?? null;
  const lastOutAt = open ? null : closed.length ? closed[closed.length - 1].outAt : null;
  const spanMinutes = firstInAt && lastOutAt ? minutesBetween(firstInAt, lastOutAt) : 0;
  const autoBreakMinutes =
    !open && spanMinutes > rules.breakDeductionAfterMinutes ? Math.max(0, rules.standardBreakMinutes - gapMinutes) : 0;
  const workedMinutes = Math.max(0, punchedMinutes - autoBreakMinutes);

  const checkIn = firstInAt ? evaluateCheckIn(firstInAt, workDate, rules) : { status: 'PRESENT' as const, lateMinutes: 0 };
  const { scheduledMinutes } = shiftWindow(workDate, rules);
  const finished = !open && closed.length > 0;
  const isHalfDay = finished && workedMinutes < Math.floor(scheduledMinutes / 2);

  return {
    firstInAt,
    lastOutAt,
    openSince: open?.inAt ?? null,
    sessions: sorted.length,
    punchedMinutes,
    gapMinutes,
    autoBreakMinutes,
    breakMinutes: gapMinutes + autoBreakMinutes,
    workedMinutes,
    lateMinutes: checkIn.lateMinutes,
    overtimeMinutes: finished ? Math.max(0, workedMinutes - scheduledMinutes) : 0,
    isHalfDay,
    status: isHalfDay ? 'HALF_DAY' : checkIn.status,
  };
}

/**
 * Checks the times in a correction request: each must fall on the work date (in the organization timezone; a
 * check-out may fall on the next day for an overnight shift) and neither may be in the future.
 */
export function correctionTimeErrors(
  workDate: string,
  checkIn: Date | null,
  checkOut: Date | null,
  rules: AttendanceRules,
  now: Date = new Date(),
): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  const window = shiftWindow(workDate, rules);
  const outDays = new Set([workDate, calendarDate(window.end, rules.timezone)]);
  if (checkIn) {
    if (calendarDate(checkIn, rules.timezone) !== workDate) errors.push({ field: 'requestedCheckIn', message: 'The check-in must be on the selected date.' });
    else if (checkIn > now) errors.push({ field: 'requestedCheckIn', message: 'The check-in cannot be in the future.' });
  }
  if (checkOut) {
    if (!outDays.has(calendarDate(checkOut, rules.timezone))) errors.push({ field: 'requestedCheckOut', message: 'The check-out must be on the selected date.' });
    else if (checkOut > now) errors.push({ field: 'requestedCheckOut', message: 'The check-out cannot be in the future.' });
  }
  return errors;
}

/**
 * A stored HALF_DAY is final only once the day's shift has ended. Before that (someone out for lunch, or between
 * sessions) the day is still in progress, so it reads as PRESENT or LATE.
 */
export function effectiveDayStatus<S extends string>(
  status: S,
  workDate: string,
  lateMinutes: number,
  rules: AttendanceRules,
  now: Date = new Date(),
): S | 'PRESENT' | 'LATE' {
  if (status !== 'HALF_DAY') return status;
  if (now.getTime() >= shiftWindow(workDate, rules).end.getTime()) return status;
  return lateMinutes > 0 ? 'LATE' : 'PRESENT';
}

/** Attendance status priority used for monthly summaries. */
export function summarizeStatuses(statuses: string[]) {
  const count = (s: string) => statuses.filter((x) => x === s).length;
  return {
    present: count('PRESENT') + count('WFH'),
    late: count('LATE'),
    halfDay: count('HALF_DAY'),
    absent: count('ABSENT'),
    onLeave: count('ON_LEAVE'),
    holiday: count('HOLIDAY'),
    weeklyOff: count('WEEKLY_OFF'),
    wfh: count('WFH'),
  };
}
