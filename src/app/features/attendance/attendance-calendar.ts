import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Api } from '../../core/api';
import { Auth } from '../../core/auth';
import { StateView, StatusBadge } from '../../shared/ui';
import { currentYearMonth, formatDate, formatMinutes, monthName, todayYmd } from '../../shared/format';
import { type Calendar, type CalendarDay, type LoadState, dayStatusView } from './attendance.models';

/** The signed-in employee's month: one cell per day with its status and worked hours, plus month totals. */
@Component({
  selector: 'ph-attendance-calendar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, StateView, StatusBadge],
  template: `
    <section class="card" aria-labelledby="cal-title">
      <div class="cal-toolbar">
        <h2 id="cal-title" class="card-title">{{ monthTitle() }}</h2>
        <div class="month-nav">
          <button mat-icon-button type="button" (click)="shiftMonth(-1)" aria-label="Previous month"><mat-icon>chevron_left</mat-icon></button>
          <button mat-stroked-button type="button" (click)="resetMonth()" [disabled]="isCurrentMonth()">This month</button>
          <button mat-icon-button type="button" (click)="shiftMonth(1)" aria-label="Next month"><mat-icon>chevron_right</mat-icon></button>
        </div>
      </div>
      <ph-state [state]="state()" (retry)="load()" title="Calendar could not be loaded">
        @if (calendar(); as c) {
          <div class="totals" aria-label="Month totals">
            <div><span>Worked</span><strong>{{ minutes(c.totals.workedMinutes) }}</strong></div>
            <div><span>Late arrivals (minutes)</span><strong>{{ c.totals.lateMinutes }}</strong></div>
            <div><span>Overtime approved</span><strong>{{ minutes(c.totals.overtimeApprovedMinutes) }}</strong><small>of {{ minutes(c.totals.overtimeMinutes) }} worked</small></div>
            <div><span>Present days</span><strong>{{ presentDays(c) }}</strong></div>
            <div><span>Absent days</span><strong>{{ c.counts['ABSENT'] || 0 }}</strong></div>
            <div><span>Leave days</span><strong>{{ c.counts['ON_LEAVE'] || 0 }}</strong></div>
          </div>
          <div class="weekdays" aria-hidden="true">
            @for (w of weekdays; track w) { <span>{{ w }}</span> }
          </div>
          <div class="cal" role="list" [attr.aria-label]="monthTitle()">
            @for (pad of leadPadding(); track $index) { <span class="cell pad" aria-hidden="true"></span> }
            @for (d of c.days; track d.date) {
              <div class="cell" role="listitem" [class.today]="d.date === today" [class.muted-day]="isQuiet(d)" [attr.aria-label]="cellLabel(d)">
                <span class="dnum" aria-hidden="true">{{ dayNumber(d.date) }}</span>
                @if (view(d.status).label) {
                  <ph-status-badge [label]="view(d.status).label" [tone]="view(d.status).tone" />
                }
                @if ((d.workedMinutes ?? 0) > 0) {
                  <span class="hrs" aria-hidden="true">{{ minutes(d.workedMinutes ?? 0) }}</span>
                }
                @if (d.overtimeStatus && d.overtimeStatus !== 'NONE') {
                  <span [class]="'ot ' + d.overtimeStatus.toLowerCase()" aria-hidden="true">OT {{ minutes(d.overtimeMinutes ?? 0) }}</span>
                }
              </div>
            }
          </div>
          <p class="legend muted small">Absent is inferred for past working days with no check-in and no approved leave. Today stays open until the day closes. "OT" marks overtime claims (green: approved, amber: waiting, red: not approved).</p>
        } @else {
          <p class="muted">Your account has no employee profile, so there is no personal attendance calendar.</p>
        }
      </ph-state>
    </section>
  `,
  styles: [
    `
      .muted { color: var(--ph-text-muted); }
      .small { font-size: 12px; }
      .cal-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 8px; }
      .month-nav { display: flex; gap: 6px; align-items: center; }
      .totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 16px; }
      .totals div { background: var(--ph-surface-muted); border: 1px solid var(--ph-border); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; }
      .totals span, .totals small { font-size: 12px; color: var(--ph-text-muted); }
      .totals strong { font-size: 18px; font-variant-numeric: tabular-nums; }
      .weekdays, .cal { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; }
      .weekdays span { font-size: 12px; color: var(--ph-text-muted); text-align: center; font-weight: 600; }
      .cell { min-height: 74px; border: 1px solid var(--ph-border); border-radius: 10px; padding: 6px; display: flex; flex-direction: column; gap: 4px; background: var(--ph-surface); min-width: 0; transition: border-color var(--ph-dur-fast), transform var(--ph-dur-fast) var(--ph-ease); }
      .cell:not(.pad):hover { border-color: var(--ph-primary); transform: translateY(-1px); }
      .cell.pad { border: 0; background: transparent; }
      .cell.today { border-color: var(--ph-primary); box-shadow: inset 0 0 0 1px var(--ph-primary); }
      .cell.muted-day { background: var(--ph-surface-muted); }
      .dnum { font-size: 12px; font-weight: 600; color: var(--ph-text-muted); }
      .hrs { font-size: 11px; color: var(--ph-text-muted); font-variant-numeric: tabular-nums; }
      .ot { font-size: 10.5px; font-weight: 650; border-radius: 6px; padding: 1px 5px; width: fit-content; }
      .ot.approved { color: var(--ph-success); background: var(--ph-success-soft); }
      .ot.pending { color: var(--ph-warning); background: var(--ph-warning-soft); }
      .ot.rejected { color: var(--ph-danger); background: var(--ph-danger-soft); }
      .legend { margin: 12px 0 0; }
      @media (max-width: 640px) {
        .weekdays, .cal { gap: 3px; }
        .cell { min-height: 54px; padding: 3px; }
        .cell ph-status-badge, .hrs, .ot { display: none; }
        .cell.today .dnum { color: var(--ph-primary); }
        .cell[aria-label*='Absent'] { background: var(--ph-danger-soft); }
        .cell[aria-label*='Late'], .cell[aria-label*='Half day'] { background: var(--ph-warning-soft); }
        .cell[aria-label*='Present'], .cell[aria-label*='WFH'] { background: var(--ph-success-soft); }
        .cell[aria-label*='Leave'] { background: var(--ph-info-soft); }
      }
    `,
  ],
})
export class AttendanceCalendar {
  private readonly api = inject(Api);
  private readonly auth = inject(Auth);

  /** Bump to reload, for example after punching in or out. */
  readonly refresh = input(0);

  readonly weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  readonly today = todayYmd();
  readonly minutes = formatMinutes;
  readonly view = dayStatusView;
  private readonly current = currentYearMonth();
  readonly year = signal(this.current.year);
  readonly month = signal(this.current.month);
  readonly calendar = signal<Calendar | null>(null);
  readonly state = signal<LoadState>('loading');
  readonly monthTitle = computed(() => `${monthName(this.month())} ${this.year()}`);
  readonly isCurrentMonth = computed(() => this.year() === this.current.year && this.month() === this.current.month);

  constructor() {
    effect(() => {
      this.refresh();
      untracked(() => void this.load());
    });
  }

  async load() {
    const employeeId = this.auth.user()?.employeeId;
    if (!employeeId) {
      this.calendar.set(null);
      this.state.set('ready');
      return;
    }
    // Keep the current month on screen while a refresh loads; show the skeleton only on first load.
    if (!this.calendar()) this.state.set('loading');
    try {
      this.calendar.set(await this.api.get<Calendar>('/attendance/calendar', { employeeId, year: this.year(), month: this.month() }));
      this.state.set('ready');
    } catch {
      this.state.set('error');
    }
  }

  shiftMonth(delta: number) {
    const d = new Date(this.year(), this.month() - 1 + delta, 1);
    this.year.set(d.getFullYear());
    this.month.set(d.getMonth() + 1);
    this.calendar.set(null);
    void this.load();
  }

  resetMonth() {
    this.year.set(this.current.year);
    this.month.set(this.current.month);
    this.calendar.set(null);
    void this.load();
  }

  presentDays(c: Calendar) {
    return (c.counts['PRESENT'] || 0) + (c.counts['LATE'] || 0) + (c.counts['WFH'] || 0) + (c.counts['HALF_DAY'] || 0);
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

  isQuiet(d: CalendarDay) {
    return d.status === 'WEEKLY_OFF' || d.status === 'HOLIDAY' || d.status === 'FUTURE' || d.status === 'NOT_EMPLOYED';
  }

  cellLabel(d: CalendarDay) {
    const v = this.view(d.status);
    const worked = d.workedMinutes ? `, worked ${formatMinutes(d.workedMinutes)}` : '';
    const ot = d.overtimeStatus && d.overtimeStatus !== 'NONE' ? `, overtime ${formatMinutes(d.overtimeMinutes ?? 0)} ${d.overtimeStatus.toLowerCase()}` : '';
    return `${formatDate(d.date)}: ${v.label || 'not recorded yet'}${worked}${ot}`;
  }
}
