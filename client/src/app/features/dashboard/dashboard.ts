import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Title } from '@angular/platform-browser';
import { Api } from '../../core/api';
import { Auth } from '../../core/auth';
import { StatCard, StateView, StatusBadge } from '../../shared/ui';
import { BarChart, DonutChart, type BarDatum } from '../../shared/charts';
import { Avatar } from '../../shared/avatar';
import { currentOrgHour, currentYearMonth, formatDate, formatInstant, formatPaise, monthName, todayYmd } from '../../shared/format';
import { TodayAttendanceCard } from '../attendance/today-card';

// Shapes returned by GET /api/dashboard. Each view is built on the server from database queries.
interface HrDashboard {
  view: 'hr';
  kpis: {
    totalEmployees: number;
    activeEmployees: number;
    presentToday: number;
    lateToday: number;
    onLeaveToday: number;
    absentToday: number;
    pendingLeaveRequests: number;
    pendingCorrections: number;
    employeesMissingBankDetails: number;
  };
  today: { date: string; isWorkingDay: boolean; holiday: string | null };
  payroll: { period: { year: number; month: number }; status: string | null; expensePaise: number };
  departmentDistribution: { id: string; name: string; count: number }[];
  attendanceTrend: { date: string; present: number; late: number }[];
  payrollTrend: { period: string; grossPaise: number; netPaise: number }[];
  birthdays: { id: string; name: string; date: string; designation: string; photoUrl: string | null }[];
  anniversaries: { id: string; name: string; date: string; years: number; designation: string; photoUrl: string | null }[];
  recentActivity: { id: string; action: string; actor: string | null; entityType: string; at: string }[];
  pendingTasks: { key: string; label: string; href: string }[];
  announcements: Announcement[];
}

interface ManagerDashboard {
  view: 'manager';
  kpis: { teamSize: number; presentToday: number; lateToday: number; onLeaveToday: number; notCheckedIn: number; pendingApprovals: number };
  team: { id: string; name: string; photoUrl: string | null; designation: string; department: string; status: string; employeeCode: string }[];
  pendingApprovals: { id: string; employee: string; leaveType: string; startDate: string; endDate: string; days: number }[];
  upcomingAbsences: { id: string; employee: string; leaveType: string; startDate: string; endDate: string }[];
  announcements: Announcement[];
}

interface EmployeeDashboard {
  view: 'employee';
  profile: { name: string; employeeCode: string; designation: string; department: string; manager: string | null; location: string; joiningDate: string } | null;
  message?: string;
  leaveBalances: { leaveTypeId: string; code: string; name: string; entitled: number; used: number; pending: number; available: number | null; unlimited: boolean }[];
  upcomingHolidays: { date: string; name: string }[];
  recentPayslips: { id: string; period: string; netPaise: number; paymentStatus: string }[];
  announcements: Announcement[];
}

interface Announcement {
  id: string;
  title: string;
  body: string;
  publishAt: string;
  expiresAt: string | null;
}

type DashboardData = HrDashboard | ManagerDashboard | EmployeeDashboard;

const TASK_ICONS: Record<string, string> = { leave: 'event_upcoming', corrections: 'edit_calendar', bank: 'account_balance', payroll: 'payments' };

@Component({
  selector: 'ph-dashboard',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, RouterLink, MatButtonModule, MatIconModule, StatCard, StateView, StatusBadge, BarChart, DonutChart, Avatar, TodayAttendanceCard],
  template: `
    <div class="page">
      <section class="hero animate-in" aria-labelledby="greeting">
        <div class="hero-text">
          <span class="date">{{ todayLabel }}</span>
          <h1 id="greeting">{{ greeting() }}</h1>
          <p>{{ subtitle() }}</p>
          <div class="quick">
            @for (q of quickActions(); track q.link) {
              <a class="quick-btn" [routerLink]="q.link"><mat-icon aria-hidden="true">{{ q.icon }}</mat-icon>{{ q.label }}</a>
            }
          </div>
        </div>
        <div class="hero-art" aria-hidden="true">
          <svg viewBox="0 0 220 160" width="220" height="160">
            <defs><linearGradient id="hg" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.9"/><stop offset="1" stop-color="#ffffff" stop-opacity="0.55"/></linearGradient></defs>
            <rect x="30" y="20" width="160" height="112" rx="16" fill="url(#hg)" />
            <rect x="46" y="36" width="60" height="8" rx="4" fill="#4f46e5" opacity="0.7" />
            <rect x="46" y="52" width="40" height="6" rx="3" fill="#94a3b8" opacity="0.6" />
            @for (b of heroBars; track $index) {
              <rect [attr.x]="50 + $index * 18" [attr.y]="118 - b" width="11" [attr.height]="b" rx="3" fill="#6366f1" class="hb" [style.animation-delay.ms]="300 + $index * 70" />
            }
            <circle cx="172" cy="40" r="14" fill="#22c55e" opacity="0.9" />
            <path d="M165 40l5 5 9-10" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
      </section>

      <ph-state [state]="state()" (retry)="load()" title="Dashboard could not be loaded" message="Refresh the page or try again in a moment.">
        @if (data(); as d) {
          @switch (d.view) {
            @case ('hr') {
              <section class="grid grid-kpi stagger" aria-label="Key figures">
                <ph-stat-card icon="groups" label="Active employees" [value]="hr().kpis.activeEmployees" [hint]="hr().kpis.totalEmployees + ' on record'" />
                <ph-stat-card icon="how_to_reg" tone="ok" label="Present today" [value]="hr().kpis.presentToday" [hint]="hr().kpis.lateToday + ' arrived late'" />
                <ph-stat-card icon="beach_access" tone="info" label="On leave today" [value]="hr().kpis.onLeaveToday" hint="Approved leave" />
                <ph-stat-card icon="schedule" tone="warn" label="Not checked in" [value]="hr().kpis.absentToday" [hint]="hr().today.holiday ?? (hr().today.isWorkingDay ? 'Working day' : 'Weekly off')" />
                <ph-stat-card icon="pending_actions" tone="bad" label="Leave awaiting decision" [value]="hr().kpis.pendingLeaveRequests" [hint]="hr().kpis.pendingCorrections + ' correction(s) pending'" />
                <ph-stat-card icon="payments" label="Latest payroll cost" [value]="hr().payroll.expensePaise" [format]="inr" [hint]="payrollHint()" />
              </section>

              <div class="grid grid-2 stagger">
                <section class="card">
                  <div class="card-head"><h2 class="card-title">Attendance, last 14 days</h2><span class="legend"><i class="sw p"></i>On time <i class="sw l"></i>Late</span></div>
                  <ph-bar-chart ariaLabel="Employees present per day over the last 14 days, late arrivals stacked" [values]="attendanceBars()" [valueFormat]="int" />
                </section>
                <section class="card">
                  <h2 class="card-title">Headcount by department</h2>
                  <ph-donut-chart ariaLabel="Active employees per department" centerLabel="People" [slices]="deptSlices()" />
                </section>
              </div>

              <div class="grid grid-2 stagger">
                <section class="card">
                  <h2 class="card-title">Payroll cost, finalized months</h2>
                  @if (hr().payrollTrend.length === 0) { <p class="muted">No finalized payroll yet.</p> }
                  @else { <ph-bar-chart ariaLabel="Gross payroll per finalized month" [values]="payrollBars()" [valueFormat]="inrShort" /> }
                </section>
                <section class="card">
                  <h2 class="card-title">Needs your attention</h2>
                  @if (hr().pendingTasks.length === 0) {
                    <div class="all-clear"><mat-icon aria-hidden="true">task_alt</mat-icon><span>You're all caught up.</span></div>
                  }
                  <ul class="tasks">
                    @for (t of hr().pendingTasks; track t.key) {
                      <li><a [routerLink]="t.href"><span class="t-icon" aria-hidden="true"><mat-icon>{{ taskIcon(t.key) }}</mat-icon></span><span>{{ t.label }}</span><mat-icon class="chev" aria-hidden="true">chevron_right</mat-icon></a></li>
                    }
                  </ul>
                  <h3 class="sub-title">Recent activity</h3>
                  <ol class="timeline">
                    @for (a of hr().recentActivity.slice(0, 6); track a.id) {
                      <li><span class="dot" aria-hidden="true"></span><span class="what">{{ humanize(a.action) }}</span><span class="when muted">{{ a.actor ?? 'System' }} · {{ instant(a.at) }}</span></li>
                    } @empty { <li class="muted">No activity yet.</li> }
                  </ol>
                </section>
              </div>

              <div class="grid grid-2 stagger">
                <section class="card">
                  <h2 class="card-title">Celebrations in the next 30 days</h2>
                  <ul class="people">
                    @for (b of hr().birthdays; track b.id + 'b') {
                      <li><ph-avatar [name]="b.name" [photoUrl]="b.photoUrl" [size]="38" /><span><a [routerLink]="['/employees', b.id]">{{ b.name }}</a><small>{{ b.designation }}</small></span><span class="pill cake"><mat-icon aria-hidden="true">cake</mat-icon>{{ formatDate(b.date) }}</span></li>
                    }
                    @for (a of hr().anniversaries; track a.id + 'a') {
                      <li><ph-avatar [name]="a.name" [photoUrl]="a.photoUrl" [size]="38" /><span><a [routerLink]="['/employees', a.id]">{{ a.name }}</a><small>{{ a.years }} year{{ a.years > 1 ? 's' : '' }} with us</small></span><span class="pill star"><mat-icon aria-hidden="true">workspace_premium</mat-icon>{{ formatDate(a.date) }}</span></li>
                    }
                    @if (hr().birthdays.length + hr().anniversaries.length === 0) {
                      <li class="muted">No birthdays or work anniversaries coming up.</li>
                    }
                  </ul>
                </section>
                <section class="card">
                  <h2 class="card-title">Announcements</h2>
                  <ng-container *ngTemplateOutlet="announcementList; context: { $implicit: hr().announcements }"></ng-container>
                </section>
              </div>
            }

            @case ('manager') {
              <section class="grid grid-kpi stagger" aria-label="Team figures">
                <ph-stat-card icon="groups" label="Team size" [value]="manager().kpis.teamSize" hint="Direct reports" />
                <ph-stat-card icon="how_to_reg" tone="ok" label="Present today" [value]="manager().kpis.presentToday" [hint]="manager().kpis.lateToday + ' late'" />
                <ph-stat-card icon="beach_access" tone="info" label="On leave today" [value]="manager().kpis.onLeaveToday" />
                <ph-stat-card icon="pending_actions" tone="warn" label="Leave to approve" [value]="manager().kpis.pendingApprovals" />
              </section>

              <div class="grid grid-2 stagger">
                <section class="card">
                  <div class="card-head"><h2 class="card-title">Pending leave approvals</h2><a mat-button routerLink="/leave">Review all</a></div>
                  <ul class="people">
                    @for (p of manager().pendingApprovals; track p.id) {
                      <li><ph-avatar [name]="p.employee" [size]="38" /><span><strong>{{ p.employee }}</strong><small>{{ p.leaveType }} · {{ p.days }} day(s) from {{ formatDate(p.startDate) }}</small></span><ph-status-badge label="Pending" tone="warn" /></li>
                    } @empty {
                      <li><div class="all-clear"><mat-icon aria-hidden="true">task_alt</mat-icon><span>Nothing waiting for you.</span></div></li>
                    }
                  </ul>
                </section>
                <section class="card">
                  <h2 class="card-title">Upcoming absences (14 days)</h2>
                  <ul class="people">
                    @for (u of manager().upcomingAbsences; track u.id) {
                      <li><ph-avatar [name]="u.employee" [size]="38" /><span><strong>{{ u.employee }}</strong><small>{{ u.leaveType }}</small></span><span class="pill">{{ formatDate(u.startDate) }}{{ u.endDate !== u.startDate ? ' – ' + formatDate(u.endDate) : '' }}</span></li>
                    } @empty { <li class="muted">No approved absences in the next two weeks.</li> }
                  </ul>
                </section>
              </div>

              <section class="card animate-in">
                <h2 class="card-title">My team</h2>
                <div class="team-grid">
                  @for (t of manager().team; track t.id) {
                    <a class="member card interactive" [routerLink]="['/employees', t.id]">
                      <ph-avatar [name]="t.name" [photoUrl]="t.photoUrl" [size]="52" [ring]="true" />
                      <strong>{{ t.name }}</strong>
                      <small>{{ t.designation }}</small>
                      <ph-status-badge [label]="t.status === 'ACTIVE' ? 'Active' : 'On notice'" [tone]="t.status === 'ACTIVE' ? 'ok' : 'warn'" />
                    </a>
                  } @empty { <p class="muted">No direct reports are assigned to you yet.</p> }
                </div>
              </section>

              <section class="card">
                <h2 class="card-title">Announcements</h2>
                <ng-container *ngTemplateOutlet="announcementList; context: { $implicit: manager().announcements }"></ng-container>
              </section>
            }

            @case ('employee') {
              @if (employee().profile; as p) {
                <div class="grid grid-2 stagger">
                  <section class="card profile" aria-labelledby="profile-title">
                    <h2 id="profile-title" class="sr-only">My profile</h2>
                    <div class="who">
                      <ph-avatar [name]="p.name" [photoUrl]="auth.user()?.photoUrl" [size]="72" [ring]="true" />
                      <div>
                        <div class="name">{{ p.name }}</div>
                        <div class="muted">{{ p.designation }} · {{ p.department }}</div>
                        <div class="chips"><span class="pill">{{ p.employeeCode }}</span><span class="pill">{{ p.location }}</span></div>
                      </div>
                    </div>
                    <dl class="facts">
                      <div><dt>Reports to</dt><dd>{{ p.manager ?? 'No one' }}</dd></div>
                      <div><dt>Joined</dt><dd>{{ formatDate(p.joiningDate) }}</dd></div>
                    </dl>
                    <a mat-stroked-button [routerLink]="['/employees', currentEmployeeId()]">View full profile</a>
                  </section>
                  <ph-today-attendance (changed)="load(true)" />
                </div>

                <section class="card animate-in">
                  <div class="card-head"><h2 class="card-title">Leave balances</h2><a mat-button routerLink="/leave">Request leave</a></div>
                  <div class="balances stagger">
                    @for (b of employee().leaveBalances; track b.leaveTypeId) {
                      <div class="balance">
                        <div class="b-top"><span class="muted">{{ b.name }}</span><span class="code">{{ b.code }}</span></div>
                        <div class="big">{{ b.unlimited ? 'Unpaid' : b.available }}<small>{{ b.unlimited ? '' : ' days left' }}</small></div>
                        @if (!b.unlimited) {
                          <div class="track" aria-hidden="true"><span [style.width.%]="usedPct(b)"></span></div>
                          <div class="muted small">{{ b.used }} used · {{ b.pending }} pending · {{ b.entitled }} entitled</div>
                        } @else {
                          <div class="muted small">{{ b.used }} day(s) taken this year</div>
                        }
                      </div>
                    }
                  </div>
                </section>

                <div class="grid grid-2 stagger">
                  <section class="card">
                    <h2 class="card-title">Upcoming holidays</h2>
                    <ul class="hol">
                      @for (h of employee().upcomingHolidays; track h.date) {
                        <li><span class="cal" aria-hidden="true"><b>{{ h.date.slice(8, 10) }}</b><i>{{ shortMonth(h.date) }}</i></span><span>{{ h.name }}</span></li>
                      } @empty { <li class="muted">No holidays in the next two months.</li> }
                    </ul>
                  </section>
                  <section class="card">
                    <div class="card-head"><h2 class="card-title">Recent payslips</h2><a mat-button routerLink="/payslips">All payslips</a></div>
                    <ul class="slips">
                      @for (s of employee().recentPayslips; track s.id) {
                        <li>
                          <a [routerLink]="['/payslips', s.id]"><span class="s-icon" aria-hidden="true"><mat-icon>receipt_long</mat-icon></span><span><strong>{{ periodLabel(s.period) }}</strong><small>Net {{ formatPaise(s.netPaise) }}</small></span></a>
                          <ph-status-badge [label]="s.paymentStatus === 'PAID' ? 'Paid' : 'Payment pending'" [tone]="s.paymentStatus === 'PAID' ? 'ok' : 'neutral'" />
                        </li>
                      } @empty { <li class="muted">No finalized payslips yet.</li> }
                    </ul>
                  </section>
                </div>
              } @else {
                <section class="card"><p>{{ employee().message }}</p></section>
              }

              <section class="card">
                <h2 class="card-title">Company announcements</h2>
                <ng-container *ngTemplateOutlet="announcementList; context: { $implicit: employee().announcements }"></ng-container>
              </section>
            }
          }
        }
      </ph-state>
    </div>

    <ng-template #announcementList let-items>
      <ul class="announce-list">
        @for (a of items; track a.id) {
          <li class="announce">
            <span class="a-icon" aria-hidden="true"><mat-icon>campaign</mat-icon></span>
            <div>
              <strong>{{ a.title }}</strong>
              <p>{{ a.body }}</p>
              <span class="muted small">{{ formatDate(a.publishAt.slice(0, 10)) }}</span>
            </div>
          </li>
        } @empty {
          <li class="muted">No announcements right now.</li>
        }
      </ul>
    </ng-template>
  `,
  styles: [
    `
      .hero { position: relative; overflow: hidden; display: flex; justify-content: space-between; align-items: center; gap: 24px; padding: 28px 32px; border-radius: var(--ph-radius-lg); background: linear-gradient(120deg, #312e81 0%, #4f46e5 55%, #0ea5e9 100%); color: #fff; box-shadow: var(--ph-shadow-md); }
      .hero::after { content: ''; position: absolute; inset: 0; background-image: radial-gradient(rgba(255,255,255,0.14) 1px, transparent 1px); background-size: 20px 20px; mask-image: linear-gradient(90deg, transparent 30%, #000); pointer-events: none; }
      .hero-text { position: relative; z-index: 1; }
      .date { font-size: 12.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.85; }
      .hero h1 { margin: 6px 0 6px; font-size: 28px; letter-spacing: -0.03em; }
      .hero p { margin: 0; opacity: 0.9; }
      .quick { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
      .quick-btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 10px; background: rgba(255,255,255,0.14); border: 1px solid rgba(255,255,255,0.22); color: #fff; text-decoration: none; font-weight: 600; font-size: 13px; transition: background-color var(--ph-dur-fast), transform var(--ph-dur-fast) var(--ph-ease); }
      .quick-btn:hover { background: rgba(255,255,255,0.24); transform: translateY(-1px); }
      .quick-btn mat-icon { font-size: 18px; width: 18px; height: 18px; }
      .hero-art { position: relative; z-index: 1; animation: ph-float 7s ease-in-out infinite; }
      .hb { transform-box: fill-box; transform-origin: 50% 100%; animation: ph-grow-y 700ms var(--ph-ease) both; }

      .card-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 6px; }
      .card-head .card-title { margin: 0; }
      .legend { font-size: 12px; color: var(--ph-text-muted); display: inline-flex; align-items: center; gap: 6px; }
      .sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
      .sw.p { background: var(--ph-primary); }
      .sw.l { background: var(--ph-warning); margin-left: 8px; }
      .muted { color: var(--ph-text-muted); }
      .small { font-size: 12px; }
      .sub-title { font-size: 13px; margin: 18px 0 10px; color: var(--ph-text-muted); text-transform: uppercase; letter-spacing: 0.06em; }

      .tasks, .people, .hol, .slips, .announce-list, .timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
      .tasks a { display: grid; grid-template-columns: 36px 1fr 20px; gap: 12px; align-items: center; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--ph-border); color: var(--ph-text); text-decoration: none; font-weight: 550; transition: border-color var(--ph-dur-fast), background-color var(--ph-dur-fast); }
      .tasks a:hover { border-color: var(--ph-primary); background: var(--ph-primary-soft); }
      .t-icon { width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center; background: var(--ph-warning-soft); color: var(--ph-warning); }
      .chev { color: var(--ph-text-subtle); }
      .all-clear { display: flex; gap: 10px; align-items: center; padding: 12px; border-radius: 12px; background: var(--ph-success-soft); color: var(--ph-success); font-weight: 600; }
      .timeline li { display: grid; grid-template-columns: 10px 1fr; column-gap: 12px; position: relative; }
      .timeline .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ph-primary); margin-top: 6px; grid-row: span 2; box-shadow: 0 0 0 3px var(--ph-primary-soft); }
      .timeline .what { font-weight: 550; font-size: 13px; }
      .timeline .when { font-size: 12px; grid-column: 2; }

      .people li { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; }
      .people span:not(.pill) { display: flex; flex-direction: column; min-width: 0; }
      .people small { color: var(--ph-text-muted); font-size: 12px; }
      .people a { color: var(--ph-text); font-weight: 600; text-decoration: none; }
      .people a:hover { color: var(--ph-primary); }
      .pill { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; background: var(--ph-surface-muted); border: 1px solid var(--ph-border); color: var(--ph-text-muted); white-space: nowrap; }
      .pill mat-icon { font-size: 15px; width: 15px; height: 15px; }
      .pill.cake { background: #fdf2f8; color: #be185d; border-color: transparent; }
      .pill.star { background: var(--ph-warning-soft); color: var(--ph-warning); border-color: transparent; }

      .team-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; }
      .member { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 6px; text-decoration: none; color: var(--ph-text); padding: 18px 12px; }
      .member small { color: var(--ph-text-muted); }

      .profile .who { display: flex; gap: 16px; align-items: center; margin-bottom: 14px; }
      .name { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
      .chips { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
      .facts { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 0 0 16px; }
      .facts dt { font-size: 12px; color: var(--ph-text-muted); }
      .facts dd { margin: 2px 0 0; font-weight: 600; }

      .balances { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
      .balance { border: 1px solid var(--ph-border); border-radius: 14px; padding: 14px; background: var(--ph-surface-muted); display: flex; flex-direction: column; gap: 6px; }
      .b-top { display: flex; justify-content: space-between; }
      .code { font-size: 11px; font-weight: 700; color: var(--ph-primary); background: var(--ph-primary-soft); padding: 1px 8px; border-radius: 999px; }
      .big { font-size: 26px; font-weight: 750; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
      .big small { font-size: 13px; font-weight: 500; color: var(--ph-text-muted); }
      .track { height: 6px; border-radius: 999px; background: var(--ph-border); overflow: hidden; }
      .track span { display: block; height: 100%; background: var(--ph-gradient-brand); transform-origin: left; animation: ph-grow-x 800ms var(--ph-ease) both; }

      .hol li { display: flex; gap: 12px; align-items: center; }
      .cal { width: 46px; border-radius: 10px; overflow: hidden; text-align: center; border: 1px solid var(--ph-border); background: var(--ph-surface); flex: none; }
      .cal b { display: block; font-size: 17px; padding: 3px 0 0; }
      .cal i { display: block; font-style: normal; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #fff; background: var(--ph-primary); padding: 1px 0; }
      .slips li { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
      .slips a { display: flex; gap: 12px; align-items: center; color: var(--ph-text); text-decoration: none; }
      .slips a span:last-child { display: flex; flex-direction: column; }
      .slips small { color: var(--ph-text-muted); }
      .s-icon { width: 38px; height: 38px; border-radius: 10px; display: grid; place-items: center; background: var(--ph-primary-soft); color: var(--ph-primary); }

      .announce { display: grid; grid-template-columns: 38px 1fr; gap: 12px; }
      .a-icon { width: 38px; height: 38px; border-radius: 10px; display: grid; place-items: center; background: var(--ph-info-soft); color: var(--ph-info); }
      .announce p { margin: 2px 0; color: var(--ph-text-muted); }

      @media (max-width: 760px) {
        .hero { padding: 22px; }
        .hero-art { display: none; }
        .hero h1 { font-size: 23px; }
      }
    `,
  ],
})
export class Dashboard implements OnInit {
  private readonly api = inject(Api);
  readonly auth = inject(Auth);
  private readonly title = inject(Title);

  readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  readonly data = signal<DashboardData | null>(null);
  readonly formatPaise = formatPaise;
  readonly formatDate = formatDate;
  readonly heroBars = [34, 52, 44, 66, 58];
  readonly todayLabel = new Date(`${todayYmd()}T12:00:00`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  readonly hr = computed(() => this.data() as HrDashboard);
  readonly manager = computed(() => this.data() as ManagerDashboard);
  readonly employee = computed(() => this.data() as EmployeeDashboard);
  readonly currentEmployeeId = computed(() => this.auth.user()?.employeeId ?? '');

  readonly greeting = computed(() => {
    const name = this.auth.user()?.name.split(' ')[0] ?? '';
    const hour = currentOrgHour();
    const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    return `${part}, ${name}`;
  });

  readonly subtitle = computed(() => {
    const d = this.data();
    if (!d) return 'Getting your workspace ready…';
    if (d.view === 'hr') return `Here's how ${this.auth.user()?.organizationName || 'your company'} is doing in ${monthName(currentYearMonth().month)}.`;
    if (d.view === 'manager') return 'Your team at a glance, and anything waiting for your decision.';
    return 'Your attendance, leave and pay in one place.';
  });

  readonly quickActions = computed(() => {
    const role = this.auth.user()?.role;
    if (role === 'HR_ADMIN' || role === 'SUPER_ADMIN') {
      return [
        { label: 'Add employee', icon: 'person_add', link: '/employees/new' },
        { label: 'Run payroll', icon: 'payments', link: '/payroll' },
        { label: 'Reports', icon: 'insights', link: '/reports' },
      ];
    }
    if (role === 'MANAGER') {
      return [
        { label: 'Approve leave', icon: 'event_available', link: '/leave' },
        { label: 'Team attendance', icon: 'schedule', link: '/attendance' },
      ];
    }
    return [
      { label: 'Request leave', icon: 'event_available', link: '/leave' },
      { label: 'My payslips', icon: 'receipt_long', link: '/payslips' },
    ];
  });

  readonly payrollHint = computed(() => {
    const p = this.hr().payroll;
    return p?.status ? `${monthName(p.period.month)} ${p.period.year} · ${p.status.toLowerCase()}` : 'No payroll run yet';
  });

  readonly attendanceBars = computed<BarDatum[]>(() =>
    this.hr().attendanceTrend.map((d) => ({ label: d.date.slice(8, 10), value: d.present, secondary: d.late })),
  );
  readonly payrollBars = computed<BarDatum[]>(() =>
    this.hr().payrollTrend.map((p) => ({ label: monthName(Number(p.period.slice(5))).slice(0, 3), value: Math.round(p.grossPaise / 100) })),
  );
  readonly deptSlices = computed(() => this.hr().departmentDistribution.map((d) => ({ label: d.name, value: d.count })));

  readonly int = (n: number) => String(Math.round(n));
  readonly inrShort = (n: number) => `₹${(n / 100000).toFixed(1)}L`;
  readonly inr = (n: number) => formatPaise(n).replace(/\.\d{2}$/, '');

  async ngOnInit() {
    this.title.setTitle('Dashboard | PeopleHub');
    await this.load();
  }

  async load(silent = false) {
    if (!silent) this.state.set('loading');
    try {
      this.data.set(await this.api.get<DashboardData>('/dashboard'));
      this.state.set('ready');
    } catch {
      this.state.set('error');
    }
  }

  usedPct(b: { entitled: number; used: number; pending: number }) {
    return b.entitled ? Math.min(100, Math.round(((b.used + b.pending) / b.entitled) * 100)) : 0;
  }

  taskIcon(key: string) {
    return TASK_ICONS[key] ?? 'flag';
  }

  shortMonth(ymd: string) {
    return monthName(Number(ymd.slice(5, 7))).slice(0, 3);
  }

  periodLabel(period: string) {
    return `${monthName(Number(period.slice(5, 7)))} ${period.slice(0, 4)}`;
  }

  humanize(action: string): string {
    return action.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  }

  instant(iso: string): string {
    return formatInstant(iso);
  }
}
