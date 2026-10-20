import { eachDay, weekdayOf } from '../../lib/time';

// ---------------------------------------------------------------------------------------------------------------
// Leave rules (pure functions, unit-tested in tests/leave.rules.test.ts)
//
//  - Leave days count only working days: weekly-off weekdays and organization holidays are excluded.
//  - Half-day requests cover exactly one working day and count as 0.5 days.
//  - Entitlement: UPFRONT grants the full annual quota on 1 January of the financial year (plus carry-forward).
//    MONTHLY accrues quota/12 per completed month, rounded down to half a day.
//  - Balance = entitlement - approved days in the year - pending requests. Pending days are reserved, so a
//    request cannot be approved twice, and approved days are counted only once (the balance is derived from
//    request records, never stored and decremented separately).
//  - Unpaid leave types have no balance limit.
// ---------------------------------------------------------------------------------------------------------------

export interface LeaveDayInput {
  startDate: string; // YYYY-MM-DD
  endDate: string;
  isHalfDay: boolean;
  weeklyOffDays: number[];
  holidays: Set<string>;
}

/** Working days covered by a request. Returns 0 when the whole range is non-working. */
export function countLeaveDays(input: LeaveDayInput): number {
  const isWorking = (ymd: string) =>
    !input.weeklyOffDays.includes(weekdayOf(ymd)) && !input.holidays.has(ymd);

  if (input.isHalfDay) {
    if (input.startDate !== input.endDate) {
      throw new RangeError('A half-day request must start and end on the same day.');
    }
    return isWorking(input.startDate) ? 0.5 : 0;
  }
  return eachDay(input.startDate, input.endDate).filter(isWorking).length;
}

export interface EntitlementInput {
  annualQuotaDays: number;
  accrual: 'UPFRONT' | 'MONTHLY';
  /** Completed months within the leave year (1-12) for monthly accrual. */
  monthsElapsed: number;
  carryForwardDays: number;
}

export function entitlementDays(input: EntitlementInput): number {
  let base = input.annualQuotaDays;
  if (input.accrual === 'MONTHLY') {
    const accrued = (input.annualQuotaDays * Math.min(12, Math.max(0, input.monthsElapsed))) / 12;
    base = Math.floor(accrued * 2) / 2; // round down to half-day units
  }
  return base + input.carryForwardDays;
}

export interface BalanceInput extends EntitlementInput {
  approvedDays: number;
  pendingDays: number;
  isPaid: boolean;
}

export interface BalanceResult {
  entitled: number;
  used: number;
  pending: number;
  available: number;
  unlimited: boolean;
}

export function leaveBalance(input: BalanceInput): BalanceResult {
  if (!input.isPaid) {
    return { entitled: 0, used: input.approvedDays, pending: input.pendingDays, available: Infinity, unlimited: true };
  }
  const entitled = entitlementDays(input);
  return {
    entitled,
    used: input.approvedDays,
    pending: input.pendingDays,
    available: entitled - input.approvedDays - input.pendingDays,
    unlimited: false,
  };
}

/** Inclusive date-range overlap for YYYY-MM-DD strings. */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}
