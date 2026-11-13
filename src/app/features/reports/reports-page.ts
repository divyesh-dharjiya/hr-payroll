import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import { Api, ApiError } from '../../core/api';
import { Notify } from '../../core/notify';
import { StatCard, StateView, StatusBadge } from '../../shared/ui';
import { BarChart, DonutChart, type BarDatum } from '../../shared/charts';
import { Avatar } from '../../shared/avatar';
import { formatDate, formatPaise, todayYmd } from '../../shared/format';
import { saveFile } from '../../shared/download';

interface Person { id: string; employeeCode: string; name: string; department: string; date?: string | null }
interface EmpAttendance extends Person {
  workingDays: number; present: number; late: number; halfDay: number; absent: number; onLeave: number;
  lateMinutes: number; overtimeHours: number; avgHoursPerDay: number;
}
interface Line { code: string; label: string; amountPaise: number }
interface Report {
  period: { from: string; to: string; departmentId: string | null };
  headcount: {
    activeAtEnd: number;
    byDepartment: { label: string; count: number }[];
    byEmploymentType: { label: string; count: number }[];
    byLocation: { label: string; count: number }[];
    joiners: Person[];
    exits: Person[];
  };
  attendance: {
    workingDays: number; presentDays: number; absentDays: number; leaveDays: number; lateArrivals: number; lateMinutes: number;
    overtimeHours: number; absenteeismRate: number; attendanceRate: number;
    daily: { date: string; present: number; late: number; absent: number; onLeave: number }[];
    byDepartment: { department: string; workingDays: number; absentDays: number; absenteeismRate: number }[];
    topLate: EmpAttendance[]; topOvertime: EmpAttendance[]; employees: EmpAttendance[];
  };
  leave: { byType: { code: string; name: string; isPaid: boolean; approvedDays: number; approvedRequests: number; pendingRequests: number; rejectedRequests: number }[]; totalApprovedDays: number };
  payroll: {
    monthly: { period: string; employees: number; grossPaise: number; deductionsPaise: number; netPaise: number; employerPaise: number; costPaise: number }[];
    totals: { grossPaise: number; deductionsPaise: number; netPaise: number; employerPaise: number };
    earnings: Line[]; deductions: Line[]; employerContributions: Line[];
    reconciliation: { period: string; formulaCheck: boolean; runTotalsMatch: boolean | null; paidPaise: number; unpaidPaise: number; paidCount: number; unpaidCount: number }[];
  };
}

type Preset = 'this-month' | 'last-month' | 'last-3' | 'last-6' | 'custom';

const TYPE_LABEL: Record<string, string> = { FULL_TIME: 'Full time', PART_TIME: 'Part time', CONTRACT: 'Contract', INTERN: 'Intern' };

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

@Component({
  selector: 'ph-reports-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule, RouterLink, MatButtonModule, MatButtonToggleModule, MatFormFieldModule, MatIconModule, MatInputModule, MatSelectModule, MatTabsModule,
    StatCard, StateView, StatusBadge, BarChart, DonutChart, Avatar,
  ],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <span class="eyebrow">Insights</span>
          <h1>Reports and analytics</h1>
          <p>Every figure is calculated from attendance, leave and finalized payroll records for the selected period.</p>
        </div>
        <div class="toolbar no-print">
          <button mat-stroked-button type="button" (click)="print()"><mat-icon>print</mat-icon> Print</button>
        </div>
      </header>

      <section class="card filters no-print" aria-label="Report filters">
        <mat-button-toggle-group [value]="preset()" (change)="setPreset($event.value)" aria-label="Period" class="presets">
          <mat-button-toggle value="this-month">This month</mat-button-toggle>
          <mat-button-toggle value="last-month">Last month</mat-button-toggle>
          <mat-button-toggle value="last-3">Last 3 months</mat-button-toggle>
          <mat-button-toggle value="last-6">Last 6 months</mat-button-toggle>
          <mat-button-toggle value="custom">Custom</mat-button-toggle>
        </mat-button-toggle-group>
        <div class="filter-row">
          <mat-form-field appearance="outline">
            <mat-label>From</mat-label>
            <input matInput type="date" [ngModel]="from()" (ngModelChange)="from.set($event); preset.set('custom')" [max]="to()" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>To</mat-label>
            <input matInput type="date" [ngModel]="to()" (ngModelChange)="to.set($event); preset.set('custom')" [min]="from()" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Department</mat-label>
            <mat-select [ngModel]="departmentId()" (ngModelChange)="departmentId.set($event); load()">
              <mat-option value="">All departments</mat-option>
              @for (d of departments(); track d.id) { <mat-option [value]="d.id">{{ d.name }}</mat-option> }
            </mat-select>
          </mat-form-field>
          <button mat-flat-button color="primary" type="button" (click)="load()" [disabled]="state() === 'loading'"><mat-icon>refresh</mat-icon> Update</button>
        </div>
      </section>

      <ph-state [state]="state()" (retry)="load()" [title]="errorTitle()" [message]="errorMessage()" loadingLabel="Building reports">
        @if (report(); as r) {
          <p class="period muted">Showing {{ formatDate(r.period.from) }} to {{ formatDate(r.period.to) }}{{ deptName() ? ' · ' + deptName() : '' }}</p>

          <section class="grid grid-kpi stagger" aria-label="Key figures">
            <ph-stat-card icon="groups" label="Headcount at period end" [value]="r.headcount.activeAtEnd" [hint]="r.headcount.joiners.length + ' joined · ' + r.headcount.exits.length + ' left'" />
            <ph-stat-card icon="how_to_reg" tone="ok" label="Attendance rate" [value]="r.attendance.attendanceRate + '%'" [hint]="r.attendance.presentDays + ' present of ' + r.attendance.workingDays + ' working days'" />
            <ph-stat-card icon="person_off" tone="bad" label="Absenteeism" [value]="r.attendance.absenteeismRate + '%'" [hint]="r.attendance.absentDays + ' absent day(s)'" />
            <ph-stat-card icon="alarm" tone="warn" label="Late arrivals" [value]="r.attendance.lateArrivals" [hint]="r.attendance.lateMinutes + ' minutes in total'" />
            <ph-stat-card icon="more_time" tone="info" label="Overtime recorded" [value]="r.attendance.overtimeHours + ' h'" hint="Not paid until approved" />
            <ph-stat-card icon="payments" label="Payroll cost" [value]="r.payroll.totals.grossPaise + r.payroll.totals.employerPaise" [format]="inr" [hint]="r.payroll.monthly.length + ' finalized month(s)'" />
          </section>

          <mat-tab-group animationDuration="200ms" class="tabs" aria-label="Report sections">
            <mat-tab label="Overview">
              <div class="grid grid-2 tab-body">
                <section class="card">
                  <div class="card-head"><h2 class="card-title">Daily attendance</h2><span class="legend"><i class="sw p"></i> Present <i class="sw l"></i> Late</span></div>
                  <ph-bar-chart ariaLabel="Employees present per day, late arrivals stacked" [values]="dailyBars()" [valueFormat]="int" />
                </section>
                <section class="card">
                  <h2 class="card-title">Headcount by department</h2>
                  <ph-donut-chart ariaLabel="Headcount by department at period end" centerLabel="People" [slices]="deptSlices()" />
                </section>
                <section class="card">
                  <h2 class="card-title">Payroll cost by month</h2>
                  @if (r.payroll.monthly.length === 0) { <p class="muted">No finalized payroll in this period.</p> }
                  @else { <ph-bar-chart ariaLabel="Gross pay and employer contributions per finalized month" [values]="payrollBars()" [valueFormat]="inrFromRupees" /> }
                </section>
                <section class="card">
                  <h2 class="card-title">Employment type and location</h2>
                  <div class="mini-lists">
                    <ul>@for (t of r.headcount.byEmploymentType; track t.label) { <li><span>{{ typeLabel(t.label) }}</span><strong>{{ t.count }}</strong></li> }</ul>
                    <ul>@for (t of r.headcount.byLocation; track t.label) { <li><span>{{ t.label }}</span><strong>{{ t.count }}</strong></li> }</ul>
                  </div>
                </section>
              </div>
            </mat-tab>

            <mat-tab label="Attendance">
              <div class="tab-body">
                <div class="tab-actions no-print"><button mat-stroked-button type="button" (click)="exportCsv('attendance')"><mat-icon>download</mat-icon> Export attendance CSV</button></div>
                <div class="grid grid-3">
                  <section class="card">
                    <h2 class="card-title">Absenteeism by department</h2>
                    <ul class="meter-list">
                      @for (d of r.attendance.byDepartment; track d.department) {
                        <li>
                          <span>{{ d.department }}</span>
                          <span class="meter" aria-hidden="true"><span [style.width.%]="Math.min(100, d.absenteeismRate * 5)"></span></span>
                          <strong>{{ d.absenteeismRate }}%</strong>
                        </li>
                      }
                    </ul>
                  </section>
                  <section class="card">
                    <h2 class="card-title">Most late arrivals</h2>
                    <ul class="people">
                      @for (p of r.attendance.topLate; track p.id) {
                        <li><ph-avatar [name]="p.name" [size]="30" /><span><a [routerLink]="['/employees', p.id]">{{ p.name }}</a><small>{{ p.department }}</small></span><strong>{{ p.late }}×</strong></li>
                      } @empty { <li class="muted">No late arrivals.</li> }
                    </ul>
                  </section>
                  <section class="card">
                    <h2 class="card-title">Most overtime</h2>
                    <ul class="people">
                      @for (p of r.attendance.topOvertime; track p.id) {
                        <li><ph-avatar [name]="p.name" [size]="30" /><span><a [routerLink]="['/employees', p.id]">{{ p.name }}</a><small>{{ p.department }}</small></span><strong>{{ p.overtimeHours }} h</strong></li>
                      } @empty { <li class="muted">No overtime recorded.</li> }
                    </ul>
                  </section>
                </div>
                <div class="table-wrap">
                  <table class="data">
                    <caption class="sr-only">Attendance per employee for the period</caption>
                    <thead><tr><th scope="col">Employee</th><th scope="col" class="num">Working</th><th scope="col" class="num">Present</th><th scope="col" class="num">Late</th><th scope="col" class="num">Absent</th><th scope="col" class="num">Leave</th><th scope="col" class="num">Avg h/day</th><th scope="col" class="num">Overtime h</th></tr></thead>
                    <tbody>
                      @for (e of r.attendance.employees; track e.id) {
                        <tr>
                          <td><span class="who"><ph-avatar [name]="e.name" [size]="28" /><span>{{ e.name }}<small>{{ e.employeeCode }} · {{ e.department }}</small></span></span></td>
                          <td class="num">{{ e.workingDays }}</td><td class="num">{{ e.present }}</td><td class="num">{{ e.late }}</td>
                          <td class="num">{{ e.absent }}</td><td class="num">{{ e.onLeave }}</td><td class="num">{{ e.avgHoursPerDay }}</td><td class="num">{{ e.overtimeHours }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </div>
            </mat-tab>

            <mat-tab label="Leave">
              <div class="tab-body">
                <div class="tab-actions no-print"><button mat-stroked-button type="button" (click)="exportCsv('leave')"><mat-icon>download</mat-icon> Export leave CSV</button></div>
                <div class="grid grid-2">
                  <section class="card">
                    <h2 class="card-title">Approved leave days by type</h2>
                    <ph-donut-chart ariaLabel="Approved leave days by leave type" centerLabel="Days" [slices]="leaveSlices()" />
                  </section>
                  <div class="table-wrap">
                    <table class="data">
                      <caption class="sr-only">Leave utilisation by type</caption>
                      <thead><tr><th scope="col">Type</th><th scope="col" class="num">Approved days</th><th scope="col" class="num">Approved</th><th scope="col" class="num">Pending</th><th scope="col" class="num">Rejected</th></tr></thead>
                      <tbody>
                        @for (t of r.leave.byType; track t.code) {
                          <tr><td>{{ t.name }} <small class="muted">{{ t.isPaid ? 'Paid' : 'Unpaid' }}</small></td><td class="num">{{ t.approvedDays }}</td><td class="num">{{ t.approvedRequests }}</td><td class="num">{{ t.pendingRequests }}</td><td class="num">{{ t.rejectedRequests }}</td></tr>
                        } @empty { <tr><td colspan="5" class="muted">No leave in this period.</td></tr> }
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </mat-tab>

            <mat-tab label="Payroll">
              <div class="tab-body">
                <div class="tab-actions no-print"><button mat-stroked-button type="button" (click)="exportCsv('payroll')"><mat-icon>download</mat-icon> Export payroll CSV</button></div>
                <div class="table-wrap">
                  <table class="data">
                    <caption class="sr-only">Finalized payroll by month with reconciliation</caption>
                    <thead><tr><th scope="col">Month</th><th scope="col" class="num">Employees</th><th scope="col" class="num">Gross</th><th scope="col" class="num">Deductions</th><th scope="col" class="num">Net</th><th scope="col" class="num">Employer</th><th scope="col">Reconciliation</th><th scope="col">Payments</th></tr></thead>
                    <tbody>
                      @for (m of r.payroll.monthly; track m.period; let i = $index) {
                        <tr>
                          <td>{{ m.period }}</td><td class="num">{{ m.employees }}</td><td class="num">{{ paise(m.grossPaise) }}</td><td class="num">{{ paise(m.deductionsPaise) }}</td>
                          <td class="num"><strong>{{ paise(m.netPaise) }}</strong></td><td class="num">{{ paise(m.employerPaise) }}</td>
                          <td>
                            <ph-status-badge [label]="r.payroll.reconciliation[i].formulaCheck && r.payroll.reconciliation[i].runTotalsMatch !== false ? 'Balanced' : 'Mismatch'" [tone]="r.payroll.reconciliation[i].formulaCheck && r.payroll.reconciliation[i].runTotalsMatch !== false ? 'ok' : 'bad'" />
                          </td>
                          <td><small>{{ r.payroll.reconciliation[i].paidCount }} paid · {{ r.payroll.reconciliation[i].unpaidCount }} pending</small></td>
                        </tr>
                      } @empty { <tr><td colspan="8" class="muted">No finalized payroll in this period.</td></tr> }
                    </tbody>
                  </table>
                </div>
                <div class="grid grid-3" style="margin-top:16px">
                  <section class="card"><h2 class="card-title">Earnings</h2><ul class="amounts">@for (l of r.payroll.earnings; track l.code + l.label) { <li><span>{{ l.label }}</span><strong>{{ paise(l.amountPaise) }}</strong></li> } @empty { <li class="muted">None</li> }</ul></section>
                  <section class="card"><h2 class="card-title">Employee deductions</h2><ul class="amounts">@for (l of r.payroll.deductions; track l.code + l.label) { <li><span>{{ l.label }}</span><strong>{{ paise(l.amountPaise) }}</strong></li> } @empty { <li class="muted">None</li> }</ul></section>
                  <section class="card"><h2 class="card-title">Employer contributions</h2><ul class="amounts">@for (l of r.payroll.employerContributions; track l.code + l.label) { <li><span>{{ l.label }}</span><strong>{{ paise(l.amountPaise) }}</strong></li> } @empty { <li class="muted">None</li> }</ul></section>
                </div>
              </div>
            </mat-tab>

            <mat-tab label="Joiners and exits">
              <div class="tab-body">
                <div class="tab-actions no-print"><button mat-stroked-button type="button" (click)="exportCsv('headcount')"><mat-icon>download</mat-icon> Export headcount CSV</button></div>
                <div class="grid grid-2">
                  <section class="card">
                    <h2 class="card-title">New joiners ({{ r.headcount.joiners.length }})</h2>
                    <ul class="people">
                      @for (p of r.headcount.joiners; track p.id) { <li><ph-avatar [name]="p.name" [size]="30" /><span><a [routerLink]="['/employees', p.id]">{{ p.name }}</a><small>{{ p.department }}</small></span><strong>{{ formatDate(p.date) }}</strong></li> }
                      @empty { <li class="muted">Nobody joined in this period.</li> }
                    </ul>
                  </section>
                  <section class="card">
                    <h2 class="card-title">Exits ({{ r.headcount.exits.length }})</h2>
                    <ul class="people">
                      @for (p of r.headcount.exits; track p.id) { <li><ph-avatar [name]="p.name" [size]="30" /><span><a [routerLink]="['/employees', p.id]">{{ p.name }}</a><small>{{ p.department }}</small></span><strong>{{ formatDate(p.date) }}</strong></li> }
                      @empty { <li class="muted">Nobody left in this period.</li> }
                    </ul>
                  </section>
                </div>
              </div>
            </mat-tab>
          </mat-tab-group>
        }
      </ph-state>
    </div>
  `,
  styles: [
    `
      .filters { display: flex; flex-direction: column; gap: 14px; }
      .presets { flex-wrap: wrap; border-radius: 12px; }
      .filter-row { display: grid; grid-template-columns: 1fr 1fr 1.3fr auto; gap: 12px; align-items: start; }
      .filter-row button { margin-top: 6px; height: 48px; }
      .period { margin: -6px 0 0; }
      .tabs { margin-top: 4px; }
      .tab-body { padding-top: 16px; display: flex; flex-direction: column; gap: 16px; }
      .tab-actions { display: flex; justify-content: flex-end; }
      .card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
      .legend { font-size: 12px; color: var(--ph-text-muted); display: inline-flex; align-items: center; gap: 6px; }
      .sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
      .sw.p { background: var(--ph-primary); }
      .sw.l { background: var(--ph-warning); margin-left: 8px; }
      .mini-lists { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
      .mini-lists ul, .amounts, .people, .meter-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
      .mini-lists li, .amounts li { display: flex; justify-content: space-between; gap: 12px; padding-bottom: 8px; border-bottom: 1px dashed var(--ph-border); }
      .amounts strong { font-variant-numeric: tabular-nums; }
      .people li { display: grid; grid-template-columns: 30px 1fr auto; gap: 10px; align-items: center; }
      .people span { display: flex; flex-direction: column; min-width: 0; }
      .people small, .who small { color: var(--ph-text-muted); font-size: 12px; display: block; }
      .people a { color: var(--ph-text); font-weight: 600; text-decoration: none; }
      .people a:hover { color: var(--ph-primary); }
      .meter-list li { display: grid; grid-template-columns: 120px 1fr 48px; gap: 10px; align-items: center; }
      .meter { height: 8px; border-radius: 999px; background: var(--ph-surface-muted); border: 1px solid var(--ph-border); overflow: hidden; }
      .meter span { display: block; height: 100%; background: linear-gradient(90deg, var(--ph-warning), var(--ph-danger)); transform-origin: left; animation: ph-grow-x 700ms var(--ph-ease) both; }
      .who { display: flex; gap: 10px; align-items: center; }
      @media (max-width: 860px) { .filter-row { grid-template-columns: 1fr 1fr; } .mini-lists { grid-template-columns: 1fr; } }
      @media (max-width: 520px) { .filter-row { grid-template-columns: 1fr; } }
    `,
  ],
})
export class ReportsPage implements OnInit {
  private readonly api = inject(Api);
  private readonly notify = inject(Notify);
  private readonly title = inject(Title);
  readonly Math = Math;
  readonly formatDate = formatDate;
  readonly paise = formatPaise;
  readonly inr = (n: number) => formatPaise(n).replace(/\.\d{2}$/, '');
  readonly int = (n: number) => String(Math.round(n));
  readonly inrFromRupees = (n: number) => `₹${(n / 100000).toFixed(2)}L`;

  readonly preset = signal<Preset>('last-3');
  readonly from = signal('');
  readonly to = signal('');
  readonly departmentId = signal('');
  readonly departments = signal<{ id: string; name: string }[]>([]);
  readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  readonly report = signal<Report | null>(null);
  readonly errorTitle = signal('Reports could not be built');
  readonly errorMessage = signal('Check the dates and try again.');

  readonly deptName = computed(() => this.departments().find((d) => d.id === this.departmentId())?.name ?? '');
  readonly dailyBars = computed<BarDatum[]>(() =>
    (this.report()?.attendance.daily ?? []).map((d) => ({ label: d.date.slice(8, 10), value: d.present - d.late, secondary: d.late })),
  );
  readonly payrollBars = computed<BarDatum[]>(() =>
    (this.report()?.payroll.monthly ?? []).map((m) => ({ label: m.period.slice(5), value: Math.round(m.grossPaise / 100), secondary: Math.round(m.employerPaise / 100) })),
  );
  readonly deptSlices = computed(() => (this.report()?.headcount.byDepartment ?? []).map((d) => ({ label: d.label, value: d.count })));
  readonly leaveSlices = computed(() => (this.report()?.leave.byType ?? []).map((t) => ({ label: t.name, value: t.approvedDays })));

  ngOnInit() {
    this.title.setTitle('Reports | PeopleHub');
    this.setPreset('last-3', false);
    void this.api
      .get<{ items: { id: string; name: string }[] }>('/org/departments')
      .then((r) => this.departments.set(r.items))
      .catch(() => this.departments.set([]));
    void this.load();
  }

  setPreset(p: Preset, reload = true) {
    this.preset.set(p);
    const today = new Date(`${todayYmd()}T00:00:00`);
    const y = today.getFullYear();
    const m = today.getMonth();
    if (p === 'this-month') {
      this.from.set(ymd(new Date(y, m, 1)));
      this.to.set(ymd(today));
    } else if (p === 'last-month') {
      this.from.set(ymd(new Date(y, m - 1, 1)));
      this.to.set(ymd(new Date(y, m, 0)));
    } else if (p === 'last-3') {
      this.from.set(ymd(new Date(y, m - 2, 1)));
      this.to.set(ymd(today));
    } else if (p === 'last-6') {
      // The API caps a report at 186 days, so "last 6 months" starts five full months back.
      this.from.set(ymd(new Date(y, m - 5, 1)));
      this.to.set(ymd(today));
    } else {
      return;
    }
    if (reload) void this.load();
  }

  private params() {
    return { from: this.from(), to: this.to(), departmentId: this.departmentId() || undefined };
  }

  async load() {
    this.state.set('loading');
    try {
      this.report.set(await this.api.get<Report>('/reports/overview', this.params()));
      this.state.set('ready');
    } catch (err) {
      this.errorTitle.set('Reports could not be built');
      this.errorMessage.set(err instanceof ApiError ? (err.fields[0]?.message ?? err.message) : 'Check your connection and try again.');
      this.state.set('error');
    }
  }

  async exportCsv(type: 'headcount' | 'attendance' | 'leave' | 'payroll') {
    const csv = await this.notify.run(() => this.api.downloadText('/reports/export.csv', { type, ...this.params() }), 'Report exported.');
    if (csv) saveFile(`${type}-report-${this.from()}-to-${this.to()}.csv`, csv);
  }

  typeLabel(t: string) {
    return TYPE_LABEL[t] ?? t;
  }

  print() {
    window.print();
  }
}
