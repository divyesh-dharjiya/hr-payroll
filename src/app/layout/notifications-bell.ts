import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { MatBadgeModule } from '@angular/material/badge';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Api } from '../core/api';

interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

const ICONS: Record<string, string> = {
  'leave.requested': 'event_upcoming',
  'leave.approved': 'event_available',
  'leave.rejected': 'event_busy',
  'leave.cancel_requested': 'event_repeat',
  'leave.cancellation_decided': 'event_note',
  'attendance.correction_requested': 'edit_calendar',
  'attendance.correction_reviewed': 'task_alt',
  'payroll.validated': 'fact_check',
  'payroll.payslip_ready': 'receipt_long',
  'payroll.draft': 'payments',
};

const POLL_MS = 60_000;

@Component({
  selector: 'ph-notifications-bell',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatBadgeModule, MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule],
  template: `
    <button
      mat-icon-button
      type="button"
      [matMenuTriggerFor]="menu"
      (menuOpened)="load()"
      [attr.aria-label]="unread() ? 'Notifications, ' + unread() + ' unread' : 'Notifications'"
      matTooltip="Notifications"
    >
      <mat-icon [matBadge]="unread() || null" matBadgeSize="small" matBadgeColor="warn" aria-hidden="true" [class.ring]="unread() > 0">notifications</mat-icon>
    </button>
    <mat-menu #menu="matMenu" xPosition="before" class="ph-notifications-menu">
      <div class="panel" (click)="$event.stopPropagation()" role="presentation">
        <div class="panel-head">
          <strong>Notifications</strong>
          @if (unread() > 0) {
            <button mat-button type="button" (click)="markAll()">Mark all read</button>
          }
        </div>
        @if (items().length === 0) {
          <div class="empty">
            <mat-icon aria-hidden="true">notifications_off</mat-icon>
            <p>You're all caught up.</p>
          </div>
        }
        <ul class="list">
          @for (n of items(); track n.id) {
            <li>
              <button type="button" class="item" [class.unread]="!n.readAt" (click)="open(n)">
                <span class="icon" aria-hidden="true"><mat-icon>{{ icon(n.kind) }}</mat-icon></span>
                <span class="text">
                  <span class="title">{{ n.title }}</span>
                  <span class="body">{{ n.body }}</span>
                  <span class="time">{{ ago(n.createdAt) }}</span>
                </span>
                @if (!n.readAt) { <span class="dot" aria-label="Unread"></span> }
              </button>
            </li>
          }
        </ul>
      </div>
    </mat-menu>
  `,
  styles: [
    `
      .ring { animation: ph-pulse-ring 2.4s ease-out infinite; border-radius: 50%; }
      .panel { width: min(380px, 92vw); max-height: 70vh; display: flex; flex-direction: column; }
      .panel-head { display: flex; justify-content: space-between; align-items: center; padding: 6px 12px 8px 16px; border-bottom: 1px solid var(--ph-border); }
      .list { list-style: none; margin: 0; padding: 4px; overflow-y: auto; }
      .item { all: unset; box-sizing: border-box; cursor: pointer; width: 100%; display: grid; grid-template-columns: 34px 1fr 10px; gap: 10px; padding: 10px; border-radius: 10px; align-items: start; }
      .item:hover, .item:focus-visible { background: var(--ph-surface-muted); }
      .item:focus-visible { outline: 2px solid var(--ph-primary); }
      .icon { width: 34px; height: 34px; border-radius: 10px; background: var(--ph-primary-soft); color: var(--ph-primary); display: grid; place-items: center; }
      .icon mat-icon { font-size: 18px; width: 18px; height: 18px; }
      .text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .title { font-weight: 600; font-size: 13px; }
      .body { font-size: 12.5px; color: var(--ph-text-muted); white-space: normal; }
      .time { font-size: 11.5px; color: var(--ph-text-subtle); }
      .unread .title::after { content: ''; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ph-primary); margin-top: 6px; }
      .empty { display: grid; justify-items: center; gap: 4px; padding: 28px 16px; color: var(--ph-text-muted); }
      .empty p { margin: 0; }
    `,
  ],
})
export class NotificationsBell implements OnInit {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  readonly items = signal<NotificationItem[]>([]);
  readonly unread = signal(0);

  ngOnInit() {
    void this.load();
    // Poll only while the tab is visible, to avoid background traffic.
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void this.load();
    }, POLL_MS);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }

  async load() {
    try {
      const res = await this.api.get<{ unread: number; items: NotificationItem[] }>('/notifications');
      this.items.set(res.items);
      this.unread.set(res.unread);
    } catch {
      // Notifications are non-critical; keep the last known state.
    }
  }

  async open(n: NotificationItem) {
    if (!n.readAt) {
      try {
        await this.api.post(`/notifications/${n.id}/read`);
      } catch {
        // Ignore: the item stays unread and can be retried.
      }
      await this.load();
    }
    if (n.link) await this.router.navigateByUrl(n.link);
  }

  async markAll() {
    try {
      await this.api.post('/notifications/read-all');
    } finally {
      await this.load();
    }
  }

  icon(kind: string) {
    return ICONS[kind] ?? 'notifications';
  }

  ago(iso: string): string {
    const diff = Math.max(0, Date.now() - new Date(iso).getTime());
    const m = Math.floor(diff / 60_000);
    if (m < 1) return 'Just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.floor(h / 24);
    return d < 30 ? `${d} day${d > 1 ? 's' : ''} ago` : new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  }
}
