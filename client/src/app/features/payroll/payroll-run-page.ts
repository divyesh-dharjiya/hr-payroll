import { ChangeDetectionStrategy, Component, OnInit, inject, signal, computed } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { Title } from '@angular/platform-browser';
import { firstValueFrom } from 'rxjs';
import { Api } from '../../core/api';
import { Auth } from '../../core/auth';
import { Notify } from '../../core/notify';
import { StateView, StatusBadge, confirmAction, type Tone } from '../../shared/ui';
import { formatPaise, monthName } from '../../shared/format';
import { saveFile } from '../employees/employee-list';
import { ReasonDialogData, CorrectionReviewDialog, type ReviewResult } from '../attendance/correction-review-dialog';
import { PaymentDialog } from './payroll-page';
import { payslipPdfUrl } from './payslip.models';

type RunStatus = 'DRAFT' | 'VALIDATED' | 'APPROVED' | 'FINALIZED';

interface PayrollLine {
  code: string;
  label: string;
  amountPaise: number;
}
interface Entry {
  id: string;
  employee: { id: string; employeeCode: string; name: string; department: string };
  paidDays: number;
  lopDays: number;
  grossPaise: number;
  totalDeductionsPaise: number;
  netPaise: number;
  employerContribPaise: number;
  paymentStatus: 'NOT_PAID' | 'PAID';
  paymentReference: string | null;
  paidAt: string | null;
  lines: { earnings: PayrollLine[]; deductions: PayrollLine[]; employerContributions: PayrollLine[] } | null;
  exceptions: { code: string; message: string; severity: 'error' | 'warning' }[];
}
interface Run {
  id: string;
  year: number;
  month: number;
  status: RunStatus;
  validatedAt: string | null;
  approvedAt: string | null;
  finalizedAt: string | null;
  totals: { grossPaise: number; deductionsPaise: number; netPaise: number; employerPaise: number };
  exceptionCount: number;
  entries: Entry[];
}

const STEPS: { key: RunStatus; label: string }[] = [
  { key: 'DRAFT', label: 'Draft' },
  { key: 'VALIDATED', label: 'Validated' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'FINALIZED', label: 'Finalized' },
];

@Component({
  selector: 'ph-payroll-run-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatButtonModule, MatIconModule, StateView, StatusBadge],
  template: `
    <div class="page">
      <nav class="crumbs" aria-label="Breadcrumb"><a routerLink="/payroll">Payroll</a> / <span>{{ run() ? periodLabel() : 'Run' }}</span></nav>

      <ph-state [state]="state()" (retry)="load()" title="Payroll run could not be loaded" message="It may not exist or you may not have access to it.">
        @if (run(); as r) {
          <header class="page-header">
            <div>
              <h1>{{ periodLabel() }} payroll</h1>
              <p>{{ r.entries.length }} employee(s) · {{ r.exceptionCount }} exception(s) to review</p>
            </div>
            <div class="toolbar">
              @if (r.status === 'DRAFT' && auth.has('payroll:manage')) {
                <button mat-stroked-button type="button" (click)="recalc()" [disabled]="busy()"><mat-icon>refresh</mat-icon> Recalculate</button>
                <button mat-flat-button color="primary" type="button" (click)="validate()" [disabled]="busy()"><mat-icon>fact_check</mat-icon> Validate</button>
              }
              @if ((r.status === 'VALIDATED' || r.status === 'APPROVED') && auth.has('payroll:manage')) {
                <button mat-stroked-button type="button" (click)="reopen()" [disabled]="busy()"><mat-icon>undo</mat-icon> Reopen as draft</button>
              }
              @if (r.status === 'VALIDATED' && auth.has('payroll:approve')) {
                <button mat-flat-button color="primary" type="button" (click)="approve()" [disabled]="busy()"><mat-icon>done_all</mat-icon> Approve</button>
              }
              @if (r.status === 'APPROVED' && auth.has('payroll:approve')) {
                <button mat-flat-button color="primary" type="button" (click)="finalize()" [disabled]="busy()"><mat-icon>lock</mat-icon> Finalize</button>
              }
              @if (r.status === 'FINALIZED' && auth.has('payroll:bank-export')) {
                <button mat-stroked-button type="button" (click)="bankExport()" [disabled]="busy()"><mat-icon>account_balance</mat-icon> Bank transfer file</button>
              }
            </div>
          </header>

          <ol class="steps" aria-label="Payroll workflow">
            @for (s of steps; track s.key; let i = $index) {
              <li [class.done]="stepIndex() > i" [class.current]="stepIndex() === i" [attr.aria-current]="stepIndex() === i ? 'step' : null">
                <span class="dot" aria-hidden="true">{{ stepIndex() > i ? '✓' : i + 1 }}</span>
                <span>{{ s.label }}</span>
              </li>
            }
          </ol>
          <p class="muted small">
            @switch (r.status) {
              @case ('DRAFT') { Entries are calculated from attendance, approved leave, salary and adjustments. Recalculate after changing inputs. }
              @case ('VALIDATED') { Checks passed. Another manager, not the creator, must approve this run. }
              @case ('APPROVED') { Approved. Finalizing locks the run and stores a snapshot of every calculation. }
              @case ('FINALIZED') { Finalized and locked. Record bank payments per employee below. Payment is tracked separately from finalization. }
            }
          </p>

          <section class="totals grid grid-kpi" aria-label="Run totals">
            <div class="card kpi"><span class="muted">Gross pay</span><strong>{{ paise(r.totals.grossPaise) }}</strong></div>
            <div class="card kpi"><span class="muted">Employee deductions</span><strong>{{ paise(r.totals.deductionsPaise) }}</strong></div>
            <div class="card kpi"><span class="muted">Net pay</span><strong>{{ paise(r.totals.netPaise) }}</strong></div>
            <div class="card kpi"><span class="muted">Employer contributions</span><strong>{{ paise(r.totals.employerPaise) }}</strong></div>
          </section>

          <section class="card" aria-labelledby="entries-title">
            <h2 id="entries-title" class="card-title">Employees</h2>
            <div class="table-wrap">
              <table class="data">
                <caption class="sr-only">Payroll entries for this run</caption>
                <thead>
                  <tr>
                    <th scope="col"><span class="sr-only">Details</span></th>
                    <th scope="col">Employee</th><th scope="col" class="num">Paid days</th><th scope="col" class="num">LOP days</th>
                    <th scope="col" class="num">Gross</th><th scope="col" class="num">Deductions</th><th scope="col" class="num">Net</th>
                    <th scope="col">Payment</th><th scope="col"><span class="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  @for (e of r.entries; track e.id) {
                    <tr>
                      <td>
                        <button mat-icon-button type="button" (click)="toggle(e.id)" [attr.aria-expanded]="expanded().has(e.id)" [attr.aria-label]="'Show breakdown for ' + e.employee.name">
                          <mat-icon>{{ expanded().has(e.id) ? 'expand_less' : 'expand_more' }}</mat-icon>
                        </button>
                      </td>
                      <td>
                        {{ e.employee.name }}
                        <div class="muted small">{{ e.employee.employeeCode }} · {{ e.employee.department }}</div>
                        @if (e.exceptions.length) {
                          <ph-status-badge [label]="e.exceptions.length + ' to review'" [tone]="hasError(e) ? 'bad' : 'warn'" />
                        }
                      </td>
                      <td class="num">{{ e.paidDays }}</td>
                      <td class="num">{{ e.lopDays }}</td>
                      <td class="num">{{ paise(e.grossPaise) }}</td>
                      <td class="num">{{ paise(e.totalDeductionsPaise) }}</td>
                      <td class="num"><strong>{{ paise(e.netPaise) }}</strong></td>
                      <td>
                        @if (r.status === 'FINALIZED') {
                          <ph-status-badge [label]="e.paymentStatus === 'PAID' ? 'Paid' : 'Not paid'" [tone]="e.paymentStatus === 'PAID' ? 'ok' : 'neutral'" />
                          @if (e.paymentReference) { <div class="muted small">Ref {{ e.paymentReference }}</div> }
                        } @else {
                          <span class="muted small">After finalization</span>
                        }
                      </td>
                      <td class="actions">
                        @if (r.status === 'FINALIZED' && auth.has('payroll:manage') && e.paymentStatus !== 'PAID') {
                          <button mat-button type="button" (click)="markPaid(e)">Record payment</button>
                        }
                      </td>
                    </tr>
                    @if (expanded().has(e.id)) {
                      <tr class="detail">
                        <td colspan="9">
                          @if (e.lines; as lines) {
                            <div class="breakdown">
                              <div>
                                <h3>Earnings</h3>
                                <ul>@for (l of lines.earnings; track l.code + l.label) { <li><span>{{ l.label }}</span><span class="num">{{ paise(l.amountPaise) }}</span></li> }</ul>
                              </div>
                              <div>
                                <h3>Deductions</h3>
                                <ul>@for (l of lines.deductions; track l.code + l.label) { <li><span>{{ l.label }}</span><span class="num">{{ paise(l.amountPaise) }}</span></li> } @empty { <li class="muted">None</li> }</ul>
                              </div>
                              <div>
                                <h3>Employer contributions</h3>
                                <ul>@for (l of lines.employerContributions; track l.code + l.label) { <li><span>{{ l.label }}</span><span class="num">{{ paise(l.amountPaise) }}</span></li> } @empty { <li class="muted">None</li> }</ul>
                              </div>
                            </div>
                          }
                          @if (e.exceptions.length) {
                            <ul class="exceptions" aria-label="Exceptions">
                              @for (x of e.exceptions; track x.code) {
                                <li [class.bad]="x.severity === 'error'"><strong>{{ x.severity === 'error' ? 'Blocking' : 'Warning' }}:</strong> {{ x.message }}</li>
                              }
                            </ul>
                          }
                          @if (r.status === 'FINALIZED') {
                            <div class="slip-links">
                              <a mat-stroked-button [routerLink]="['/payslips', e.id]">View payslip</a>
                              <a mat-button [href]="pdfUrl(e.id)" download><mat-icon>download</mat-icon> PDF<span class="sr-only"> payslip for {{ e.employee.name }}</span></a>
                            </div>
                          }
                        </td>
                      </tr>
                    }
                  } @empty {
                    <tr><td colspan="9" class="muted">No eligible employees for this period. Check joining and exit dates.</td></tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }
      </ph-state>
    </div>
  `,
  styles: [
    `
      .crumbs { font-size: 13px; color: var(--ph-text-muted); }
      .crumbs a { color: var(--ph-primary); text-decoration: none; }
      .muted { color: var(--ph-text-muted); }
      .small { font-size: 12px; }
      .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
      .steps { list-style: none; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; padding: 0; margin: 0; }
      .steps li { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--ph-border); border-radius: 12px; background: var(--ph-surface); color: var(--ph-text-muted); font-weight: 500; }
      .steps li.done { color: var(--ph-success); border-color: #abefc6; background: var(--ph-success-soft); }
      .steps li.current { color: var(--ph-primary); border-color: var(--ph-primary); background: var(--ph-primary-soft); font-weight: 650; }
      .dot { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; background: var(--ph-surface-muted); border: 1px solid var(--ph-border); }
      .current .dot { background: var(--ph-primary); color: #fff; border-color: transparent; }
      .done .dot { background: var(--ph-success); color: #fff; border-color: transparent; }
      .kpi { display: flex; flex-direction: column; gap: 4px; }
      .kpi strong { font-size: 19px; font-variant-numeric: tabular-nums; }
      .actions { text-align: right; }
      .detail td { background: var(--ph-surface-muted); }
      .breakdown { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 12px; }
      .breakdown h3 { font-size: 13px; margin: 0 0 6px; }
      .breakdown ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
      .breakdown li { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
      .exceptions { margin: 0 0 12px; padding-left: 18px; font-size: 13px; }
      .exceptions .bad { color: var(--ph-danger); }
      .slip-links { display: flex; gap: 8px; flex-wrap: wrap; }
      @media (max-width: 800px) { .steps { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    `,
  ],
})
export class PayrollRunPage implements OnInit {
  readonly auth = inject(Auth);
  private readonly api = inject(Api);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly notify = inject(Notify);
  private readonly dialog = inject(MatDialog);
  private readonly title = inject(Title);

  readonly steps = STEPS;
  readonly pdfUrl = payslipPdfUrl;
  readonly paise = formatPaise;
  readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  readonly run = signal<Run | null>(null);
  readonly busy = signal(false);
  readonly expanded = signal<Set<string>>(new Set());

  readonly stepIndex = computed(() => STEPS.findIndex((s) => s.key === this.run()?.status));
  readonly periodLabel = computed(() => {
    const r = this.run();
    return r ? `${monthName(r.month)} ${r.year}` : '';
  });

  ngOnInit() {
    void this.load();
  }

  private get id(): string {
    return this.route.snapshot.paramMap.get('id') ?? '';
  }

  /** A quiet reload keeps the page on screen while fresh data loads (after an action). */
  async load(quiet = false) {
    if (!quiet) this.state.set('loading');
    try {
      const r = await this.api.get<Run>(`/payroll/runs/${this.id}`);
      this.run.set(r);
      this.title.setTitle(`${monthName(r.month)} ${r.year} payroll | PeopleHub`);
      this.state.set('ready');
    } catch {
      this.state.set('error');
    }
  }

  toggle(id: string) {
    const next = new Set(this.expanded());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.expanded.set(next);
  }

  hasError(e: Entry) {
    return e.exceptions.some((x) => x.severity === 'error');
  }

  async act(action: () => Promise<unknown>, success: string) {
    this.busy.set(true);
    await this.notify.run(action, success);
    this.busy.set(false);
    // Reload either way: a failed validation still recalculates entries, and their exceptions show what to fix.
    await this.load(true);
  }

  recalc() {
    return this.act(() => this.api.post(`/payroll/runs/${this.id}/recalculate`), 'Entries recalculated from the latest data.');
  }

  validate() {
    return this.act(() => this.api.post(`/payroll/runs/${this.id}/validate`), 'Validation passed. The run is ready for approval.');
  }

  async reopen() {
    const result = await firstValueFrom(
      this.dialog.open<CorrectionReviewDialog, ReasonDialogData, ReviewResult>(CorrectionReviewDialog, {
        data: { name: '', title: 'Reopen this run as a draft?', label: 'Reason for reopening', confirmLabel: 'Reopen as draft' },
        width: 'min(460px, 94vw)',
      }).afterClosed(),
    );
    if (!result) return;
    await this.act(() => this.api.post(`/payroll/runs/${this.id}/reopen`, { reason: result.comment }), 'Run reopened as a draft.');
  }

  async approve() {
    const ok = await confirmAction(this.dialog, {
      title: 'Approve this payroll run?',
      message: 'Approval records you as the approver. The creator of the run cannot approve it, and the run can be finalized after approval.',
      confirmLabel: 'Approve',
    });
    if (ok) await this.act(() => this.api.post(`/payroll/runs/${this.id}/approve`), 'Payroll approved.');
  }

  async finalize() {
    const ok = await confirmAction(this.dialog, {
      title: 'Finalize payroll?',
      message: 'Finalizing locks every entry and stores its calculation snapshot. Later corrections need a controlled adjustment, not an edit to this run.',
      confirmLabel: 'Finalize and lock',
      destructive: true,
    });
    if (ok) await this.act(() => this.api.post(`/payroll/runs/${this.id}/finalize`), 'Payroll finalized and locked.');
  }

  async bankExport() {
    const csv = await this.notify.run(() => this.api.downloadText(`/payroll/runs/${this.id}/bank-export.csv`), 'Bank file ready. It contains full account numbers: handle it securely.');
    if (csv) {
      saveFile(`bank-transfer-${this.run()?.year}-${String(this.run()?.month).padStart(2, '0')}.csv`, csv);
    }
  }

  async markPaid(e: Entry) {
    const reference = await firstValueFrom(this.dialog.open<PaymentDialog, { name: string }, string>(PaymentDialog, { data: { name: e.employee.name }, width: 'min(460px, 94vw)' }).afterClosed());
    if (!reference) return;
    await this.act(() => this.api.post(`/payroll/entries/${e.id}/payment`, { reference }), 'Payment recorded against the finalized salary.');
  }
}
