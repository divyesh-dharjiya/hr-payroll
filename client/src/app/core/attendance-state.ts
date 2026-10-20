import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { Api, ApiError } from './api';
import { Notify } from './notify';

export interface PunchView {
  id: string;
  inAt: string;
  outAt: string | null;
  autoClosed: boolean;
  minutes: number | null;
}

export interface TodayState {
  workDate: string;
  timezone: string;
  shift: { start: string; end: string; graceMinutes: number; standardBreakMinutes: number };
  hasProfile: boolean;
  nonWorking: { kind: 'HOLIDAY' | 'WEEKLY_OFF'; label: string } | null;
  canPunchIn: boolean;
  canPunchOut: boolean;
  openSince: string | null;
  punches: PunchView[];
  summary: {
    sessions: number;
    punchedMinutes: number;
    breakMinutes: number;
    autoBreakMinutes: number;
    workedMinutes: number;
    lateMinutes: number;
    overtimeMinutes: number;
    status: 'PRESENT' | 'LATE' | 'HALF_DAY' | null;
    firstInAt: string | null;
    lastOutAt: string | null;
  };
  serverTime: string;
}

/**
 * Today's punch state, shared by the header toggle and the attendance card so they always agree.
 * While a session is open, a one-second tick drives the live "time today" counter.
 */
@Injectable({ providedIn: 'root' })
export class AttendanceState {
  private readonly api = inject(Api);
  private readonly notify = inject(Notify);
  private readonly doc = inject(DOCUMENT);

  readonly today = signal<TodayState | null>(null);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal(false);
  private readonly now = signal(Date.now());
  /** Difference between the server clock and this device, so the live counter uses server time. */
  private skewMs = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private loadedAt = 0;

  readonly isOpen = computed(() => Boolean(this.today()?.openSince));

  /** Seconds punched today, including the running session. */
  readonly liveSeconds = computed(() => {
    const t = this.today();
    if (!t) return 0;
    const closed = t.summary.punchedMinutes * 60;
    if (!t.openSince) return closed;
    const running = Math.max(0, Math.floor((this.now() + this.skewMs - new Date(t.openSince).getTime()) / 1000));
    // A session that started on an earlier day (night shift) is still shown as running time.
    return closed + running;
  });

  constructor() {
    // Refresh when the user returns to the tab, so a punch made on another device shows up.
    const onVisible = () => {
      if (this.doc.visibilityState === 'visible' && this.today() && Date.now() - this.loadedAt > 30_000) void this.load(true);
    };
    this.doc.addEventListener('visibilitychange', onVisible);
    inject(DestroyRef).onDestroy(() => {
      this.doc.removeEventListener('visibilitychange', onVisible);
      this.stopTick();
    });
  }

  async load(silent = false) {
    if (!silent) this.loading.set(true);
    try {
      this.apply(await this.api.get<TodayState>('/attendance/today'));
      this.error.set(false);
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /** Toggles punch in / punch out. Success is announced only after the server confirms it. */
  async toggle(): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(true);
    try {
      const res = await this.api.post<{ action: 'in' | 'out'; today: TodayState }>('/attendance/punch');
      this.apply(res.today);
      const at = new Intl.DateTimeFormat('en-IN', { timeZone: res.today.timezone, hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date());
      this.notify.success(res.action === 'in' ? `Punched in at ${at}.` : `Punched out at ${at}. Total today: ${formatDuration(this.liveSeconds())}.`);
      return true;
    } catch (err) {
      this.notify.error(err instanceof ApiError ? err.message : 'Could not record the punch. Please try again.');
      await this.load(true);
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  private apply(t: TodayState) {
    this.skewMs = new Date(t.serverTime).getTime() - Date.now();
    this.today.set(t);
    this.loadedAt = Date.now();
    this.now.set(Date.now());
    if (t.openSince) this.startTick();
    else this.stopTick();
  }

  private startTick() {
    if (this.timer) return;
    this.timer = setInterval(() => this.now.set(Date.now()), 1000);
  }

  private stopTick() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** 3725 seconds -> "1h 02m"; with seconds -> "01:02:05". */
export function formatDuration(totalSeconds: number, withSeconds = false): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (withSeconds) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
