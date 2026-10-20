import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule, ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import { Title } from '@angular/platform-browser';
import { firstValueFrom } from 'rxjs';
import { Api } from '../../core/api';
import { Auth } from '../../core/auth';
import { Notify } from '../../core/notify';
import { StateView, StatusBadge, confirmAction, type Tone } from '../../shared/ui';
import { formatDate, formatMinutes, monthName, todayYmd } from '../../shared/format';
import { TodayAttendanceCard } from './today-card';
import { CorrectionReviewDialog, type ReviewResult } from './correction-review-dialog';

interface CalendarDay {
  date: string;
  status: string;
  workedMinutes?: number;
  lateMinutes?: number;
  overtimeMinutes?: number;
  leave?: { leaveTypeCode: string; isPaid: boolean; days: number };
}
interface Calendar {
  employee: { id: string; name: string };
  year: number;
  month: number;
  days: CalendarDay[];
  totals: { workedMinutes: number; lateMinutes: number; overtimeMinutes: number };
  counts: Record<string, number>;
}
interface SummaryRow {
  employee: { id: string; employeeCode: string; name: string };
  present: number;
  late: number;
  halfDay: number;
  absent: number;
  onLeave: number;
  workedHours: number;
  overtimeHours: number;
}
interface Correction {
  id: string;
  employee: { name: string; employeeCode: string };
  workDate: string;
  requestedCheckIn: string | null;
  requestedCheckOut: string | null;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reviewComment: string | null;
  createdAt: string;
}

const STATUS_VIEW: Record<string, { label: string; tone: Tone }> = {
  PRESENT: { label: 'Present', tone: 'ok' },
  LATE: { label: 'Late', tone: 'warn' },
  HALF_DAY: { label: 'Half day', tone: 'warn' },
  WFH: { label: 'WFH', tone: 'info' },
  ABSENT: { label: 'Absent', tone: 'bad' },
  ON_LEAVE: { label: 'Leave', tone: 'info' },
  HOLIDAY: { label: 'Holiday', tone: 'neutral' },
  WEEKLY_OFF: { label: 'Week off', tone: 'neutral' },
  NOT_EMPLOYED: { label: '—', tone: 'neutral' },
  FUTURE: { label: '', tone: 'neutral' },
};

@Component({
  selector: 'ph-attendance-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    ReactiveFormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatTabsModule,
    StateView,
    StatusBadge,
    TodayAttendanceCard,
  ],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Attendance</h1>
          <p>Check-in and check-out are recorded by the server. Corrections go to your manager or HR for approval.</p>
        </div>
      </header>

      <ph-today-attendance (changed)="reloadCalendar()" />

      <mat-tab-group animationDuration="0ms" aria-label="Attendance views">
        <mat-tab label="My calendar">
          <section class="card" aria-labelledby="cal-title">
            <div class="toolbar cal-toolbar">
              <h2 id="cal-title" class="card-title">{{ monthTitle() }}</h2>
              <div class="month-nav">
                <button mat-icon-button type="button" (click)="shiftMonth(-1)" aria-label="Previous month"><mat-icon>chevron_left</mat-icon></button>
                <button mat-stroked-button type="button" (click)="resetMonth()">This month</button>
                <button mat-icon-button type="button" (click)="shiftMonth(1)" aria-label="Next month"><mat-icon>chevron_right</mat-icon></button>
              </div>
            </div>
            <ph-state [state]="calState()" (retry)="reloadCalendar()" title="Calendar could not be loaded">
              @if (calendar(); as c) {
                <div class="totals" aria-label="Month totals">
                  <div><span>Worked</span><strong>{{ minutes(c.totals.workedMinutes) }}</strong></div>
                  <div><span>Late arrivals (minutes)</span><strong>{{ c.totals.lateMinutes }}</strong></div>
                  <div><span>Overtime</span><strong>{{ minutes(c.totals.overtimeMinutes) }}</strong></div>
                  <div><span>Present days</span><strong>{{ (c.counts['PRESENT'] || 0) + (c.counts['LATE'] || 0) + (c.counts['WFH'] || 0) + (c.counts['HALF_DAY'] || 0) }}</strong></div>
                  <div><span>Absent days</span><strong>{{ c.counts['ABSENT'] || 0 }}</strong></div>
                  <div><span>Leave days</span><strong>{{ c.counts['ON_LEAVE'] || 0 }}</strong></div>
                </div>
                <div class="weekdays" aria-hidden="true">
                  @for (w of weekdays; track w) { <span>{{ w }}</span> }
                </div>
                <div class="cal" role="grid" [attr.aria-label]="monthTitle()">
                  @for (pad of leadPadding(); track $index) { <span class="cell pad" aria-hidden="true"></span> }
                  @for (d of c.days; track d.date) {
                    <div class="cell" [class.today]="d.date === today" [class.muted-day]="d.status === 'WEEKLY_OFF' || d.status === 'HOLIDAY' || d.status === 'FUTURE' || d.status === 'NOT_EMPLOYED'" role="gridcell" [attr.aria-label]="cellLabel(d)">
                      <span class="dnum">{{ dayNumber(d.date) }}</span>
                      @if (view(d.status).label) {
                        <ph-status-badge [label]="view(d.status).label" [tone]="view(d.status).tone" />
                      }
                      @if ((d.workedMinutes ?? 0) > 0) {
                        <span class="hrs">{{ minutes(d.workedMinutes ?? 0) }}</span>
                      }
                    </div>
                  }
                </div>
                <p class="legend muted small">Absent is inferred for past working days with no check-in and no approved leave. Today stays open until the day closes.</p>
              }
            </ph-state>
          </section>

          <section class="card" aria-labelledby="corr-title">
            <div class="toolbar between">
              <h2 id="corr-title" class="card-title">Attendance corrections</h2>
            </div>
            <form [formGroup]="correctionForm" (ngSubmit)="submitCorrection()" novalidate class="correction" aria-label="Request a correction">
              <mat-form-field appearance="outline">
                <mat-label>Date</mat-label>
                <input matInput type="date" formControlName="workDate" [max]="today" />
                @if (correctionForm.controls.workDate.invalid && correctionForm.controls.workDate.touched) { <mat-error>Choose a date in the last 31 days.</mat-error> }
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Correct check-in</mat-label>
                <input matInput type="datetime-local" formControlName="checkIn" />
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Correct check-out</mat-label>
                <input matInput type="datetime-local" formControlName="checkOut" />
              </mat-form-field>
              <mat-form-field appearance="outline" class="reason">
                <mat-label>Reason</mat-label>
                <input matInput formControlName="reason" />
                @if (correctionForm.controls.reason.invalid && correctionForm.controls.reason.touched) { <mat-error>Explain the correction (at least 5 characters).</mat-error> }
              </mat-form-field>
              <button mat-flat-button color="primary" type="submit" [disabled]="savingCorrection()">Request correction</button>
            </form>
            <ph-state [state]="corrState()" (retry)="loadCorrections()" title="Corrections could not be loaded">
              <div class="table-wrap">
                <table class="data">
                  <caption class="sr-only">Your attendance correction requests</caption>
                  <thead><tr><th scope="col">Date</th><th scope="col">Requested</th><th scope="col">Reason</th><th scope="col">Status</th></tr></thead>
                  <tbody>
                    @for (c of myCorrections(); track c.id) {
                      <tr>
                        <td>{{ formatDate(c.workDate) }}</td>
                        <td>{{ hm(c.requestedCheckIn) }} – {{ hm(c.requestedCheckOut) }}</td>
                        <td>{{ c.reason }}@if (c.reviewComment) { <div class="muted small">Reviewer: {{ c.reviewComment }}</div> }</td>
                        <td><ph-status-badge [label]="corrLabel(c.status)" [tone]="corrTone(c.status)" /></td>
                      </tr>
                    } @empty {
                      <tr><td colspan="4" class="muted">No correction requests yet.</td></tr>
                    }
                  </tbody>
                </table>
              </div>
            </ph-state>
          </section>
        </mat-tab>

        @if (canReview()) {
          <mat-tab label="Team review">
            <section class="card" aria-labelledby="review-title">
              <h2 id="review-title" class="card-title">Corrections waiting for review</h2>
              <ph-state [state]="reviewState()" (retry)="loadReview()" title="Review queue could not be loaded">
                <div class="table-wrap">
                  <table class="data">
                    <caption class="sr-only">Pending correction requests from your team</caption>
                    <thead><tr><th scope="col">Employee</th><th scope="col">Date</th><th scope="col">Requested</th><th scope="col">Reason</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
                    <tbody>
                      @for (c of pending(); track c.id) {
                        <tr>
                          <td>{{ c.employee.name }} <div class="muted small">{{ c.employee.employeeCode }}</div></td>
                          <td>{{ formatDate(c.workDate) }}</td>
                          <td>{{ hm(c.requestedCheckIn) }} – {{ hm(c.requestedCheckOut) }}</td>
                          <td>{{ c.reason }}</td>
                          <td class="actions">
                            <button mat-stroked-button type="button" (click)="review(c, 'APPROVE')">Approve</button>
                            <button mat-button type="button" color="warn" (click)="review(c, 'REJECT')">Reject</button>
                          </td>
                        </tr>
                      } @empty {
                        <tr><td colspan="5" class="muted">Nothing waiting for review.</td></tr>
                      }
                    </tbody>
                  </table>
                </div>
              </ph-state>
            </section>

            <section class="card" aria-labelledby="summary-title">
              <div class="toolbar between">
                <h2 id="summary-title" class="card-title">Monthly summary</h2>
                <div class="toolbar">
                  <mat-form-field appearance="outline" class="month-pick">
                    <mat-label>Month</mat-label>
                    <mat-select [ngModel]="summaryMonth()" (ngModelChange)="setSummaryMonth($event)">
                      @for (m of monthOptions; track m.value) { <mat-option [value]="m.value">{{ m.label }}</mat-option> }
                    </mat-select>
                  </mat-form-field>
                </div>
              </div>
              <ph-state [state]="summaryState()" (retry)="loadSummary()" title="Summary could not be loaded">
                <div class="table-wrap">
                  <table class="data">
                    <caption class="sr-only">Attendance summary per employee for the selected month</caption>
                    <thead>
                      <tr>
                        <th scope="col">Employee</th><th scope="col" class="num">Present</th><th scope="col" class="num">Late</th>
                        <th scope="col" class="num">Half day</th><th scope="col" class="num">Absent</th><th scope="col" class="num">Leave</th>
                        <th scope="col" class="num">Worked (h)</th><th scope="col" class="num">Overtime (h)</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (r of summary(); track r.employee.id) {
                        <tr>
                          <td>{{ r.employee.name }} <div class="muted small">{{ r.employee.employeeCode }}</div></td>
                          <td class="num">{{ r.present }}</td><td class="num">{{ r.late }}</td><td class="num">{{ r.halfDay }}</td>
                          <td class="num">{{ r.absent }}</td><td class="num">{{ r.onLeave }}</td>
                          <td class="num">{{ r.workedHours }}</td><td class="num">{{ r.overtimeHours }}</td>
                        </tr>
                      } @empty {
                        <tr><td colspan="8" class="muted">No employees in scope.</td></tr>
                      }
                    </tbody>
                  </table>
                </div>
              </ph-state>
            </section>
          </mat-tab>
        }
      </mat-tab-group>
    </div>
  `,
  styles: [
    `
      .muted { color: var(--ph-text-muted); }
      .small { font-size: 12px; }
      .between { justify-content: space-between; }
      .cal-toolbar { justify-content: space-between; margin-bottom: 8px; }
      .month-nav { display: flex; gap: 6px; align-items: center; }
      .totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 16px; }
      .totals div { background: var(--ph-surface-muted); border: 1px solid var(--ph-border); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; }
      .totals span { font-size: 12px; color: var(--ph-text-muted); }
      .totals strong { font-size: 18px; font-variant-numeric: tabular-nums; }
      .weekdays, .cal { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; }
      .weekdays span { font-size: 12px; color: var(--ph-text-muted); text-align: center; font-weight: 600; }
      .cell { min-height: 74px; border: 1px solid var(--ph-border); border-radius: 10px; padding: 6px; display: flex; flex-direction: column; gap: 4px; background: var(--ph-surface); transition: border-color var(--ph-dur-fast), transform var(--ph-dur-fast) var(--ph-ease); } .cell:not(.pad):hover { border-color: var(--ph-primary); transform: translateY(-1px); }
      .cell.pad { border: 0; background: transparent; }
      .cell.today { border-color: var(--ph-primary); box-shadow: inset 0 0 0 1px var(--ph-primary); }
      .cell.muted-day { background: var(--ph-surface-muted); }
      .dnum { font-size: 12px; font-weight: 600; color: var(--ph-text-muted); }
      .hrs { font-size: 11px; color: var(--ph-text-muted); font-variant-numeric: tabular-nums; }
      .legend { margin: 12px 0 0; }
      .correction { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 0 12px; align-items: start; margin-bottom: 16px; }
      .correction .reason { grid-column: span 2; }
      .correction button { margin-top: 8px; }
      .actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
      .month-pick { width: 200px; }
      .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
      @media (max-width: 640px) {
        .cell { min-height: 60px; padding: 4px; }
        .correction .reason { grid-column: auto; }
      }
    `,
  ],
})
export class AttendancePage implements OnInit {
  readonly auth = inject(Auth);
  private readonly api = inject(Api);
  private readonly notify = inject(Notify);
  private readonly fb = inject(FormBuilder);
  private readonly dialog = inject(MatDialog);
  private readonly title = inject(Title);

  readonly weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  readonly today = todayYmd();
  readonly formatDate = formatDate;
  readonly minutes = formatMinutes;
  readonly monthOptions = this.buildMonthOptions();

  readonly now = new Date();
  readonly year = signal(this.now.getFullYear());
  readonly month = signal(this.now.getMonth() + 1);
  readonly calendar = signal<Calendar | null>(null);
  readonly calState = signal<'loading' | 'ready' | 'error'>('loading');

  readonly myCorrections = signal<Correction[]>([]);
  readonly corrState = signal<'loading' | 'ready' | 'error'>('loading');
  readonly pending = signal<Correction[]>([]);
  readonly reviewState = signal<'loading' | 'ready' | 'error'>('loading');

  readonly summaryMonth = signal(`${this.now.getFullYear()}-${this.now.getMonth() + 1}`);
  readonly summary = signal<SummaryRow[]>([]);
  readonly summaryState = signal<'loading' | 'ready' | 'error'>('loading');

  readonly savingCorrection = signal(false);
  readonly monthTitle = computed(() => `${monthName(this.month())} ${this.year()}`);

  readonly correctionForm = this.fb.nonNullable.group({
    workDate: [this.today, [Validators.required]],
    checkIn: [''],
    checkOut: [''],
    reason: ['', [Validators.required, Validators.minLength(5)]],
  });

  ngOnInit() {
    this.title.setTitle('Attendance | PeopleHub');
    void this.reloadCalendar();
    void this.loadCorrections();
    if (this.canReview()) {
      void this.loadReview();
      void this.loadSummary();
    }
  }

  canReview(): boolean {
    const role = this.auth.user()?.role;
    return role === 'HR_ADMIN' || role === 'SUPER_ADMIN' || role === 'MANAGER';
  }

  async reloadCalendar() {
    const employeeId = this.auth.user()?.employeeId;
    if (!employeeId) {
      this.calState.set('ready');
      this.calendar.set(null);
      return;
    }
    this.calState.set('loading');
    try {
      this.calendar.set(
        await this.api.get<Calendar>('/attendance/calendar', { employeeId, year: this.year(), month: this.month() }),
      );
      this.calState.set('ready');
    } catch {
      this.calState.set('error');
    }
  }

  shiftMonth(delta: number) {
    const d = new Date(this.year(), this.month() - 1 + delta, 1);
    this.year.set(d.getFullYear());
    this.month.set(d.getMonth() + 1);
    void this.reloadCalendar();
  }

  resetMonth() {
    this.year.set(this.now.getFullYear());
    this.month.set(this.now.getMonth() + 1);
    void this.reloadCalendar();
  }

  leadPadding(): number[] {
    const c = this.calendar();
    if (!c || c.days.length === 0) return [];
    const [y, m, d] = c.days[0].date.split('-').map(Number);
    return Array.from({ length: new Date(y, m - 1, d).getDay() });
  }

  dayNumber(ymd: string) {
    return Number(ymd.slice(8, 10));
  }

  view(status: string) {
    return STATUS_VIEW[status] ?? { label: status, tone: 'neutral' as Tone };
  }

  cellLabel(d: CalendarDay) {
    const v = this.view(d.status);
    const worked = d.workedMinutes ? `, worked ${formatMinutes(d.workedMinutes)}` : '';
    return `${formatDate(d.date)}: ${v.label || 'not recorded yet'}${worked}`;
  }

  async submitCorrection() {
    this.correctionForm.markAllAsTouched();
    if (this.correctionForm.invalid) return;
    const v = this.correctionForm.getRawValue();
    if (!v.checkIn && !v.checkOut) {
      this.notify.error('Enter a corrected check-in or check-out time.');
      return;
    }
    this.savingCorrection.set(true);
    const body = {
      workDate: v.workDate,
      reason: v.reason,
      requestedCheckIn: v.checkIn ? new Date(v.checkIn).toISOString() : undefined,
      requestedCheckOut: v.checkOut ? new Date(v.checkOut).toISOString() : undefined,
    };
    const ok = await this.notify.run(() => this.api.post('/attendance/corrections', body), 'Correction request sent for approval.');
    this.savingCorrection.set(false);
    if (ok !== undefined) {
      this.correctionForm.patchValue({ checkIn: '', checkOut: '', reason: '' });
      await this.loadCorrections();
    }
  }

  async loadCorrections() {
    this.corrState.set('loading');
    try {
      this.myCorrections.set((await this.api.get<{ items: Correction[] }>('/attendance/corrections')).items);
      this.corrState.set('ready');
    } catch {
      this.corrState.set('error');
    }
  }

  async loadReview() {
    this.reviewState.set('loading');
    try {
      this.pending.set((await this.api.get<{ items: Correction[] }>('/attendance/corrections', { status: 'PENDING' })).items);
      this.reviewState.set('ready');
    } catch {
      this.reviewState.set('error');
    }
  }

  async review(c: Correction, decision: 'APPROVE' | 'REJECT') {
    let comment: string | undefined;
    if (decision === 'REJECT') {
      const result = await firstValueFrom(
        this.dialog.open<CorrectionReviewDialog, { name: string }, ReviewResult>(CorrectionReviewDialog, {
          data: { name: c.employee.name },
          width: 'min(460px, 94vw)',
        }).afterClosed(),
      );
      if (!result) return;
      comment = result.comment;
    } else {
      const ok = await confirmAction(this.dialog, {
        title: `Approve correction for ${c.employee.name}?`,
        message: 'The attendance record for that day will be updated and the change is written to the audit log.',
        confirmLabel: 'Approve',
      });
      if (!ok) return;
    }
    const done = await this.notify.run(
      () => this.api.post(`/attendance/corrections/${c.id}/review`, { decision, comment }),
      decision === 'APPROVE' ? 'Correction approved.' : 'Correction rejected.',
    );
    if (done !== undefined) await this.loadReview();
  }

  setSummaryMonth(value: string) {
    this.summaryMonth.set(value);
    void this.loadSummary();
  }

  async loadSummary() {
    this.summaryState.set('loading');
    const [y, m] = this.summaryMonth().split('-').map(Number);
    try {
      const res = await this.api.get<{ rows: SummaryRow[] }>('/attendance/summary', { year: y, month: m });
      this.summary.set(res.rows);
      this.summaryState.set('ready');
    } catch {
      this.summaryState.set('error');
    }
  }

  corrLabel(s: Correction['status']) {
    return ({ PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected' } as const)[s];
  }

  corrTone(s: Correction['status']): Tone {
    return ({ PENDING: 'warn', APPROVED: 'ok', REJECTED: 'bad' } as const)[s];
  }

  hm(iso: string | null) {
    if (!iso) return '—';
    return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  }

  private buildMonthOptions() {
    const out: { value: string; label: string }[] = [];
    const base = new Date();
    for (let i = 0; i < 12; i++) {
      const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
      out.push({ value: `${d.getFullYear()}-${d.getMonth() + 1}`, label: `${monthName(d.getMonth() + 1)} ${d.getFullYear()}` });
    }
    return out;
  }
}
