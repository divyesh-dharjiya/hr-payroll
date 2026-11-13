import { describe, expect, it } from 'vitest';
import { correctionTimeErrors, effectiveDayStatus, overtimeAfterRecalc, OVERTIME_MIN_CLAIM_MINUTES, evaluateCheckIn, evaluateCheckOut, shiftWindow, summarizeDay, type AttendanceRules } from './attendance.rules';
import { zonedTimeToUtc } from '../../lib/time';

const rules: AttendanceRules = {
  timezone: 'Asia/Kolkata',
  shiftStart: '09:30',
  shiftEnd: '18:30',
  graceMinutes: 10,
  standardBreakMinutes: 60,
  breakDeductionAfterMinutes: 360,
};
const DAY = '2026-10-19';
// IST is UTC+05:30, so 09:30 IST is 04:00 UTC.
const ist = (hhmm: string) => zonedTimeToUtc(DAY, hhmm, 'Asia/Kolkata');

describe('timezone conversion', () => {
  it('converts organization wall-clock time to UTC using the configured zone', () => {
    expect(ist('09:30').toISOString()).toBe('2026-10-19T04:00:00.000Z');
  });
});

describe('shift window', () => {
  it('computes scheduled minutes net of the standard break', () => {
    const w = shiftWindow(DAY, rules);
    expect(w.scheduledMinutes).toBe(9 * 60 - 60); // 09:30-18:30 minus 60 min break
  });

  it('treats an end time before the start as an overnight shift', () => {
    const w = shiftWindow(DAY, { ...rules, shiftStart: '22:00', shiftEnd: '06:00', standardBreakMinutes: 0 });
    expect(w.scheduledMinutes).toBe(8 * 60);
  });
});

describe('check-in evaluation', () => {
  it('marks PRESENT when arriving within the grace period', () => {
    expect(evaluateCheckIn(ist('09:40'), DAY, rules)).toEqual({ status: 'PRESENT', lateMinutes: 0 });
  });

  it('marks LATE after grace and measures minutes from shift start', () => {
    expect(evaluateCheckIn(ist('09:50'), DAY, rules)).toEqual({ status: 'LATE', lateMinutes: 20 });
  });
});

describe('check-out evaluation', () => {
  it('deducts the standard break once elapsed time crosses the threshold', () => {
    const out = evaluateCheckOut(ist('09:30'), ist('18:30'), DAY, rules);
    expect(out).toEqual({ breakMinutes: 60, workedMinutes: 480, overtimeMinutes: 0, isHalfDay: false });
  });

  it('does not deduct a break for short sessions', () => {
    const out = evaluateCheckOut(ist('10:00'), ist('13:20'), DAY, rules);
    expect(out.breakMinutes).toBe(0);
    expect(out.workedMinutes).toBe(200);
    expect(out.isHalfDay).toBe(true);
    // Exactly half of scheduled time is not a half day.
    expect(evaluateCheckOut(ist('10:00'), ist('14:00'), DAY, rules).isHalfDay).toBe(false);
  });

  it('records overtime beyond scheduled worked minutes', () => {
    const out = evaluateCheckOut(ist('09:30'), ist('20:00'), DAY, rules);
    expect(out.workedMinutes).toBe(570);
    expect(out.overtimeMinutes).toBe(90);
  });

  it('rejects a check-out that is not after check-in', () => {
    expect(() => evaluateCheckOut(ist('10:00'), ist('09:00'), DAY, rules)).toThrow();
  });
});

describe('multiple punches per day', () => {
  it('adds up every closed session and treats gaps as breaks', () => {
    const s = summarizeDay(
      [
        { inAt: ist('09:30'), outAt: ist('13:00') }, // 210
        { inAt: ist('13:45'), outAt: ist('16:00') }, // 135
        { inAt: ist('16:15'), outAt: ist('18:30') }, // 135
      ],
      DAY,
      rules,
    );
    expect(s.sessions).toBe(3);
    expect(s.punchedMinutes).toBe(480);
    expect(s.gapMinutes).toBe(60);
    expect(s.autoBreakMinutes).toBe(0); // the 60-minute standard break was actually taken
    expect(s.workedMinutes).toBe(480);
    expect(s.overtimeMinutes).toBe(0);
    expect(s.status).toBe('PRESENT');
  });

  it('deducts the shortfall of the standard break when breaks were not punched', () => {
    const s = summarizeDay([{ inAt: ist('09:30'), outAt: ist('18:30') }], DAY, rules);
    expect(s.punchedMinutes).toBe(540);
    expect(s.autoBreakMinutes).toBe(60);
    expect(s.workedMinutes).toBe(480);
  });

  it('deducts only the missing part when a shorter break was taken', () => {
    const s = summarizeDay(
      [
        { inAt: ist('09:30'), outAt: ist('13:00') },
        { inAt: ist('13:20'), outAt: ist('18:30') },
      ],
      DAY,
      rules,
    );
    expect(s.gapMinutes).toBe(20);
    expect(s.autoBreakMinutes).toBe(40);
    expect(s.workedMinutes).toBe(520 - 40);
  });

  it('keeps an open session out of totals and does not judge overtime or half day yet', () => {
    const s = summarizeDay(
      [
        { inAt: ist('09:50'), outAt: ist('11:00') },
        { inAt: ist('11:30'), outAt: null },
      ],
      DAY,
      rules,
    );
    expect(s.openSince?.toISOString()).toBe(ist('11:30').toISOString());
    expect(s.punchedMinutes).toBe(70);
    expect(s.lastOutAt).toBeNull();
    expect(s.isHalfDay).toBe(false);
    expect(s.overtimeMinutes).toBe(0);
    expect(s.status).toBe('LATE'); // first punch-in after grace
    expect(s.lateMinutes).toBe(20);
  });

  it('marks a short finished day as a half day', () => {
    const s = summarizeDay([{ inAt: ist('09:30'), outAt: ist('12:00') }], DAY, rules);
    expect(s.isHalfDay).toBe(true);
    expect(s.status).toBe('HALF_DAY');
  });

  it('records overtime beyond scheduled hours across sessions', () => {
    const s = summarizeDay(
      [
        { inAt: ist('09:30'), outAt: ist('13:30') },
        { inAt: ist('14:30'), outAt: ist('20:00') },
      ],
      DAY,
      rules,
    );
    expect(s.workedMinutes).toBe(570);
    expect(s.overtimeMinutes).toBe(90);
  });
});

describe('effective day status', () => {
  it('does not show a half day while the shift is still running (for example, out for lunch)', () => {
    expect(effectiveDayStatus('HALF_DAY', DAY, 0, rules, ist('13:30'))).toBe('PRESENT');
    expect(effectiveDayStatus('HALF_DAY', DAY, 25, rules, ist('13:30'))).toBe('LATE');
  });

  it('keeps the half day once the shift has ended', () => {
    expect(effectiveDayStatus('HALF_DAY', DAY, 0, rules, ist('18:30'))).toBe('HALF_DAY');
  });

  it('leaves other statuses unchanged', () => {
    expect(effectiveDayStatus('WFH', DAY, 0, rules, ist('10:00'))).toBe('WFH');
  });
});

describe('correction times', () => {
  const now = ist('20:00');

  it('accepts times on the work date that are not in the future', () => {
    expect(correctionTimeErrors(DAY, ist('09:40'), ist('18:35'), rules, now)).toEqual([]);
  });

  it('rejects a time on another day', () => {
    const nextDay = zonedTimeToUtc('2026-10-20', '09:40', 'Asia/Kolkata');
    expect(correctionTimeErrors(DAY, nextDay, null, rules, now).map((e) => e.field)).toEqual(['requestedCheckIn']);
  });

  it('rejects a time in the future', () => {
    expect(correctionTimeErrors(DAY, null, ist('21:00'), rules, now).map((e) => e.field)).toEqual(['requestedCheckOut']);
  });

  it('allows a next-day check-out for an overnight shift', () => {
    const night = { ...rules, shiftStart: '22:00', shiftEnd: '06:00' };
    const out = zonedTimeToUtc('2026-10-20', '06:05', 'Asia/Kolkata');
    expect(correctionTimeErrors(DAY, ist('22:00'), out, night, new Date(out.getTime() + 3_600_000))).toEqual([]);
  });
});

describe('overtime approval state', () => {
  const none = { status: 'NONE' as const, approvedMinutes: 0, overtimeMinutes: 0 };

  it('claims overtime for approval only from the minimum upward', () => {
    expect(overtimeAfterRecalc(none, OVERTIME_MIN_CLAIM_MINUTES - 1)).toEqual({ status: 'NONE', approvedMinutes: 0 });
    expect(overtimeAfterRecalc(none, OVERTIME_MIN_CLAIM_MINUTES)).toEqual({ status: 'PENDING', approvedMinutes: 0 });
  });

  it('keeps a decision while the overtime is unchanged', () => {
    const approved = { status: 'APPROVED' as const, approvedMinutes: 45, overtimeMinutes: 60 };
    expect(overtimeAfterRecalc(approved, 60)).toEqual({ status: 'APPROVED', approvedMinutes: 45 });
  });

  it('asks for a new decision when a recalculation changes the overtime', () => {
    const approved = { status: 'APPROVED' as const, approvedMinutes: 60, overtimeMinutes: 60 };
    expect(overtimeAfterRecalc(approved, 90)).toEqual({ status: 'PENDING', approvedMinutes: 0 });
    expect(overtimeAfterRecalc(approved, 10)).toEqual({ status: 'NONE', approvedMinutes: 0 });
  });
});
