import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { BreakpointObserver } from '@angular/cdk/layout';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Auth } from '../core/auth';
import { Theme } from '../core/theme';
import type { Permission, Role } from '../core/models';
import { Avatar } from '../shared/avatar';
import { NotificationsBell } from './notifications-bell';
import { PunchToggle } from './punch-toggle';
import { CommandPalette, type PaletteLink } from './command-palette';

interface NavItem {
  label: string;
  icon: string;
  link: string;
  /** Any listed permission grants the item. An empty list means every signed-in user can see it. */
  permissions: Permission[];
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const ROLE_LABEL: Record<Role, string> = {
  SUPER_ADMIN: 'Super Admin',
  HR_ADMIN: 'HR Admin',
  MANAGER: 'Manager',
  EMPLOYEE: 'Employee',
};

const NAV: NavGroup[] = [
  { label: 'Overview', items: [{ label: 'Dashboard', icon: 'space_dashboard', link: '/dashboard', permissions: [] }] },
  {
    label: 'People',
    items: [
      { label: 'Employees', icon: 'groups', link: '/employees', permissions: ['employees:read'] },
      { label: 'Attendance', icon: 'schedule', link: '/attendance', permissions: [] },
      { label: 'Leave', icon: 'event_available', link: '/leave', permissions: [] },
    ],
  },
  {
    label: 'Pay',
    items: [
      { label: 'Payroll', icon: 'payments', link: '/payroll', permissions: ['payroll:read'] },
      { label: 'My payslips', icon: 'receipt_long', link: '/payslips', permissions: [] },
    ],
  },
  { label: 'Insights', items: [{ label: 'Reports', icon: 'insights', link: '/reports', permissions: ['reports:read'] }] },
  {
    label: 'Company',
    items: [
      { label: 'Announcements', icon: 'campaign', link: '/admin/announcements', permissions: [] },
      { label: 'Holidays', icon: 'beach_access', link: '/admin/holidays', permissions: ['org:manage'] },
      { label: 'Organization', icon: 'apartment', link: '/admin/organization', permissions: ['org:manage'] },
      { label: 'Audit log', icon: 'fact_check', link: '/admin/audit', permissions: ['audit:read'] },
    ],
  },
];

/** Application shell: grouped sidebar (drawer on small screens), top bar with search, alerts, theme and account. */
@Component({
  selector: 'ph-shell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatSidenavModule,
    MatTooltipModule,
    Avatar,
    NotificationsBell,
    PunchToggle,
  ],
  template: `
    <mat-sidenav-container class="container">
      <mat-sidenav
        #drawer
        class="sidenav"
        [mode]="compact() ? 'over' : 'side'"
        [opened]="!compact() || drawerOpen()"
        (openedChange)="compact() && drawerOpen.set($event)"
        [fixedInViewport]="compact()"
        role="navigation"
        aria-label="Main navigation"
      >
        <a class="brand" routerLink="/dashboard" (click)="closeOnCompact()">
          <span class="logo" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="22" height="22"><path d="M8 24V8h9a6 6 0 0 1 0 12h-5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="23.5" cy="23.5" r="2.5" fill="#a5f3fc"/></svg>
          </span>
          <span>
            <span class="brand-name">PeopleHub</span>
            <span class="brand-sub">Lotus Technologies</span>
          </span>
        </a>

        <button type="button" class="search-trigger" (click)="openPalette()" aria-label="Search pages and people (Control K)">
          <mat-icon aria-hidden="true">search</mat-icon>
          <span>Search…</span>
          <kbd>Ctrl K</kbd>
        </button>

        <nav class="nav">
          @for (group of groups(); track group.label) {
            <div class="group">
              <div class="group-label">{{ group.label }}</div>
              @for (item of group.items; track item.link) {
                <a
                  class="nav-link"
                  [routerLink]="item.link"
                  routerLinkActive="active"
                  [routerLinkActiveOptions]="{ exact: item.link === '/dashboard' }"
                  (click)="closeOnCompact()"
                >
                  <mat-icon aria-hidden="true">{{ item.icon }}</mat-icon>
                  <span>{{ item.label }}</span>
                </a>
              }
            </div>
          }
        </nav>

        @if (user(); as u) {
          <div class="me">
            <ph-avatar [name]="u.name" [photoUrl]="u.photoUrl" [size]="36" />
            <div class="me-text">
              <div class="me-name">{{ u.name }}</div>
              <div class="me-role">{{ roleLabel(u.role) }}</div>
            </div>
          </div>
        }
      </mat-sidenav>

      <mat-sidenav-content class="main-area">
        <header class="topbar">
          @if (compact()) {
            <button mat-icon-button type="button" (click)="drawer.toggle()" aria-label="Open navigation menu" [attr.aria-expanded]="drawerOpen()">
              <mat-icon>menu</mat-icon>
            </button>
            <button mat-icon-button type="button" (click)="openPalette()" aria-label="Search">
              <mat-icon>search</mat-icon>
            </button>
          }
          <div class="spacer"></div>
          @if (user()?.employeeId) {
            <ph-punch-toggle class="punch-slot" />
          }
          <button mat-icon-button type="button" (click)="theme.toggle()" [attr.aria-label]="theme.isDark() ? 'Switch to light theme' : 'Switch to dark theme'" [matTooltip]="theme.isDark() ? 'Light theme' : 'Dark theme'">
            <mat-icon class="theme-icon">{{ theme.isDark() ? 'light_mode' : 'dark_mode' }}</mat-icon>
          </button>
          <ph-notifications-bell />
          @if (user(); as u) {
            <button mat-button type="button" [matMenuTriggerFor]="userMenu" class="user-btn" aria-label="Account menu">
              <ph-avatar [name]="u.name" [photoUrl]="u.photoUrl" [size]="32" [ring]="true" />
              <span class="user-meta">
                <span class="user-name">{{ u.name }}</span>
                <span class="user-role">{{ u.title ?? roleLabel(u.role) }}</span>
              </span>
              <mat-icon aria-hidden="true">expand_more</mat-icon>
            </button>
            <mat-menu #userMenu="matMenu" xPosition="before">
              <div class="menu-head" role="presentation">
                <ph-avatar [name]="u.name" [photoUrl]="u.photoUrl" [size]="44" />
                <div>
                  <strong>{{ u.name }}</strong>
                  <div class="muted">{{ u.email }}</div>
                  <span class="role-pill">{{ roleLabel(u.role) }}</span>
                </div>
              </div>
              @if (u.employeeId) {
                <a mat-menu-item [routerLink]="['/employees', u.employeeId]"><mat-icon>badge</mat-icon>My profile</a>
              }
              <a mat-menu-item routerLink="/payslips"><mat-icon>receipt_long</mat-icon>My payslips</a>
              <button mat-menu-item type="button" (click)="theme.toggle()"><mat-icon>contrast</mat-icon>{{ theme.isDark() ? 'Light theme' : 'Dark theme' }}</button>
              <button mat-menu-item type="button" (click)="auth.logout()"><mat-icon>logout</mat-icon>Sign out</button>
            </mat-menu>
          }
        </header>

        <main id="main" tabindex="-1" class="content">
          <router-outlet></router-outlet>
        </main>
      </mat-sidenav-content>
    </mat-sidenav-container>
  `,
  styles: [
    `
      .container { height: 100vh; background: var(--ph-bg); }
      .sidenav { width: 264px; background: var(--ph-surface); border-right: 1px solid var(--ph-border); display: flex; flex-direction: column; }
      :host ::ng-deep .sidenav .mat-drawer-inner-container { display: flex; flex-direction: column; }
      .brand { display: flex; gap: 12px; align-items: center; padding: 20px 18px 14px; text-decoration: none; color: inherit; }
      .logo { width: 38px; height: 38px; border-radius: 11px; background: var(--ph-gradient-brand); display: grid; place-items: center; box-shadow: 0 6px 16px -6px rgba(79, 70, 229, 0.6); }
      .brand-name { display: block; font-weight: 750; font-size: 16px; letter-spacing: -0.02em; }
      .brand-sub { display: block; font-size: 12px; color: var(--ph-text-subtle); }
      .search-trigger { all: unset; box-sizing: border-box; margin: 4px 14px 10px; display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--ph-border); background: var(--ph-surface-muted); color: var(--ph-text-subtle); cursor: pointer; transition: border-color var(--ph-dur-fast); }
      .search-trigger:hover { border-color: var(--ph-border-strong); }
      .search-trigger:focus-visible { outline: 2px solid var(--ph-primary); }
      .search-trigger span { flex: 1; }
      .search-trigger mat-icon { font-size: 18px; width: 18px; height: 18px; }
      kbd { font-family: inherit; font-size: 10.5px; padding: 1px 6px; border-radius: 6px; border: 1px solid var(--ph-border); background: var(--ph-surface); }
      .nav { display: flex; flex-direction: column; gap: 14px; padding: 6px 12px; flex: 1; overflow-y: auto; }
      .group { display: flex; flex-direction: column; gap: 2px; }
      .group-label { font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ph-text-subtle); padding: 4px 12px; }
      .nav-link { position: relative; display: flex; align-items: center; gap: 12px; padding: 9px 12px; border-radius: 10px; color: var(--ph-text-muted); text-decoration: none; font-weight: 550; transition: background-color var(--ph-dur-fast) var(--ph-ease), color var(--ph-dur-fast) var(--ph-ease), transform var(--ph-dur-fast) var(--ph-ease); }
      .nav-link:hover { background: var(--ph-surface-muted); color: var(--ph-text); transform: translateX(2px); }
      .nav-link.active { background: var(--ph-primary-soft); color: var(--ph-primary); }
      .nav-link.active::before { content: ''; position: absolute; left: -12px; top: 8px; bottom: 8px; width: 3px; border-radius: 0 3px 3px 0; background: var(--ph-primary); }
      .nav-link mat-icon { font-size: 20px; width: 20px; height: 20px; }
      .me { display: flex; gap: 10px; align-items: center; margin: 10px 12px 14px; padding: 10px; border-radius: 12px; background: var(--ph-gradient-soft); border: 1px solid var(--ph-border); }
      .me-name { font-weight: 600; font-size: 13px; }
      .me-role { font-size: 12px; color: var(--ph-text-muted); }
      .main-area { background: var(--ph-bg); }
      .topbar { position: sticky; top: 0; z-index: 3; height: 64px; display: flex; align-items: center; gap: 4px; padding: 0 16px; background: color-mix(in srgb, var(--ph-bg) 82%, transparent); backdrop-filter: saturate(160%) blur(10px); border-bottom: 1px solid var(--ph-border); }
      .spacer { flex: 1; }
      .punch-slot { margin-right: 6px; }
      .theme-icon { transition: transform var(--ph-dur-slow) var(--ph-ease-spring); }
      button:hover .theme-icon { transform: rotate(-25deg); }
      .user-btn { height: auto !important; padding: 4px 8px !important; margin-left: 6px; border-radius: 12px !important; }
      .user-btn ::ng-deep .mdc-button__label { display: flex; align-items: center; gap: 10px; }
      .user-meta { display: flex; flex-direction: column; text-align: left; line-height: 1.2; }
      .user-name { font-weight: 600; font-size: 13px; color: var(--ph-text); }
      .user-role { font-size: 12px; color: var(--ph-text-muted); }
      .menu-head { display: flex; gap: 12px; padding: 12px 16px; min-width: 260px; align-items: center; }
      .role-pill { display: inline-block; margin-top: 4px; font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 999px; background: var(--ph-primary-soft); color: var(--ph-primary); }
      .content { min-height: calc(100vh - 64px); outline: none; }
      /* Each routed page fades up as it enters (disabled under reduced motion by the global rule). */
      .content ::ng-deep > :not(router-outlet) { display: block; animation: ph-fade-up 340ms var(--ph-ease) both; }
      .muted { color: var(--ph-text-muted); font-size: 12.5px; }
      @media (max-width: 720px) { .user-meta { display: none; } }
    `,
  ],
})
export class Shell {
  readonly auth = inject(Auth);
  readonly theme = inject(Theme);
  private readonly dialog = inject(MatDialog);
  private readonly breakpoints = inject(BreakpointObserver);

  /** Drawer navigation below 1024px wide (tablets and phones). */
  readonly compact = toSignal(this.breakpoints.observe('(max-width: 1023.98px)').pipe(map((r) => r.matches)), { initialValue: false });
  readonly drawerOpen = signal(false);
  readonly user = this.auth.user;

  constructor() {
    // Start closed whenever the layout switches between docked sidebar and drawer.
    effect(() => {
      this.compact();
      untracked(() => this.drawerOpen.set(false));
    });
  }

  readonly groups = computed<NavGroup[]>(() => {
    if (!this.auth.user()) return [];
    return NAV.map((g) => ({ ...g, items: g.items.filter((i) => i.permissions.length === 0 || i.permissions.some((p) => this.auth.has(p))) })).filter(
      (g) => g.items.length > 0,
    );
  });

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      this.openPalette();
    }
  }

  openPalette() {
    if (this.dialog.openDialogs.some((d) => d.componentInstance instanceof CommandPalette)) return;
    const links: PaletteLink[] = this.groups().flatMap((g) => g.items.map((i) => ({ label: i.label, icon: i.icon, link: i.link, group: g.label })));
    const u = this.auth.user();
    if (u?.employeeId) links.push({ label: 'My profile', icon: 'badge', link: `/employees/${u.employeeId}`, group: 'Account' });
    if (this.auth.has('employees:write')) links.push({ label: 'Add employee', icon: 'person_add', link: '/employees/new', group: 'People' });
    this.dialog.open(CommandPalette, { data: { links }, width: 'min(620px, 94vw)', position: { top: '12vh' }, panelClass: 'ph-palette', autoFocus: 'first-tabbable' });
  }

  closeOnCompact() {
    if (this.compact()) this.drawerOpen.set(false);
  }

  roleLabel(role: Role) {
    return ROLE_LABEL[role];
  }
}
