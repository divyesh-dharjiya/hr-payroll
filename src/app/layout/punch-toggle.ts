import { ChangeDetectionStrategy, Component, OnInit, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { AttendanceState, formatDuration } from '../core/attendance-state';

/**
 * Header punch toggle. Switch on = punched in (running session), off = punched out.
 * On holidays and weekly offs the toggle is replaced by a non-interactive label, unless a session is still open
 * (then punching out stays available so the session can be closed).
 */
@Component({
  selector: 'ph-punch-toggle',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatIconModule, MatTooltipModule, MatProgressSpinnerModule],
  template: `
    @if (state.today(); as t) {
      @if (t.hasProfile) {
        @if (t.nonWorking && !t.canPunchOut) {
          <a class="off-day" routerLink="/attendance" [matTooltip]="t.nonWorking.kind === 'HOLIDAY' ? 'Company holiday: punching is off today' : 'Weekly off: punching is off today'">
            <mat-icon aria-hidden="true">{{ t.nonWorking.kind === 'HOLIDAY' ? 'celebration' : 'weekend' }}</mat-icon>
            <span class="lbl">{{ t.nonWorking.label }}</span>
          </a>
        } @else {
          <div class="punch" [class.on]="state.isOpen()">
            <span class="time" [attr.aria-label]="'Time punched today: ' + total()" matTooltip="Total punched today">
              <mat-icon aria-hidden="true">timer</mat-icon>{{ clock() }}
            </span>
            <button
              type="button"
              role="switch"
              class="switch"
              [attr.aria-checked]="state.isOpen()"
              [attr.aria-label]="state.isOpen() ? 'Punched in. Switch off to punch out' : 'Punched out. Switch on to punch in'"
              [disabled]="state.busy()"
              (click)="state.toggle()"
            >
              <span class="track" aria-hidden="true">
                <span class="thumb">
                  @if (state.busy()) { <mat-spinner diameter="14" /> } @else { <mat-icon>{{ state.isOpen() ? 'logout' : 'login' }}</mat-icon> }
                </span>
              </span>
              <span class="state-text">{{ state.isOpen() ? 'Punch out' : 'Punch in' }}</span>
            </button>
          </div>
        }
      }
    }
  `,
  styles: [
    `
      :host { display: inline-flex; }
      .punch { display: inline-flex; align-items: center; gap: 4px; padding: 3px 4px 3px 10px; border-radius: 999px; border: 1px solid var(--ph-border); background: var(--ph-surface); box-shadow: var(--ph-shadow-sm); transition: border-color var(--ph-dur) var(--ph-ease), background-color var(--ph-dur) var(--ph-ease); }
      .punch.on { border-color: color-mix(in srgb, var(--ph-success) 45%, transparent); background: var(--ph-success-soft); }
      .time { display: inline-flex; align-items: center; gap: 5px; font-variant-numeric: tabular-nums; font-weight: 650; font-size: 13px; color: var(--ph-text); min-width: 74px; }
      .time mat-icon { font-size: 16px; width: 16px; height: 16px; color: var(--ph-text-subtle); }
      .on .time mat-icon { color: var(--ph-success); animation: ph-pulse-ring 2s ease-out infinite; border-radius: 50%; }
      .switch { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; padding: 3px 12px 3px 3px; border-radius: 999px; font-weight: 650; font-size: 13px; color: #fff; background: var(--ph-primary); transition: background-color var(--ph-dur) var(--ph-ease), transform var(--ph-dur-fast) var(--ph-ease); }
      .switch:hover:not(:disabled) { transform: translateY(-1px); }
      .switch:focus-visible { outline: 2px solid var(--ph-primary); outline-offset: 2px; }
      .switch:disabled { cursor: progress; opacity: 0.8; }
      .on .switch { background: var(--ph-danger); }
      .track { width: 44px; height: 26px; border-radius: 999px; background: rgba(255, 255, 255, 0.28); position: relative; flex: none; }
      .thumb { position: absolute; top: 2px; left: 2px; width: 22px; height: 22px; border-radius: 50%; background: #fff; display: grid; place-items: center; color: var(--ph-primary); box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25); transition: transform var(--ph-dur) var(--ph-ease-spring), color var(--ph-dur); }
      .on .thumb { transform: translateX(18px); color: var(--ph-danger); }
      .thumb mat-icon { font-size: 14px; width: 14px; height: 14px; }
      .off-day { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; background: var(--ph-warning-soft); color: var(--ph-warning); font-weight: 600; font-size: 13px; text-decoration: none; }
      .off-day mat-icon { font-size: 17px; width: 17px; height: 17px; }
      @media (max-width: 720px) {
        .state-text, .off-day .lbl { display: none; }
        .switch { padding: 3px; }
        .time { min-width: 0; font-size: 12px; }
      }
    `,
  ],
})
export class PunchToggle implements OnInit {
  readonly state = inject(AttendanceState);
  readonly clock = computed(() => formatDuration(this.state.liveSeconds(), true));
  readonly total = computed(() => formatDuration(this.state.liveSeconds()));

  ngOnInit() {
    // Always reload: the shell is recreated after each sign-in, so this never shows another user's state.
    void this.state.load(true);
  }
}
