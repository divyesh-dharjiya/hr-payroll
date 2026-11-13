import { applyBps, mulDivRound } from '../../lib/money';

// ---------------------------------------------------------------------------------------------------------------
// Payroll calculation engine (pure, unit-tested in payroll.calc.spec.ts).
//
// Money: integer paise everywhere; proportional values round half-up to the paisa.
// Proration: each component is prorated as component * paidDays / daysInMonth (calendar days by default).
// Loss of pay (LOP): unpaid days = absent days + unpaid approved leave. Half days count as 0.5.
// Overtime: paid only when the organization configures overtimeMultiplierBps > 0. Hourly rate = gross / 240
//           (30-day month, 8-hour day). Multiplier 10000 bps = 1.0x. Marked for professional verification.
// PF: employee and employer contributions on min(prorated basic, wage ceiling) at configured bps rates.
//     The EPS / EDLI split of the employer share is NOT modelled; the configured employer rate is used as-is.
//     Verify against the current EPFO rules before relying on these results.
// ESI: applied only when the employee is flagged ESI-applicable AND the prorated gross is within the ceiling.
// Professional tax and TDS: amounts are configured per employee; no state slabs or income-tax slabs are hardcoded.
//     TDS must come from a verified tax computation (regime, financial year, deductions).
// ---------------------------------------------------------------------------------------------------------------

export interface PayrollRules {
  pfEmployeeRateBps: number;
  pfEmployerRateBps: number;
  pfWageCeilingPaise: number;
  esiEmployeeRateBps: number;
  esiEmployerRateBps: number;
  esiGrossCeilingPaise: number;
  overtimeMultiplierBps: number;
}

export interface SalaryInput {
  basicPaise: number;
  hraPaise: number;
  conveyancePaise: number;
  specialPaise: number;
  otherAllowancePaise: number;
  pfApplicable: boolean;
  esiApplicable: boolean;
  professionalTaxPaise: number;
  monthlyTdsPaise: number;
}

export interface AdjustmentInput {
  kind: 'EARNING' | 'DEDUCTION';
  label: string;
  amountPaise: number;
}

export interface AttendanceInput {
  daysInMonth: number;
  /** Unpaid days (absent + unpaid leave). Half-day units allowed. */
  lopDays: number;
  overtimeMinutes: number;
}

export interface PayrollLine {
  code: string;
  label: string;
  amountPaise: number;
}

export type PayrollException = {
  code: 'NEGATIVE_NET' | 'ESI_CEILING_EXCEEDED' | 'PF_WITHOUT_BASIC' | 'SALARY_REVISED';
  message: string;
  severity: 'error' | 'warning';
};

export interface PayrollResult {
  paidDays: number;
  lopDays: number;
  earnings: PayrollLine[];
  deductions: PayrollLine[];
  employerContributions: PayrollLine[];
  grossPaise: number;
  totalDeductionsPaise: number;
  netPaise: number;
  employerContributionPaise: number;
  exceptions: PayrollException[];
}

export interface DayForPay {
  status: string;
  leave?: { isPaid: boolean; days: number };
  absentOtherHalf?: boolean;
}

/**
 * Unpaid days in a period, in half-day units:
 *  - absent or not yet / no longer employed: 1
 *  - half day worked: 0.5, unless approved paid half-day leave covers the other half (then 0)
 *  - approved leave: unpaid leave counts its days; a past half-day leave with nothing worked adds 0.5
 *  - present, late, WFH, holidays, weekly offs and future days are paid
 */
export function lossOfPayDays(days: DayForPay[]): number {
  let lop = 0;
  for (const d of days) {
    switch (d.status) {
      case 'ABSENT':
      case 'NOT_EMPLOYED':
        lop += 1;
        break;
      case 'HALF_DAY':
        if (!(d.leave && d.leave.days === 0.5)) lop += 0.5;
        else if (!d.leave.isPaid) lop += 0.5;
        break;
      case 'ON_LEAVE':
        if (d.leave && !d.leave.isPaid) lop += d.leave.days;
        if (d.absentOtherHalf) lop += 0.5;
        break;
      default:
        break;
    }
  }
  return lop;
}

export function calculatePayroll(
  salary: SalaryInput,
  attendance: AttendanceInput,
  adjustments: AdjustmentInput[],
  rules: PayrollRules,
): PayrollResult {
  const { daysInMonth } = attendance;
  // Work in half-days so 0.5-day leave stays exact.
  const lopHalf = Math.round(attendance.lopDays * 2);
  const paidHalf = Math.max(0, daysInMonth * 2 - lopHalf);
  const paidDays = paidHalf / 2;
  const lopDays = lopHalf / 2;
  const prorate = (amount: number) => mulDivRound(amount, paidHalf, daysInMonth * 2);

  const exceptions: PayrollException[] = [];

  const basicEarned = prorate(salary.basicPaise);
  const earnings: PayrollLine[] = [
    { code: 'BASIC', label: 'Basic', amountPaise: basicEarned },
    { code: 'HRA', label: 'House Rent Allowance', amountPaise: prorate(salary.hraPaise) },
    { code: 'CONVEYANCE', label: 'Conveyance', amountPaise: prorate(salary.conveyancePaise) },
    { code: 'SPECIAL', label: 'Special Allowance', amountPaise: prorate(salary.specialPaise) },
    { code: 'OTHER', label: 'Other Allowance', amountPaise: prorate(salary.otherAllowancePaise) },
  ].filter((l) => l.amountPaise !== 0 || l.code === 'BASIC');

  const fullGross =
    salary.basicPaise + salary.hraPaise + salary.conveyancePaise + salary.specialPaise + salary.otherAllowancePaise;
  if (rules.overtimeMultiplierBps > 0 && attendance.overtimeMinutes > 0) {
    // minutes/60 hours * (gross/240) per hour * multiplier
    const overtimePay = mulDivRound(
      attendance.overtimeMinutes * fullGross,
      rules.overtimeMultiplierBps,
      60 * 240 * 10_000,
    );
    if (overtimePay > 0) earnings.push({ code: 'OVERTIME', label: 'Overtime', amountPaise: overtimePay });
  }

  for (const adj of adjustments.filter((a) => a.kind === 'EARNING')) {
    earnings.push({ code: 'ADJUSTMENT', label: adj.label, amountPaise: adj.amountPaise });
  }

  const grossPaise = earnings.reduce((sum, l) => sum + l.amountPaise, 0);

  const deductions: PayrollLine[] = [];
  const employerContributions: PayrollLine[] = [];

  if (salary.pfApplicable) {
    if (salary.basicPaise <= 0) {
      exceptions.push({ code: 'PF_WITHOUT_BASIC', message: 'PF is applicable but basic salary is zero.', severity: 'error' });
    }
    const pfWage = Math.min(basicEarned, rules.pfWageCeilingPaise);
    deductions.push({ code: 'PF_EE', label: 'Provident Fund (Employee)', amountPaise: applyBps(pfWage, rules.pfEmployeeRateBps) });
    employerContributions.push({
      code: 'PF_ER',
      label: 'Provident Fund (Employer)',
      amountPaise: applyBps(pfWage, rules.pfEmployerRateBps),
    });
  }

  if (salary.esiApplicable) {
    if (grossPaise <= rules.esiGrossCeilingPaise) {
      deductions.push({ code: 'ESI_EE', label: 'ESI (Employee)', amountPaise: applyBps(grossPaise, rules.esiEmployeeRateBps) });
      employerContributions.push({
        code: 'ESI_ER',
        label: 'ESI (Employer)',
        amountPaise: applyBps(grossPaise, rules.esiEmployerRateBps),
      });
    } else {
      exceptions.push({
        code: 'ESI_CEILING_EXCEEDED',
        message: 'Gross exceeds the ESI ceiling this period; ESI is not deducted.',
        severity: 'warning',
      });
    }
  }

  if (salary.professionalTaxPaise > 0) {
    deductions.push({ code: 'PT', label: 'Professional Tax', amountPaise: salary.professionalTaxPaise });
  }
  if (salary.monthlyTdsPaise > 0) {
    deductions.push({ code: 'TDS', label: 'Income Tax (TDS)', amountPaise: salary.monthlyTdsPaise });
  }
  for (const adj of adjustments.filter((a) => a.kind === 'DEDUCTION')) {
    deductions.push({ code: 'ADJUSTMENT', label: adj.label, amountPaise: adj.amountPaise });
  }

  const totalDeductionsPaise = deductions.reduce((sum, l) => sum + l.amountPaise, 0);
  const netPaise = grossPaise - totalDeductionsPaise;
  if (netPaise < 0) {
    exceptions.push({ code: 'NEGATIVE_NET', message: 'Deductions exceed gross pay. Review adjustments.', severity: 'error' });
  }

  const employerContributionPaise = employerContributions.reduce((sum, l) => sum + l.amountPaise, 0);

  return {
    paidDays,
    lopDays,
    earnings,
    deductions,
    employerContributions,
    grossPaise,
    totalDeductionsPaise,
    netPaise,
    employerContributionPaise,
    exceptions,
  };
}
