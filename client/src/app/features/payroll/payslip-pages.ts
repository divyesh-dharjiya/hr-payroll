import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Title } from '@angular/platform-browser';
import { Api } from '../../core/api';
import { Auth } from '../../core/auth';
import { StateView, StatusBadge } from '../../shared/ui';
import { formatDate, formatPaise, monthName } from '../../shared/format';

interface MyPayslip {
  id: string;
  period: { year: number; month: number };
  grossPaise: number;
  deductionsPaise: number;
  netPaise: number;
  paymentStatus: 'NOT_PAID' | 'PAID';
}

interface PayslipLine {
  code: string;
  label: string;
  amountPaise: number;
}
interface Payslip {
  id: string;
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

/** Printable payslip. Use the browser's print dialog and choose "Save as PDF" to keep a copy. */
@Component({
  selector: 'ph-payslip-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatButtonModule, MatIconModule, StateView, StatusBadge],
  template: `
    <div class="page">
      <nav class="crumbs no-print" aria-label="Breadcrumb"><a routerLink="/payslips">My payslips</a> / <span>Payslip</span></nav>
      <ph-state [state]="state()" (retry)="load()" title="Payslip could not be loaded" message="Payslips are visible only to the employee and HR.">
        @if (slip(); as s) {
          <div class="actions no-print">
            <button mat-flat-button color="primary" type="button" (click)="print()"><mat-icon>print</mat-icon> Print or save as PDF</button>
          </div>
          <article class="slip" [attr.aria-label]="'Payslip for ' + monthYear()">
            <header class="slip-head">
              <div>
                <div class="company">Lotus Technologies Pvt Ltd</div>
                <div class="muted">Payslip for {{ monthYear() }}</div>
              </div>
              <ph-status-badge [label]="s.paymentStatus === 'PAID' ? 'Paid' : 'Payment pending'" [tone]="s.paymentStatus === 'PAID' ? 'ok' : 'neutral'" />
            </header>

            <dl class="grid-info">
              <div><dt>Employee</dt><dd>{{ s.employee.name }}</dd></div>
              <div><dt>Employee ID</dt><dd>{{ s.employee.employeeCode }}</dd></div>
              <div><dt>Department</dt><dd>{{ s.employee.department }}</dd></div>
              <div><dt>Designation</dt><dd>{{ s.employee.designation }}</dd></div>
              <div><dt>Date of joining</dt><dd>{{ formatDate(s.employee.joiningDate) }}</dd></div>
              <div><dt>Bank account</dt><dd>{{ s.employee.bankAccount ?? '—' }}</dd></div>
              <div><dt>Paid days</dt><dd>{{ s.paidDays }}</dd></div>
              <div><dt>Loss of pay days</dt><dd>{{ s.lopDays }}</dd></div>
            </dl>

            <div class="split">
              <section aria-labelledby="earn-h">
                <h2 id="earn-h">Earnings</h2>
                <table>
                  <thead><tr><th scope="col">Component</th><th scope="col" class="num">Amount</th></tr></thead>
                  <tbody>
                    @for (l of s.lines.earnings; track l.code + l.label) { <tr><td>{{ l.label }}</td><td class="num">{{ paise(l.amountPaise) }}</td></tr> }
                  </tbody>
                  <tfoot><tr><th scope="row">Gross earnings</th><th class="num">{{ paise(s.totals.grossPaise) }}</th></tr></tfoot>
                </table>
              </section>
              <section aria-labelledby="ded-h">
                <h2 id="ded-h">Deductions</h2>
                <table>
                  <thead><tr><th scope="col">Component</th><th scope="col" class="num">Amount</th></tr></thead>
                  <tbody>
                    @for (l of s.lines.deductions; track l.code + l.label) { <tr><td>{{ l.label }}</td><td class="num">{{ paise(l.amountPaise) }}</td></tr> } @empty { <tr><td colspan="2" class="muted">No deductions this month</td></tr> }
                  </tbody>
                  <tfoot><tr><th scope="row">Total deductions</th><th class="num">{{ paise(s.totals.deductionsPaise) }}</th></tr></tfoot>
                </table>
              </section>
            </div>

            <div class="net">
              <span>Net pay for {{ monthYear() }}</span>
              <strong>{{ paise(s.totals.netPaise) }}</strong>
            </div>

            <section class="ytd" aria-labelledby="ytd-h">
              <h2 id="ytd-h">Financial year to date ({{ fyStartLabel(s.ytd.fromMonth) }} onwards)</h2>
              <div class="ytd-grid">
                <div><span>Gross</span><strong>{{ paise(s.ytd.gross) }}</strong></div>
                <div><span>Deductions</span><strong>{{ paise(s.ytd.deductions) }}</strong></div>
                <div><span>Net</span><strong>{{ paise(s.ytd.net) }}</strong></div>
              </div>
            </section>

            <footer class="fine">
              <p>Employer contributions this month: {{ paise(s.totals.employerContribPaise) }} (not deducted from pay).</p>
              <p>This is a system-generated payslip for the period shown. Statutory rates and tax amounts are configured by the company and should be verified with a qualified professional.</p>
              @if (s.paidAt) { <p>Payment recorded on {{ formatDate(s.paidAt.slice(0, 10)) }}.</p> }
            </footer>
          </article>
        }
      </ph-state>
    </div>
  `,
  styles: [
    `
      .crumbs { font-size: 13px; color: var(--ph-text-muted); }
      .crumbs a { color: var(--ph-primary); text-decoration: none; }
      .muted { color: var(--ph-text-muted); }
      .actions { display: flex; justify-content: flex-end; }
      .slip { background: var(--ph-surface); border: 1px solid var(--ph-border); border-radius: 14px; padding: 28px; display: flex; flex-direction: column; gap: 22px; }
      .slip-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 2px solid var(--ph-primary); padding-bottom: 14px; }
      .company { font-size: 20px; font-weight: 700; color: var(--ph-primary); }
      .grid-info { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px 20px; margin: 0; }
      .grid-info dt { font-size: 12px; color: var(--ph-text-muted); }
      .grid-info dd { margin: 0; font-weight: 600; }
      .split { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
      h2 { font-size: 14px; margin: 0 0 8px; }
      table { width: 100%; border-collapse: collapse; }
      th, td { padding: 9px 10px; border-bottom: 1px solid var(--ph-border); text-align: left; }
      tfoot th { font-weight: 650; border-top: 2px solid var(--ph-border); border-bottom: 0; }
      .num { text-align: right; font-variant-numeric: tabular-nums; }
      .net { display: flex; justify-content: space-between; align-items: center; padding: 16px 18px; border-radius: 12px; background: var(--ph-primary-soft); color: var(--ph-primary); font-weight: 600; }
      .net strong { font-size: 22px; font-variant-numeric: tabular-nums; }
      .ytd-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
      .ytd-grid div { border: 1px solid var(--ph-border); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; }
      .ytd-grid span { font-size: 12px; color: var(--ph-text-muted); }
      .ytd-grid strong { font-variant-numeric: tabular-nums; }
      .fine { font-size: 12px; color: var(--ph-text-muted); border-top: 1px dashed var(--ph-border); padding-top: 12px; }
      .fine p { margin: 4px 0; }
      @media (max-width: 720px) { .split, .ytd-grid { grid-template-columns: 1fr; } .slip { padding: 18px; } }
    `,
  ],
})
export class PayslipPage implements OnInit {
  private readonly api = inject(Api);
  private readonly route = inject(ActivatedRoute);
  private readonly title = inject(Title);
  readonly auth = inject(Auth);
  readonly paise = formatPaise;
  readonly formatDate = formatDate;
  readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  readonly slip = signal<Payslip | null>(null);

  ngOnInit() {
    void this.load();
  }

  monthYear() {
    const s = this.slip();
    return s ? `${monthName(s.period.month)} ${s.period.year}` : '';
  }

  fyStartLabel(month: number) {
    return monthName(month);
  }

  async load() {
    this.state.set('loading');
    try {
      const s = await this.api.get<Payslip>(`/payroll/payslips/${this.route.snapshot.paramMap.get('id')}`);
      this.slip.set(s);
      this.title.setTitle(`Payslip ${monthName(s.period.month)} ${s.period.year} | PeopleHub`);
      this.state.set('ready');
    } catch {
      this.state.set('error');
    }
  }

  print() {
    window.print();
  }
}

@Component({
  selector: 'ph-my-payslips',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatButtonModule, StateView, StatusBadge],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1>My payslips</h1>
          <p>Only finalized payroll appears here. Each payslip can be printed or saved as a PDF.</p>
        </div>
      </header>
      <section class="card">
        <ph-state [state]="state()" (retry)="load()" title="Payslips could not be loaded">
          <div class="table-wrap">
            <table class="data">
              <caption class="sr-only">Finalized payslips</caption>
              <thead><tr><th scope="col">Period</th><th scope="col" class="num">Gross</th><th scope="col" class="num">Deductions</th><th scope="col" class="num">Net pay</th><th scope="col">Payment</th><th scope="col"><span class="sr-only">Open</span></th></tr></thead>
              <tbody>
                @for (p of items(); track p.id) {
                  <tr>
                    <td>{{ monthName(p.period.month) }} {{ p.period.year }}</td>
                    <td class="num">{{ paise(p.grossPaise) }}</td>
                    <td class="num">{{ paise(p.deductionsPaise) }}</td>
                    <td class="num"><strong>{{ paise(p.netPaise) }}</strong></td>
                    <td><ph-status-badge [label]="p.paymentStatus === 'PAID' ? 'Paid' : 'Payment pending'" [tone]="p.paymentStatus === 'PAID' ? 'ok' : 'neutral'" /></td>
                    <td><a mat-button [routerLink]="['/payslips', p.id]">View</a></td>
                  </tr>
                } @empty {
                  <tr><td colspan="6" class="muted">No finalized payslips yet.</td></tr>
                }
              </tbody>
            </table>
          </div>
        </ph-state>
      </section>
    </div>
  `,
  styles: [`.muted { color: var(--ph-text-muted); } .num { text-align: right; } .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }`],
})
export class MyPayslipsPage implements OnInit {
  private readonly api = inject(Api);
  private readonly title = inject(Title);
  readonly paise = formatPaise;
  readonly monthName = monthName;
  readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  readonly items = signal<MyPayslip[]>([]);

  ngOnInit() {
    this.title.setTitle('My payslips | PeopleHub');
    void this.load();
  }

  async load() {
    this.state.set('loading');
    try {
      this.items.set((await this.api.get<{ items: MyPayslip[] }>('/payroll/payslips/mine')).items);
      this.state.set('ready');
    } catch {
      this.state.set('error');
    }
  }
}

