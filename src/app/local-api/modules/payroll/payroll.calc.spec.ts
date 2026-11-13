import { describe, expect, it } from 'vitest';
import { calculatePayroll, lossOfPayDays, type PayrollRules, type SalaryInput } from './payroll.calc';
import { applyBps, formatInr, mulDivRound, rupeesInWords, rupeesToPaise } from '../../lib/money';

const rules: PayrollRules = {
  pfEmployeeRateBps: 1200,
  pfEmployerRateBps: 1200,
  pfWageCeilingPaise: 1_500_000, // INR 15,000
  esiEmployeeRateBps: 75,
  esiEmployerRateBps: 325,
  esiGrossCeilingPaise: 2_100_000, // INR 21,000
  overtimeMultiplierBps: 0,
};

const salary: SalaryInput = {
  basicPaise: 2_000_000, // INR 20,000
  hraPaise: 800_000,
  conveyancePaise: 0,
  specialPaise: 1_200_000,
  otherAllowancePaise: 0,
  pfApplicable: true,
  esiApplicable: false,
  professionalTaxPaise: 20_000,
  monthlyTdsPaise: 0,
};

const fullMonth = { daysInMonth: 31, lopDays: 0, overtimeMinutes: 0 };

describe('money helpers', () => {
  it('rounds half-up at the paisa', () => {
    expect(applyBps(1, 5000)).toBe(1); // 0.5 paise -> 1
    expect(mulDivRound(10, 1, 4)).toBe(3); // 2.5 -> 3
    expect(applyBps(1_000_000, 1200)).toBe(120_000);
  });

  it('parses rupee strings without float drift', () => {
    expect(rupeesToPaise('45000.5')).toBe(4_500_050);
    expect(rupeesToPaise('0.10')).toBe(10);
  });

  it('formats INR with Indian grouping', () => {
    expect(formatInr(123_456_789)).toBe('₹12,34,567.89');
    expect(formatInr(-50_000)).toBe('-₹500.00');
  });
});

describe('calculatePayroll', () => {
  it('computes a full month with PF and professional tax', () => {
    const r = calculatePayroll(salary, fullMonth, [], rules);
    expect(r.grossPaise).toBe(4_000_000);
    // PF on basic capped at 15,000 -> 1,800 employee
    const pf = r.deductions.find((d) => d.code === 'PF_EE');
    expect(pf?.amountPaise).toBe(180_000);
    expect(r.totalDeductionsPaise).toBe(180_000 + 20_000);
    expect(r.netPaise).toBe(4_000_000 - 200_000);
    expect(r.employerContributionPaise).toBe(180_000);
    expect(r.exceptions).toEqual([]);
  });

  it('prorates earnings for loss-of-pay days', () => {
    // 3 unpaid days out of 30: paid 27/30 of each component
    const r = calculatePayroll(salary, { daysInMonth: 30, lopDays: 3, overtimeMinutes: 0 }, [], rules);
    expect(r.paidDays).toBe(27);
    expect(r.lopDays).toBe(3);
    const basic = r.earnings.find((e) => e.code === 'BASIC');
    expect(basic?.amountPaise).toBe(1_800_000);
    expect(r.grossPaise).toBe(3_600_000);
  });

  it('handles half-day loss of pay exactly', () => {
    const r = calculatePayroll(salary, { daysInMonth: 30, lopDays: 0.5, overtimeMinutes: 0 }, [], rules);
    expect(r.paidDays).toBe(29.5);
  });

  it('applies ESI only within the configured ceiling', () => {
    const lowWage = calculatePayroll(
      { ...salary, basicPaise: 1_000_000, hraPaise: 0, specialPaise: 0, esiApplicable: true, professionalTaxPaise: 0 },
      fullMonth,
      [],
      rules,
    );
    expect(lowWage.deductions.find((d) => d.code === 'ESI_EE')?.amountPaise).toBe(7_500);

    const highWage = calculatePayroll({ ...salary, esiApplicable: true }, fullMonth, [], rules);
    expect(highWage.deductions.some((d) => d.code === 'ESI_EE')).toBe(false);
    expect(highWage.exceptions.map((e) => e.code)).toContain('ESI_CEILING_EXCEEDED');
  });

  it('pays overtime only when a multiplier is configured', () => {
    const none = calculatePayroll(salary, { daysInMonth: 31, lopDays: 0, overtimeMinutes: 120 }, [], rules);
    expect(none.earnings.some((e) => e.code === 'OVERTIME')).toBe(false);

    // 2 hours at gross/240 per hour, 1.5x => 2 * 16,666.66... * 1.5 = 50,000 paise scaled
    const withOt = calculatePayroll(
      salary,
      { daysInMonth: 31, lopDays: 0, overtimeMinutes: 120 },
      [],
      { ...rules, overtimeMultiplierBps: 15000 },
    );
    const ot = withOt.earnings.find((e) => e.code === 'OVERTIME');
    expect(ot?.amountPaise).toBe(Math.round((120 * 4_000_000 * 15000) / (60 * 240 * 10000)));
  });

  it('applies employee adjustments as earnings and deductions', () => {
    const r = calculatePayroll(
      salary,
      fullMonth,
      [
        { kind: 'EARNING', label: 'Festival bonus', amountPaise: 500_000 },
        { kind: 'DEDUCTION', label: 'Canteen recovery', amountPaise: 10_000 },
      ],
      rules,
    );
    expect(r.grossPaise).toBe(4_500_000);
    expect(r.deductions.find((d) => d.label === 'Canteen recovery')?.amountPaise).toBe(10_000);
    expect(r.netPaise).toBe(4_500_000 - (180_000 + 20_000 + 10_000));
  });

  it('flags a negative net pay as an error', () => {
    const r = calculatePayroll(
      { ...salary, monthlyTdsPaise: 5_000_000 },
      fullMonth,
      [],
      rules,
    );
    expect(r.netPaise).toBeLessThan(0);
    expect(r.exceptions.find((e) => e.code === 'NEGATIVE_NET')?.severity).toBe('error');
  });
});

describe('loss of pay days', () => {
  const paidHalf = { isPaid: true, days: 0.5 };
  const unpaidHalf = { isPaid: false, days: 0.5 };

  it('counts absent and not-employed days in full and a half day as half', () => {
    expect(lossOfPayDays([{ status: 'ABSENT' }, { status: 'NOT_EMPLOYED' }, { status: 'HALF_DAY' }, { status: 'PRESENT' }])).toBe(2.5);
  });

  it('pays a worked half day in full when paid half-day leave covers the other half', () => {
    expect(lossOfPayDays([{ status: 'HALF_DAY', leave: paidHalf }])).toBe(0);
    expect(lossOfPayDays([{ status: 'HALF_DAY', leave: unpaidHalf }])).toBe(0.5);
  });

  it('charges the unworked half of a past half-day leave', () => {
    expect(lossOfPayDays([{ status: 'ON_LEAVE', leave: paidHalf, absentOtherHalf: true }])).toBe(0.5);
    expect(lossOfPayDays([{ status: 'ON_LEAVE', leave: unpaidHalf, absentOtherHalf: true }])).toBe(1);
  });

  it('counts unpaid leave days and pays paid leave', () => {
    expect(lossOfPayDays([{ status: 'ON_LEAVE', leave: { isPaid: false, days: 1 } }, { status: 'ON_LEAVE', leave: { isPaid: true, days: 1 } }])).toBe(1);
  });
});

describe('amount in words', () => {
  it('uses the Indian numbering system', () => {
    expect(rupeesInWords(15_000_000)).toBe('Rupees One Lakh Fifty Thousand Only');
    expect(rupeesInWords(1_234_567_850)).toBe('Rupees One Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred Seventy-Eight and Fifty Paise Only');
    expect(rupeesInWords(0)).toBe('Rupees Zero Only');
  });
});
