import { ChangeDetectionStrategy, Component, OnInit, inject, signal, computed } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators, FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import { Title } from '@angular/platform-browser';
import { firstValueFrom } from 'rxjs';
import { Api, ApiError } from '../../core/api';
import { Auth } from '../../core/auth';
import { Notify, applyFieldErrors } from '../../core/notify';
import { StateView, StatusBadge, confirmAction, type Tone } from '../../shared/ui';
import { formatDate, todayYmd } from '../../shared/format';
import { CorrectionReviewDialog, type ReasonDialogData, type ReviewResult } from '../attendance/correction-review-dialog';
import { NgTemplateOutlet } from '@angular/common';

interface LeaveType {
  id: string;
  code: string;
  name: string;
  isPaid: boolean;
  annualQuotaDays: number;
  accrual: 'UPFRONT' | 'MONTHLY';
  allowHalfDay: boolean;
  carryForwardDays: number;
  isActive: boolean;
}
interface Balance {
  leaveTypeId: string;
  code: string;
  name: string;
  isPaid: boolean;
  entitled: number;
  used: number;
  pending: number;
  available: number | null;
  unlimited: boolean;
}
interface LeaveRequest {
  id: string;
  employee: { id: string; name: string; employeeCode: string };
  leaveType: { code: string; name: string; isPaid: boolean };
  startDate: string;
  endDate: string;
  isHalfDay: boolean;
  days: number;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'CANCEL_REQUESTED';
  decisionComment: string | null;
  isOwn: boolean;
}

const STATUS: Record<LeaveRequest['status'], { label: string; tone: Tone }> = {
  PENDING: { label: 'Pending', tone: 'warn' },
  APPROVED: { label: 'Approved', tone: 'ok' },
  REJECTED: { label: 'Rejected', tone: 'bad' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
  CANCEL_REQUESTED: { label: 'Cancel requested', tone: 'info' },
};

@Component({
  selector: 'ph-leave-type-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatDialogModule, MatButtonModule, MatCheckboxModule, MatFormFieldModule, MatInputModule, MatSelectModule],
  template: `
    <h2 mat-dialog-title>{{ data.id ? 'Edit leave type' : 'New leave type' }}</h2>
    <form [formGroup]="form" (ngSubmit)="save()" novalidate>
      <mat-dialog-content>
        <div class="form-grid">
          <mat-form-field appearance="outline"><mat-label>Code</mat-label><input matInput formControlName="code" /><mat-hint>2 to 10 letters</mat-hint>
            @if (form.controls.code.invalid && form.controls.code.touched) { <mat-error>Use 2 to 10 letters.</mat-error> }
          </mat-form-field>
          <mat-form-field appearance="outline"><mat-label>Name</mat-label><input matInput formControlName="name" />
            @if (form.controls.name.invalid && form.controls.name.touched) { <mat-error>Enter a name.</mat-error> }
          </mat-form-field>
          <mat-form-field appearance="outline"><mat-label>Annual quota (days)</mat-label><input matInput inputmode="decimal" formControlName="annualQuotaDays" />
            @if (form.controls.annualQuotaDays.invalid && form.controls.annualQuotaDays.touched) { <mat-error>Use whole or half days (0 to 366).</mat-error> }
          </mat-form-field>
          <mat-form-field appearance="outline"><mat-label>Carry forward (days)</mat-label><input matInput inputmode="decimal" formControlName="carryForwardDays" /></mat-form-field>
          <mat-form-field appearance="outline"><mat-label>Accrual</mat-label>
            <mat-select formControlName="accrual">
              <mat-option value="UPFRONT">Full quota upfront</mat-option>
              <mat-option value="MONTHLY">Accrues monthly</mat-option>
            </mat-select>
          </mat-form-field>
        </div>
        <div class="flags">
          <mat-checkbox formControlName="isPaid">Paid leave</mat-checkbox>
          <mat-checkbox formControlName="allowHalfDay">Half days allowed</mat-checkbox>
          <mat-checkbox formControlName="isActive">Active</mat-checkbox>
        </div>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" [mat-dialog-close]="null">Cancel</button>
        <button mat-flat-button color="primary" type="submit">Save leave type</button>
      </mat-dialog-actions>
    </form>
  `,
  styles: [`.flags { display: flex; gap: 18px; flex-wrap: wrap; }`],
})
export class LeaveTypeDialog {
  readonly data = inject<{ id?: string; value?: Partial<LeaveType> }>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<LeaveTypeDialog, unknown>>(MatDialogRef);
  private readonly fb = inject(FormBuilder);
  readonly form = this.fb.nonNullable.group({
    code: [this.data.value?.code ?? '', [Validators.required, Validators.pattern(/^[A-Za-z]{2,10}$/)]],
    name: [this.data.value?.name ?? '', [Validators.required, Validators.minLength(2)]],
    annualQuotaDays: [this.data.value?.annualQuotaDays ?? 0, [Validators.required, Validators.min(0), Validators.max(366)]],
    carryForwardDays: [this.data.value?.carryForwardDays ?? 0, [Validators.min(0), Validators.max(366)]],
    accrual: [(this.data.value?.accrual ?? 'UPFRONT') as 'UPFRONT' | 'MONTHLY'],
    isPaid: [this.data.value?.isPaid ?? true],
    allowHalfDay: [this.data.value?.allowHalfDay ?? true],
    isActive: [this.data.value?.isActive ?? true],
  });

  save() {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    const v = this.form.getRawValue();
    this.ref.close({ ...v, annualQuotaDays: Number(v.annualQuotaDays), carryForwardDays: Number(v.carryForwardDays) });
  }
}

@Component({
  selector: 'ph-leave-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    NgTemplateOutlet,
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatTabsModule,
    StateView,
    StatusBadge,
  ],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Leave</h1>
          <p>Balances update when requests are approved. Pending requests reserve days so the same day cannot be booked twice.</p>
        </div>
      </header>

      <mat-tab-group animationDuration="0ms" aria-label="Leave sections">
        <mat-tab label="My leave">
          <section class="card" aria-labelledby="bal-title">
            <h2 id="bal-title" class="card-title">Balances {{ yearLabel() }}</h2>
            <ph-state [state]="balState()" (retry)="loadBalances()" title="Balances could not be loaded">
              <div class="grid balances">
                @for (b of balances(); track b.leaveTypeId) {
                  <div class="balance">
                    <div class="muted">{{ b.name }} ({{ b.code }})</div>
                    <div class="big">{{ b.unlimited ? 'Unpaid, no limit' : b.available + ' available' }}</div>
                    @if (!b.unlimited) {
                      <div class="muted small">{{ b.used }} used · {{ b.pending }} pending · {{ b.entitled }} entitled</div>
                    }
                  </div>
                } @empty {
                  <p class="muted">No leave types are configured yet.</p>
                }
              </div>
            </ph-state>
          </section>

          <section class="card" aria-labelledby="req-title">
            <h2 id="req-title" class="card-title">Request leave</h2>
            <form [formGroup]="form" (ngSubmit)="submit()" novalidate class="form-grid" aria-label="New leave request">
              <mat-form-field appearance="outline">
                <mat-label>Leave type</mat-label>
                <mat-select formControlName="leaveTypeId">
                  @for (t of types(); track t.id) { <mat-option [value]="t.id">{{ t.name }}{{ t.isPaid ? '' : ' (unpaid)' }}</mat-option> }
                </mat-select>
                @if (form.controls.leaveTypeId.invalid && form.controls.leaveTypeId.touched) { <mat-error>Choose a leave type.</mat-error> }
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>From</mat-label>
                <input matInput type="date" formControlName="startDate" [min]="minDate" />
                @if (form.controls.startDate.invalid && form.controls.startDate.touched) { <mat-error>Choose a start date.</mat-error> }
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>To</mat-label>
                <input matInput type="date" formControlName="endDate" [min]="form.controls.startDate.value" />
                @if (form.controls.endDate.invalid && form.controls.endDate.touched) { <mat-error>Choose an end date on or after the start date.</mat-error> }
              </mat-form-field>
              <mat-form-field appearance="outline" class="reason">
                <mat-label>Reason</mat-label>
                <input matInput formControlName="reason" />
                @if (form.controls.reason.invalid && form.controls.reason.touched) { <mat-error>Give a short reason (at least 5 characters).</mat-error> }
              </mat-form-field>
              <div class="half">
                <label class="check"><input type="checkbox" formControlName="isHalfDay" /> Half day (single date, first half assumed)</label>
              </div>
              <div class="submit-row">
                <button mat-flat-button color="primary" type="submit" [disabled]="saving()">Submit request</button>
              </div>
            </form>
          </section>

          <section class="card" aria-labelledby="my-title">
            <h2 id="my-title" class="card-title">My requests</h2>
            <ph-state [state]="reqState()" (retry)="loadRequests()" title="Requests could not be loaded">
              <ng-container *ngTemplateOutlet="requestTable; context: { $implicit: myRequests(), mine: true }"></ng-container>
            </ph-state>
          </section>
        </mat-tab>

        @if (canDecide()) {
          <mat-tab label="Approvals">
            <section class="card" aria-labelledby="appr-title">
              <h2 id="appr-title" class="card-title">Waiting for your decision</h2>
              <ph-state [state]="reqState()" (retry)="loadRequests()" title="Requests could not be loaded">
                <ng-container *ngTemplateOutlet="requestTable; context: { $implicit: pendingForMe(), mine: false }"></ng-container>
              </ph-state>
            </section>

            <section class="card" aria-labelledby="cal-title">
              <div class="toolbar between">
                <h2 id="cal-title" class="card-title">Team availability, {{ calLabel() }}</h2>
                <div class="month-nav">
                  <button mat-icon-button type="button" (click)="shiftCal(-1)" aria-label="Previous month"><mat-icon>chevron_left</mat-icon></button>
                  <button mat-icon-button type="button" (click)="shiftCal(1)" aria-label="Next month"><mat-icon>chevron_right</mat-icon></button>
                </div>
              </div>
              <ph-state [state]="calState()" (retry)="loadCalendar()" title="Availability could not be loaded">
                @if (calendar(); as c) {
                  @if (c.items.length === 0) {
                    <p class="muted">No leave is scheduled this month for your team.</p>
                  }
                  <ul class="avail">
                    @for (i of c.items; track $index) {
                      <li>
                        <strong>{{ i.employee }}</strong> <span class="muted">{{ i.department }}</span>
                        · {{ i.leaveType }} · {{ formatDate(i.startDate) }}@if (i.endDate !== i.startDate) { to {{ formatDate(i.endDate) }} }
                        · <ph-status-badge [label]="i.status === 'PENDING' ? 'Pending' : 'Approved'" [tone]="i.status === 'PENDING' ? 'warn' : 'ok'" />
                      </li>
                    }
                  </ul>
                  @if (c.holidays.length) {
                    <p class="muted small">Holidays: {{ c.holidays.length }} this month (excluded from leave days).</p>
                  }
                }
              </ph-state>
            </section>
          </mat-tab>
        }

        @if (isHr()) {
          <mat-tab label="Leave types">
            <section class="card" aria-labelledby="types-title">
              <div class="toolbar between">
                <h2 id="types-title" class="card-title">Leave policies</h2>
                <button mat-flat-button color="primary" type="button" (click)="editType()"><mat-icon>add</mat-icon> New leave type</button>
              </div>
              <div class="table-wrap">
                <table class="data">
                  <caption class="sr-only">Configured leave types</caption>
                  <thead><tr><th scope="col">Code</th><th scope="col">Name</th><th scope="col" class="num">Quota</th><th scope="col">Accrual</th><th scope="col">Paid</th><th scope="col">Half day</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    @for (t of types(); track t.id) {
                      <tr>
                        <td>{{ t.code }}</td>
                        <td>{{ t.name }}</td>
                        <td class="num">{{ t.annualQuotaDays }}</td>
                        <td>{{ t.accrual === 'MONTHLY' ? 'Monthly' : 'Upfront' }}</td>
                        <td>{{ t.isPaid ? 'Yes' : 'No' }}</td>
                        <td>{{ t.allowHalfDay ? 'Yes' : 'No' }}</td>
                        <td><ph-status-badge [label]="t.isActive ? 'Active' : 'Inactive'" [tone]="t.isActive ? 'ok' : 'neutral'" /></td>
                        <td><button mat-button type="button" (click)="editType(t)">Edit<span class="sr-only"> {{ t.name }}</span></button></td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          </mat-tab>
        }
      </mat-tab-group>

      <ng-template #requestTable let-items let-mine="mine">
        <div class="table-wrap">
          <table class="data">
            <caption class="sr-only">{{ mine ? 'My leave requests' : 'Leave requests awaiting a decision' }}</caption>
            <thead>
              <tr>
                @if (!mine) { <th scope="col">Employee</th> }
                <th scope="col">Type</th><th scope="col">Dates</th><th scope="col" class="num">Days</th><th scope="col">Reason</th><th scope="col">Status</th><th scope="col"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              @for (r of items; track r.id) {
                <tr>
                  @if (!mine) { <td>{{ r.employee.name }} <div class="muted small">{{ r.employee.employeeCode }}</div></td> }
                  <td>{{ r.leaveType.code }}</td>
                  <td>{{ formatDate(r.startDate) }}@if (r.endDate !== r.startDate) { – {{ formatDate(r.endDate) }}}@if (r.isHalfDay) { <span class="muted small"> (half day)</span> }</td>
                  <td class="num">{{ r.days }}</td>
                  <td>{{ r.reason }}@if (r.decisionComment) { <div class="muted small">{{ r.decisionComment }}</div> }</td>
                  <td><ph-status-badge [label]="status(r.status).label" [tone]="status(r.status).tone" /></td>
                  <td class="actions">
                    @if (mine && (r.status === 'PENDING' || r.status === 'APPROVED')) {
                      <button mat-button type="button" (click)="cancel(r)">{{ r.status === 'PENDING' ? 'Withdraw' : 'Request cancellation' }}</button>
                    }
                    @if (!mine && r.status === 'PENDING') {
                      <button mat-stroked-button type="button" (click)="decide(r, 'APPROVE')">Approve</button>
                      <button mat-button type="button" color="warn" (click)="decide(r, 'REJECT')">Reject</button>
                    }
                    @if (!mine && r.status === 'CANCEL_REQUESTED') {
                      <button mat-stroked-button type="button" (click)="decideCancel(r, 'APPROVE')">Approve cancel</button>
                      <button mat-button type="button" (click)="decideCancel(r, 'REJECT')">Keep leave</button>
                    }
                  </td>
                </tr>
              } @empty {
                <tr><td [attr.colspan]="mine ? 6 : 7" class="muted">{{ mine ? 'You have not requested leave yet.' : 'Nothing waiting for a decision.' }}</td></tr>
              }
            </tbody>
          </table>
        </div>
      </ng-template>
    </div>
  `,
  styles: [
    `
      .muted { color: var(--ph-text-muted); }
      .small { font-size: 12px; }
      .between { justify-content: space-between; }
      .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
      .balances { grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }
      .balance { border: 1px solid var(--ph-border); border-radius: 12px; padding: 14px; background: var(--ph-surface-muted); }
      .big { font-size: 20px; font-weight: 650; margin-top: 4px; font-variant-numeric: tabular-nums; }
      form.form-grid { grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0 14px; align-items: start; }
      .reason { grid-column: span 2; }
      .half { display: flex; align-items: center; min-height: 56px; }
      .check { display: inline-flex; gap: 8px; align-items: center; }
      .submit-row { display: flex; align-items: center; min-height: 56px; }
      .actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
      .avail { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
      .month-nav { display: flex; align-items: center; gap: 4px; }
      @media (max-width: 640px) { .reason { grid-column: auto; } }
    `,
  ],
})
export class LeavePage implements OnInit {
  readonly auth = inject(Auth);
  private readonly api = inject(Api);
  private readonly notify = inject(Notify);
  private readonly dialog = inject(MatDialog);
  private readonly fb = inject(FormBuilder);
  private readonly title = inject(Title);
  readonly formatDate = formatDate;
  readonly minDate = todayYmd();

  readonly types = signal<LeaveType[]>([]);
  readonly balances = signal<Balance[]>([]);
  readonly balState = signal<'loading' | 'ready' | 'error'>('loading');
  readonly requests = signal<LeaveRequest[]>([]);
  readonly reqState = signal<'loading' | 'ready' | 'error'>('loading');
  readonly saving = signal(false);

  readonly calRef = new Date();
  readonly calYear = signal(this.calRef.getFullYear());
  readonly calMonth = signal(this.calRef.getMonth() + 1);
  readonly calendar = signal<{ items: { employee: string; department: string; leaveType: string; status: string; startDate: string; endDate: string }[]; holidays: unknown[] } | null>(null);
  readonly calState = signal<'loading' | 'ready' | 'error'>('loading');
  readonly calLabel = computed(() => new Date(this.calYear(), this.calMonth() - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }));

  readonly myRequests = computed(() => this.requests().filter((r) => r.isOwn));
  readonly pendingForMe = computed(() => this.requests().filter((r) => !r.isOwn && (r.status === 'PENDING' || r.status === 'CANCEL_REQUESTED')));
  readonly isHr = computed(() => this.auth.isHr());
  readonly canDecide = computed(() => {
    const role = this.auth.user()?.role;
    return role === 'HR_ADMIN' || role === 'SUPER_ADMIN' || role === 'MANAGER';
  });
  readonly yearLabel = computed(() => `FY ${this.calYear()}`);

  readonly form = this.fb.nonNullable.group({
    leaveTypeId: ['', [Validators.required]],
    startDate: ['', [Validators.required]],
    endDate: ['', [Validators.required]],
    reason: ['', [Validators.required, Validators.minLength(5), Validators.maxLength(500)]],
    isHalfDay: [false],
  });

  ngOnInit() {
    this.title.setTitle('Leave | PeopleHub');
    void this.loadTypes();
    void this.loadBalances();
    void this.loadRequests();
    if (this.canDecide()) void this.loadCalendar();
  }

  status(s: LeaveRequest['status']) {
    return STATUS[s];
  }

  async loadTypes() {
    try {
      this.types.set((await this.api.get<{ items: LeaveType[] }>('/leave/types')).items);
    } catch {
      this.notify.error('Leave types could not be loaded.');
    }
  }

  async loadBalances() {
    this.balState.set('loading');
    try {
      this.balances.set((await this.api.get<{ items: Balance[] }>('/leave/balances')).items);
      this.balState.set('ready');
    } catch {
      this.balState.set('error');
    }
  }

  async loadRequests() {
    this.reqState.set('loading');
    try {
      this.requests.set((await this.api.get<{ items: LeaveRequest[] }>('/leave/requests')).items);
      this.reqState.set('ready');
    } catch {
      this.reqState.set('error');
    }
  }

  async loadCalendar() {
    this.calState.set('loading');
    try {
      this.calendar.set(await this.api.get('/leave/calendar', { year: this.calYear(), month: this.calMonth() }));
      this.calState.set('ready');
    } catch {
      this.calState.set('error');
    }
  }

  shiftCal(delta: number) {
    const d = new Date(this.calYear(), this.calMonth() - 1 + delta, 1);
    this.calYear.set(d.getFullYear());
    this.calMonth.set(d.getMonth() + 1);
    void this.loadCalendar();
  }

  async submit() {
    this.form.markAllAsTouched();
    const v = this.form.getRawValue();
    if (this.form.invalid) return;
    if (v.endDate < v.startDate) {
      this.form.controls.endDate.setErrors({ server: 'The end date must be on or after the start date.' });
      return;
    }
    if (v.isHalfDay && v.endDate !== v.startDate) {
      this.form.controls.endDate.setErrors({ server: 'A half day must use the same date for start and end.' });
      return;
    }
    this.saving.set(true);
    try {
      const res = await this.api.post<{ days: number }>('/leave/requests', {
        leaveTypeId: v.leaveTypeId,
        startDate: v.startDate,
        endDate: v.endDate,
        isHalfDay: v.isHalfDay,
        reason: v.reason,
      });
      this.notify.success(`Request submitted for ${res.days} working day(s). Your manager will review it.`);
      this.form.patchValue({ startDate: '', endDate: '', reason: '', isHalfDay: false });
      this.form.markAsUntouched();
      await Promise.all([this.loadRequests(), this.loadBalances()]);
    } catch (err) {
      if (!applyFieldErrors(this.form, err)) this.notify.error(err instanceof ApiError ? err.message : 'Could not submit the request.');
    } finally {
      this.saving.set(false);
    }
  }

  async cancel(r: LeaveRequest) {
    const reason = await firstValueFrom(
      this.dialog.open<CorrectionReviewDialog, ReasonDialogData, ReviewResult>(CorrectionReviewDialog, {
        data: {
          name: r.leaveType.name,
          title: r.status === 'PENDING' ? 'Withdraw this request?' : 'Request cancellation of approved leave?',
          label: 'Reason',
          confirmLabel: r.status === 'PENDING' ? 'Withdraw' : 'Send request',
        },
        width: 'min(460px, 94vw)',
      }).afterClosed(),
    );
    if (!reason) return;
    const done = await this.notify.run(
      () => this.api.post(`/leave/requests/${r.id}/cancel`, { reason: reason.comment }),
      r.status === 'PENDING' ? 'Request withdrawn.' : 'Cancellation requested. Your manager will confirm.',
    );
    if (done !== undefined) await Promise.all([this.loadRequests(), this.loadBalances()]);
  }

  async decide(r: LeaveRequest, decision: 'APPROVE' | 'REJECT') {
    let comment: string | undefined;
    if (decision === 'REJECT') {
      const result = await firstValueFrom(
        this.dialog.open<CorrectionReviewDialog, ReasonDialogData, ReviewResult>(CorrectionReviewDialog, {
          data: { name: r.employee.name, title: `Reject leave for ${r.employee.name}?`, label: 'Reason for the employee', confirmLabel: 'Reject leave' },
          width: 'min(460px, 94vw)',
        }).afterClosed(),
      );
      if (!result) return;
      comment = result.comment;
    } else {
      const ok = await confirmAction(this.dialog, {
        title: `Approve ${r.days} day(s) for ${r.employee.name}?`,
        message: `${r.leaveType.code} from ${formatDate(r.startDate)}${r.endDate !== r.startDate ? ' to ' + formatDate(r.endDate) : ''}. This reduces their balance.`,
        confirmLabel: 'Approve leave',
      });
      if (!ok) return;
    }
    const done = await this.notify.run(
      () => this.api.post(`/leave/requests/${r.id}/decision`, { decision, comment }),
      decision === 'APPROVE' ? 'Leave approved.' : 'Leave rejected. The employee has been informed.',
    );
    if (done !== undefined) await this.loadRequests();
  }

  async decideCancel(r: LeaveRequest, decision: 'APPROVE' | 'REJECT') {
    const ok = await confirmAction(this.dialog, {
      title: decision === 'APPROVE' ? 'Cancel this approved leave?' : 'Keep this leave?',
      message: decision === 'APPROVE' ? 'The days will be returned to the employee balance.' : 'The leave stays approved and the balance is unchanged.',
      confirmLabel: decision === 'APPROVE' ? 'Cancel leave' : 'Keep leave',
      destructive: decision === 'APPROVE',
    });
    if (!ok) return;
    const done = await this.notify.run(() => this.api.post(`/leave/requests/${r.id}/cancellation-decision`, { decision }), decision === 'APPROVE' ? 'Leave cancelled and days returned.' : 'Leave kept.');
    if (done !== undefined) await Promise.all([this.loadRequests(), this.loadBalances()]);
  }

  editType(t?: LeaveType) {
    this.dialog
      .open(LeaveTypeDialog, { data: { id: t?.id, value: t }, width: 'min(640px, 94vw)' })
      .afterClosed()
      .subscribe(async (value: unknown) => {
        if (!value) return;
        const body = value as Record<string, unknown>;
        const done = await this.notify.run(
          () => (t ? this.api.patch(`/leave/types/${t.id}`, body) : this.api.post('/leave/types', body)),
          t ? 'Leave type updated.' : 'Leave type created.',
        );
        if (done !== undefined) {
          await Promise.all([this.loadTypes(), this.loadBalances()]);
        }
      });
  }
}
