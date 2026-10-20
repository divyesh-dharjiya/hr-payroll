// Payslip shapes returned by /api/payroll/payslips.

export interface MyPayslip {
  id: string;
  period: { year: number; month: number };
  grossPaise: number;
  deductionsPaise: number;
  netPaise: number;
  paymentStatus: 'NOT_PAID' | 'PAID';
}

export interface PayslipLine {
  code: string;
  label: string;
  amountPaise: number;
}

export interface Payslip {
  id: string;
  runId: string;
  organization: { name: string; legalName: string | null };
  period: { year: number; month: number };
  employee: { id: string; employeeCode: string; name: string; department: string; designation: string; joiningDate: string; bankAccount: string | null };
  paidDays: number;
  lopDays: number;
  paymentStatus: 'NOT_PAID' | 'PAID';
  paidAt: string | null;
  lines: { earnings: PayslipLine[]; deductions: PayslipLine[]; employerContributions: PayslipLine[] };
  totals: { grossPaise: number; deductionsPaise: number; netPaise: number; employerContribPaise: number };
  ytd: { fromMonth: number; gross: number; deductions: number; net: number };
  finalizedAt: string | null;
}

/** Server-rendered PDF of a finalized payslip. Same access rules as the page; the session cookie authenticates it. */
export function payslipPdfUrl(id: string): string {
  return `/api/payroll/payslips/${encodeURIComponent(id)}/pdf`;
}
