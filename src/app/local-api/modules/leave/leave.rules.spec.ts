import { describe, expect, it } from 'vitest';
import { countLeaveDays, entitlementDays, leaveBalance, rangesOverlap } from './leave.rules';

// 2026-10-19 is a Monday. 2026-10-24 is a Saturday, 2026-10-25 is a Sunday.
describe('countLeaveDays', () => {
  it('excludes weekly offs (Sunday) and holidays', () => {
    const days = countLeaveDays({
      startDate: '2026-10-22', // Thu
      endDate: '2026-10-27', // Tue
      isHalfDay: false,
      weeklyOffDays: [0],
      holidays: new Set(['2026-10-23']), // Friday holiday
    });
    // Thu, Sat, Mon, Tue -> 4 working days (Fri holiday, Sun off)
    expect(days).toBe(4);
  });

  it('counts a half-day on a working day as 0.5', () => {
    expect(
      countLeaveDays({ startDate: '2026-10-19', endDate: '2026-10-19', isHalfDay: true, weeklyOffDays: [0], holidays: new Set() }),
    ).toBe(0.5);
  });

  it('counts a half-day on a weekly off as 0', () => {
    expect(
      countLeaveDays({ startDate: '2026-10-25', endDate: '2026-10-25', isHalfDay: true, weeklyOffDays: [0], holidays: new Set() }),
    ).toBe(0);
  });

  it('rejects half-day requests spanning multiple dates', () => {
    expect(() =>
      countLeaveDays({ startDate: '2026-10-19', endDate: '2026-10-20', isHalfDay: true, weeklyOffDays: [], holidays: new Set() }),
    ).toThrow();
  });
});

describe('entitlement and balance', () => {
  it('grants the full quota upfront plus carry-forward', () => {
    expect(entitlementDays({ annualQuotaDays: 12, accrual: 'UPFRONT', monthsElapsed: 1, carryForwardDays: 2 })).toBe(14);
  });

  it('accrues monthly and rounds down to half days', () => {
    // 12 days/yr over 4 months = 4 days; over 5 months = 5 days; 10 quota over 1 month = 0.8333 -> 0.5
    expect(entitlementDays({ annualQuotaDays: 12, accrual: 'MONTHLY', monthsElapsed: 4, carryForwardDays: 0 })).toBe(4);
    expect(entitlementDays({ annualQuotaDays: 10, accrual: 'MONTHLY', monthsElapsed: 1, carryForwardDays: 0 })).toBe(0.5);
  });

  it('subtracts approved and pending days so pending days cannot be double-booked', () => {
    const b = leaveBalance({
      annualQuotaDays: 12,
      accrual: 'UPFRONT',
      monthsElapsed: 10,
      carryForwardDays: 0,
      approvedDays: 3,
      pendingDays: 2,
      isPaid: true,
    });
    expect(b.available).toBe(7);
  });

  it('does not limit unpaid leave', () => {
    const b = leaveBalance({
      annualQuotaDays: 0,
      accrual: 'UPFRONT',
      monthsElapsed: 1,
      carryForwardDays: 0,
      approvedDays: 5,
      pendingDays: 0,
      isPaid: false,
    });
    expect(b.unlimited).toBe(true);
  });
});

describe('rangesOverlap', () => {
  it('detects inclusive overlaps and ignores adjacent ranges', () => {
    expect(rangesOverlap('2026-10-10', '2026-10-12', '2026-10-12', '2026-10-15')).toBe(true);
    expect(rangesOverlap('2026-10-10', '2026-10-11', '2026-10-12', '2026-10-15')).toBe(false);
  });
});
