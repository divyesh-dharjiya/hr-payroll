import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import { Title } from '@angular/platform-browser';
import { Api, ApiError } from '../../core/api';
import { Auth } from '../../core/auth';
import { Notify, applyFieldErrors } from '../../core/notify';
import { StateView, StatusBadge, type Tone } from '../../shared/ui';
import { formatPaise, monthName } from '../../shared/format';

interface RunRow {
  id: string;
  year: number;
  month: number;
  status: 'DRAFT' | 'VALIDATED' | 'APPROVED' | 'FINALIZED';
  employeeCount: number;
  totalGrossPaise: number;
  totalDeductionsPaise: number;
  totalNetPaise: number;
  totalEmployerPaise: number;
  finalizedAt: string | null;
}

interface Adjustment {
  id: string;
  employee: { id: string; name: string; employeeCode: string };
  kind: 'EARNING' | 'DEDUCTION';
  label: string;
  amountPaise: number;
}
interface SummaryRow {
  month: number;
  employees: number;
  grossPaise: number;
  deductionsPaise: number;
  netPaise: number;
  employerPaise: number;
}

const STATUS: Record<RunRow['status'], { label: string; tone: Tone }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  VALIDATED: { label: 'Validated', tone: 'info' },
  APPROVED: { label: 'Approved', tone: 'warn' },
  FINALIZED: { label: 'Finalized', tone: 'ok' },
};

@Component({
  selector: 'ph-adjustment-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule],
  template: `
    <h2 mat-dialog-title>Payroll adjustment for {{ data.period }}</h2>
    <form [formGroup]="form" (ngSubmit)="save()" novalidate>
      <mat-dialog-content>
        <div class="form-grid">
          <mat-form-field appearance="outline">
            <mat-label>Employee</mat-label>
            <mat-select formControlName="employeeId">
              @for (e of data.employees; track e.id) { <mat-option [value]="e.id">{{ e.name }} ({{ e.employeeCode }})</mat-option> }
            </mat-select>
            @if (form.controls.employeeId.invalid && form.controls.employeeId.touched) { <mat-error>Choose an employee.</mat-error> }
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Type</mat-label>
            <mat-select formControlName="kind">
              <mat-option value="EARNING">Earning (adds to pay)</mat-option>
              <mat-option value="DEDUCTION">Deduction (reduces pay)</mat-option>
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Description</mat-label>
            <input matInput formControlName="label" />
            @if (form.controls.label.invalid && form.controls.label.touched) { <mat-error>Describe the adjustment.</mat-error> }
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Amount (₹)</mat-label>
            <input matInput inputmode="decimal" formControlName="amount" />
            @if (form.controls.amount.invalid && form.controls.amount.touched) { <mat-error>Enter an amount greater than zero, such as 1500 or 1500.50.</mat-error> }
          </mat-form-field>
        </div>
        <p class="muted small">Adjustments apply to this period only. They are included when the run is recalculated.</p>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" [mat-dialog-close]="null">Cancel</button>
        <button mat-flat-button color="primary" type="submit">Add adjustment</button>
      </mat-dialog-actions>
    </form>
  `,
  styles: [`.muted { color: var(--ph-text-muted); } .small { font-size: 12px; }`],
})
export class AdjustmentDialog {
  readonly data = inject<{ period: string; employees: { id: string; name: string; employeeCode: string }[] }>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<AdjustmentDialog, unknown>>(MatDialogRef);
  private readonly fb = inject(FormBuilder);
  readonly form = this.fb.nonNullable.group({
    employeeId: ['', [Validators.required]],
    kind: ['EARNING' as 'EARNING' | 'DEDUCTION'],
    label: ['', [Validators.required, Validators.minLength(2)]],
    amount: ['', [Validators.required, Validators.pattern(/^\d+(\.\d{1,2})?$/)]],
  });

  save() {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    this.ref.close(this.form.getRawValue());
  }
}

@Component({
  selector: 'ph-payroll-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule, MatSelectModule, MatTabsModule, StateView, StatusBadge],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Payroll</h1>
          <p>Runs move through Draft, Validated, Approved and Finalized. Finalized runs are locked; changes need a new run.</p>
        </div>
      </header>

      <mat-tab-group animationDuration="0ms" aria-label="Payroll sections">
        <mat-tab label="Runs">
          @if (auth.has('payroll:manage')) {
            <section class="card" aria-labelledby="new-run-title">
              <h2 id="new-run-title" class="card-title">Start a payroll run</h2>
              <form [formGroup]="runForm" (ngSubmit)="createRun()" novalidate class="inline-form" aria-label="New payroll run">
                <mat-form-field appearance="outline">
                  <mat-label>Month</mat-label>
                  <mat-select formControlName="month">
                    @for (m of months; track m) { <mat-option [value]="m">{{ monthLabel(m) }}</mat-option> }
                  </mat-select>
                </mat-form-field>
                <mat-form-field appearance="outline">
                  <mat-label>Year</mat-label>
                  <input matInput type="number" formControlName="year" min="2000" max="2100" />
                  @if (runForm.controls.year.invalid && runForm.controls.year.touched) { <mat-error>Enter a valid year.</mat-error> }
                </mat-form-field>
                <button mat-flat-button color="primary" type="submit" [disabled]="busy()">Create draft</button>
              </form>
            </section>
          }

          <section class="card" aria-labelledby="runs-title">
            <h2 id="runs-title" class="card-title">Payroll runs</h2>
            <ph-state [state]="state()" (retry)="load()" title="Payroll runs could not be loaded">
              <div class="table-wrap">
                <table class="data">
                  <caption class="sr-only">Payroll runs by month</caption>
                  <thead>
                    <tr>
                      <th scope="col">Period</th><th scope="col">Status</th><th scope="col" class="num">Employees</th>
                      <th scope="col" class="num">Gross</th><th scope="col" class="num">Net pay</th><th scope="col" class="num">Employer cost</th>
                      <th scope="col"><span class="sr-only">Open</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (r of runs(); track r.id) {
                      <tr>
                        <td><a [routerLink]="['/payroll', r.id]">{{ monthLabel(r.month) }} {{ r.year }}</a></td>
                        <td><ph-status-badge [label]="status(r.status).label" [tone]="status(r.status).tone" /></td>
                        <td class="num">{{ r.employeeCount }}</td>
                        <td class="num">{{ paise(r.totalGrossPaise) }}</td>
                        <td class="num">{{ paise(r.totalNetPaise) }}</td>
                        <td class="num">{{ paise(r.totalGrossPaise + r.totalEmployerPaise) }}</td>
                        <td><a mat-button [routerLink]="['/payroll', r.id]">Open</a></td>
                      </tr>
                    } @empty {
                      <tr><td colspan="7" class="muted">No payroll runs yet. Start one above.</td></tr>
                    }
                  </tbody>
                </table>
              </div>
            </ph-state>
          </section>
        </mat-tab>

        <mat-tab label="Adjustments">
          <section class="card" aria-labelledby="adj-title">
            <div class="toolbar between">
              <h2 id="adj-title" class="card-title">One-off adjustments</h2>
              @if (auth.has('payroll:manage')) {
                <button mat-flat-button color="primary" type="button" (click)="addAdjustment()"><mat-icon>add</mat-icon> Add adjustment</button>
              }
            </div>
            <form [formGroup]="adjPeriod" class="inline-form" aria-label="Choose period">
              <mat-form-field appearance="outline">
                <mat-label>Month</mat-label>
                <mat-select formControlName="month" (selectionChange)="loadAdjustments()">
                  @for (m of months; track m) { <mat-option [value]="m">{{ monthLabel(m) }}</mat-option> }
                </mat-select>
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Year</mat-label>
                <input matInput type="number" formControlName="year" (change)="loadAdjustments()" />
              </mat-form-field>
            </form>
            <ph-state [state]="adjState()" (retry)="loadAdjustments()" title="Adjustments could not be loaded">
              <div class="table-wrap">
                <table class="data">
                  <caption class="sr-only">Adjustments for the selected month</caption>
                  <thead><tr><th scope="col">Employee</th><th scope="col">Type</th><th scope="col">Description</th><th scope="col" class="num">Amount</th></tr></thead>
                  <tbody>
                    @for (a of adjustments(); track a.id) {
                      <tr>
                        <td>{{ a.employee.name }} <span class="muted small">{{ a.employee.employeeCode }}</span></td>
                        <td>{{ a.kind === 'EARNING' ? 'Earning' : 'Deduction' }}</td>
                        <td>{{ a.label }}</td>
                        <td class="num">{{ paise(a.amountPaise) }}</td>
                      </tr>
                    } @empty {
                      <tr><td colspan="4" class="muted">No adjustments for this month.</td></tr>
                    }
                  </tbody>
                </table>
              </div>
            </ph-state>
          </section>
        </mat-tab>

        <mat-tab label="Annual summary">
          <section class="card" aria-labelledby="sum-title">
            <div class="toolbar between">
              <h2 id="sum-title" class="card-title">Finalized months, {{ summaryYear() }}</h2>
              <div class="toolbar">
                <button mat-stroked-button type="button" (click)="shiftYear(-1)">Previous year</button>
                <button mat-stroked-button type="button" (click)="shiftYear(1)">Next year</button>
              </div>
            </div>
            <ph-state [state]="sumState()" (retry)="loadSummary()" title="Summary could not be loaded">
              <div class="table-wrap">
                <table class="data">
                  <caption class="sr-only">Finalized payroll totals by month</caption>
                  <thead><tr><th scope="col">Month</th><th scope="col" class="num">Employees</th><th scope="col" class="num">Gross</th><th scope="col" class="num">Deductions</th><th scope="col" class="num">Net pay</th><th scope="col" class="num">Employer contributions</th></tr></thead>
                  <tbody>
                    @for (s of summary(); track s.month) {
                      <tr>
                        <td>{{ monthLabel(s.month) }}</td>
                        <td class="num">{{ s.employees }}</td>
                        <td class="num">{{ paise(s.grossPaise) }}</td>
                        <td class="num">{{ paise(s.deductionsPaise) }}</td>
                        <td class="num">{{ paise(s.netPaise) }}</td>
                        <td class="num">{{ paise(s.employerPaise) }}</td>
                      </tr>
                    } @empty {
                      <tr><td colspan="6" class="muted">No finalized months in {{ summaryYear() }}.</td></tr>
                    }
                  </tbody>
                </table>
              </div>
            </ph-state>
          </section>
        </mat-tab>
      </mat-tab-group>
    </div>
  `,
  styles: [
    `
      .muted { color: var(--ph-text-muted); }
      .small { font-size: 12px; }
      .between { justify-content: space-between; }
      .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
      .inline-form { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; margin-bottom: 12px; }
      .inline-form mat-form-field { width: 180px; }
      .inline-form button { margin-top: 6px; }
    `,
  ],
})
export class PayrollPage implements OnInit {
  readonly auth = inject(Auth);
  private readonly api = inject(Api);
  private readonly notify = inject(Notify);
  private readonly fb = inject(FormBuilder);
  private readonly dialog = inject(MatDialog);
  private readonly title = inject(Title);
  readonly paise = formatPaise;
  readonly months = Array.from({ length: 12 }, (_, i) => i + 1);
  readonly monthLabel = (m: number) => monthName(m);
  readonly status = (s: RunRow['status']) => STATUS[s];

  readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  readonly runs = signal<RunRow[]>([]);
  readonly busy = signal(false);
  private readonly router = inject(Router);

  readonly now = new Date();
  readonly runForm = this.fb.nonNullable.group({
    month: [this.now.getMonth() + 1, [Validators.required]],
    year: [this.now.getFullYear(), [Validators.required, Validators.min(2000), Validators.max(2100)]],
  });
  readonly adjPeriod = this.fb.nonNullable.group({
    month: [this.now.getMonth() + 1],
    year: [this.now.getFullYear()],
  });
  readonly adjState = signal<'loading' | 'ready' | 'error'>('ready');
  readonly adjustments = signal<Adjustment[]>([]);
  readonly employees = signal<{ id: string; name: string; employeeCode: string }[]>([]);

  readonly summaryYear = signal(this.now.getFullYear());
  readonly sumState = signal<'loading' | 'ready' | 'error'>('loading');
  readonly summary = signal<SummaryRow[]>([]);

  ngOnInit() {
    this.title.setTitle('Payroll | PeopleHub');
    void this.load();
    void this.loadAdjustments();
    void this.loadSummary();
    if (this.auth.has('payroll:manage')) void this.loadEmployees();
  }

  async load() {
    this.state.set('loading');
    try {
      this.runs.set((await this.api.get<{ items: RunRow[] }>('/payroll/runs')).items);
      this.state.set('ready');
    } catch {
      this.state.set('error');
    }
  }

  async createRun() {
    this.runForm.markAllAsTouched();
    if (this.runForm.invalid) return;
    this.busy.set(true);
    const v = this.runForm.getRawValue();
    try {
      const res = await this.api.post<{ id: string }>('/payroll/runs', { year: v.year, month: v.month });
      this.notify.success(`Draft run created for ${monthName(v.month)} ${v.year}.`);
      await this.router.navigate(['/payroll', res.id]);
    } catch (err) {
      const existing = err instanceof ApiError && err.status === 409 ? (err.details as { id?: string } | null)?.id : undefined;
      if (existing) {
        this.notify.error('A run already exists for this month. Opening it.');
        await this.router.navigate(['/payroll', existing]);
        return;
      }
      if (!applyFieldErrors(this.runForm, err)) this.notify.error(err instanceof ApiError ? err.message : 'Could not create the run.');
    } finally {
      this.busy.set(false);
    }
  }

  async loadEmployees() {
    try {
      const res = await this.api.get<{ items: { id: string; name: string; employeeCode: string }[] }>('/employees/', { pageSize: 100, sort: 'name' });
      this.employees.set(res.items);
    } catch {
      this.employees.set([]);
    }
  }

  async loadAdjustments() {
    const v = this.adjPeriod.getRawValue();
    this.adjState.set('loading');
    try {
      this.adjustments.set((await this.api.get<{ items: Adjustment[] }>('/payroll/adjustments', { year: v.year, month: v.month })).items);
      this.adjState.set('ready');
    } catch {
      this.adjState.set('error');
    }
  }

  addAdjustment() {
    const v = this.adjPeriod.getRawValue();
    this.dialog
      .open(AdjustmentDialog, {
        data: { period: `${monthName(v.month)} ${v.year}`, employees: this.employees() },
        width: 'min(560px, 94vw)',
      })
      .afterClosed()
      .subscribe(async (value: unknown) => {
        if (!value) return;
        const body = { ...(value as Record<string, unknown>), year: v.year, month: v.month };
        const ok = await this.notify.run(() => this.api.post('/payroll/adjustments', body), 'Adjustment added.');
        if (ok !== undefined) await this.loadAdjustments();
      });
  }

  shiftYear(delta: number) {
    this.summaryYear.set(this.summaryYear() + delta);
    void this.loadSummary();
  }

  async loadSummary() {
    this.sumState.set('loading');
    try {
      this.summary.set((await this.api.get<{ items: SummaryRow[] }>('/payroll/reports/summary', { year: this.summaryYear() })).items);
      this.sumState.set('ready');
    } catch {
      this.sumState.set('error');
    }
  }
}

@Component({
  selector: 'ph-payment-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>Record payment for {{ data.name }}</h2>
    <form [formGroup]="form" (ngSubmit)="save()" novalidate>
      <mat-dialog-content>
        <p class="muted">Recording a payment does not move money. Enter the bank reference after the transfer has been made.</p>
        <mat-form-field appearance="outline">
          <mat-label>Bank transaction reference (UTR)</mat-label>
          <input matInput formControlName="reference" autocomplete="off" />
          @if (form.controls.reference.invalid && form.controls.reference.touched) { <mat-error>Enter the transaction reference.</mat-error> }
        </mat-form-field>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" [mat-dialog-close]="null">Cancel</button>
        <button mat-flat-button color="primary" type="submit">Mark as paid</button>
      </mat-dialog-actions>
    </form>
  `,
  styles: [`.muted { color: var(--ph-text-muted); }`],
})
export class PaymentDialog {
  readonly data = inject<{ name: string }>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<PaymentDialog, string>>(MatDialogRef);
  private readonly fb = inject(FormBuilder);
  readonly form = this.fb.nonNullable.group({ reference: ['', [Validators.required, Validators.minLength(3), Validators.maxLength(64)]] });
  save() {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    this.ref.close(this.form.getRawValue().reference.trim());
  }
}
