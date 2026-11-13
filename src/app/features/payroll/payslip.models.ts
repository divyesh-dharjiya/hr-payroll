import { Injectable, inject } from '@angular/core';
import { Api } from '../../core/api';
import { Notify } from '../../core/notify';
import { saveFile } from '../../shared/download';

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

/** PDF of a finalized payslip, generated in the browser with the same access rules as the payslip page. */
@Injectable({ providedIn: 'root' })
export class PayslipPdf {
  private readonly api = inject(Api);
  private readonly notify = inject(Notify);

  async download(id: string, period: { year: number; month: number }, employeeCode?: string): Promise<void> {
    const pdf = await this.notify.run(() => this.api.downloadBlob(`/payroll/payslips/${encodeURIComponent(id)}/pdf`));
    if (!pdf) return;
    const month = String(period.month).padStart(2, '0');
    saveFile(`payslip-${employeeCode ? `${employeeCode}-` : ''}${period.year}-${month}.pdf`, pdf);
  }
}
