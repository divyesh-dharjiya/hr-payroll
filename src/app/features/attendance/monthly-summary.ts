import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { Api } from '../../core/api';
import { StateView } from '../../shared/ui';
import { currentYearMonth, monthName } from '../../shared/format';
import type { LoadState, SummaryRow } from './attendance.models';

/** Per-employee totals for a month, for everyone in the reviewer's scope. */
@Component({
  selector: 'ph-monthly-summary',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MatFormFieldModule, MatSelectModule, StateView],
  template: `
    <section class="card" aria-labelledby="summary-title">
      <div class="head">
        <h2 id="summary-title" class="card-title">Monthly summary</h2>
        <mat-form-field appearance="outline" class="month-pick" subscriptSizing="dynamic">
          <mat-label>Month</mat-label>
          <mat-select [ngModel]="month()" (ngModelChange)="setMonth($event)">
            @for (m of monthOptions; track m.value) { <mat-option [value]="m.value">{{ m.label }}</mat-option> }
          </mat-select>
        </mat-form-field>
      </div>
      <ph-state [state]="state()" (retry)="load()" title="Summary could not be loaded">
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
              @for (r of rows(); track r.employee.id) {
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
  `,
  styles: [
    `
      .muted { color: var(--ph-text-muted); }
      .small { font-size: 12px; }
      .num { text-align: right; }
      .head { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; margin-bottom: 12px; }
      .month-pick { width: 200px; }
    `,
  ],
})
export class MonthlySummary implements OnInit {
  private readonly api = inject(Api);
  readonly monthOptions = lastTwelveMonths();
  readonly month = signal(this.monthOptions[0].value);
  readonly rows = signal<SummaryRow[]>([]);
  readonly state = signal<LoadState>('loading');

  ngOnInit() {
    void this.load();
  }

  setMonth(value: string) {
    this.month.set(value);
    void this.load();
  }

  async load() {
    this.state.set('loading');
    const [year, month] = this.month().split('-').map(Number);
    try {
      this.rows.set((await this.api.get<{ rows: SummaryRow[] }>('/attendance/summary', { year, month })).rows);
      this.state.set('ready');
    } catch {
      this.state.set('error');
    }
  }
}

function lastTwelveMonths() {
  const { year, month } = currentYearMonth();
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(year, month - 1 - i, 1);
    return { value: `${d.getFullYear()}-${d.getMonth() + 1}`, label: `${monthName(d.getMonth() + 1)} ${d.getFullYear()}` };
  });
}
