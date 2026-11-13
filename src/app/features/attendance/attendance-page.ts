import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { MatTabsModule } from '@angular/material/tabs';
import { Title } from '@angular/platform-browser';
import { Auth } from '../../core/auth';
import { TodayAttendanceCard } from './today-card';
import { AttendanceCalendar } from './attendance-calendar';
import { MyCorrections } from './my-corrections';
import { OvertimeList } from './overtime-list';
import { CorrectionReview } from './correction-review';
import { MonthlySummary } from './monthly-summary';

/**
 * Attendance: today's punch card, the employee's own calendar, corrections and overtime, and (for managers and HR)
 * a review tab with corrections, overtime approvals and the monthly summary for their scope.
 */
@Component({
  selector: 'ph-attendance-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatTabsModule, TodayAttendanceCard, AttendanceCalendar, MyCorrections, OvertimeList, CorrectionReview, MonthlySummary],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Attendance</h1>
          <p>Check-in and check-out times are recorded when you punch. Corrections and overtime go to your manager or HR for approval.</p>
        </div>
      </header>

      @if (hasProfile()) {
        <ph-today-attendance (changed)="refresh.set(refresh() + 1)" />
      }

      <mat-tab-group animationDuration="0ms" aria-label="Attendance views" [selectedIndex]="hasProfile() ? 0 : 1">
        <mat-tab label="My attendance" [disabled]="!hasProfile()">
          <div class="stack">
            <ph-attendance-calendar [refresh]="refresh()" />
            <ph-my-corrections />
            <ph-overtime-list mode="mine" />
          </div>
        </mat-tab>

        @if (canReview()) {
          <mat-tab [label]="isHr() ? 'Company review' : 'Team review'">
            <!-- Lazy: the review queues load only when the tab is opened. -->
            <ng-template matTabContent>
              <div class="stack">
                <ph-overtime-list mode="review" />
                <ph-correction-review />
                <ph-monthly-summary />
              </div>
            </ng-template>
          </mat-tab>
        }
      </mat-tab-group>
    </div>
  `,
  styles: [`.stack { display: flex; flex-direction: column; gap: 16px; padding-top: 16px; }`],
})
export class AttendancePage implements OnInit {
  private readonly auth = inject(Auth);
  private readonly title = inject(Title);

  readonly refresh = signal(0);
  readonly hasProfile = computed(() => Boolean(this.auth.user()?.employeeId));
  readonly isHr = computed(() => this.auth.isHr());
  readonly canReview = computed(() => {
    const role = this.auth.user()?.role;
    return role === 'HR_ADMIN' || role === 'SUPER_ADMIN' || role === 'MANAGER';
  });

  ngOnInit() {
    this.title.setTitle('Attendance | PeopleHub');
  }
}
