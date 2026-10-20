import { ChangeDetectionStrategy, Component, EventEmitter, Input, OnChanges, Output, SimpleChanges, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { firstValueFrom, Observable } from 'rxjs';

// ---------------------------------------------------------------------------------------------------------------
// Shared UI primitives. Each one is small, OnPush, and renders text alongside colour (never colour alone).
// ---------------------------------------------------------------------------------------------------------------

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info';

@Component({
  selector: 'ph-status-badge',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="badge {{ tone }}">{{ label }}</span>`,
  styles: [`:host { display: inline-flex; }`],
})
export class StatusBadge {
  @Input({ required: true }) label = '';
  @Input() tone: Tone = 'neutral';
}

/** Animates a number from 0 to its value once, unless the user prefers reduced motion. */
function animateNumber(target: number, onFrame: (n: number) => void, duration = 700) {
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduce || typeof requestAnimationFrame === 'undefined' || target === 0) {
    onFrame(target);
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    onFrame(t === 1 ? target : Math.round(target * eased));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

@Component({
  selector: 'ph-stat-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  template: `
    <div class="stat card interactive" [class]="'tone-' + tone">
      <div class="stat-head">
        @if (icon) {
          <span class="chip" aria-hidden="true"><mat-icon>{{ icon }}</mat-icon></span>
        }
        <span class="stat-label">{{ label }}</span>
      </div>
      <div class="stat-value" [attr.aria-label]="label + ': ' + finalText()">{{ display() }}</div>
      @if (hint) {
        <div class="stat-hint">{{ hint }}</div>
      }
    </div>
  `,
  styles: [
    `
      :host { display: block; }
      .stat { display: flex; flex-direction: column; gap: 10px; height: 100%; padding: 18px; position: relative; overflow: hidden; }
      .stat::after { content: ''; position: absolute; inset: auto -30px -40px auto; width: 120px; height: 120px; border-radius: 50%; background: var(--chip-bg); opacity: 0.55; filter: blur(2px); pointer-events: none; }
      .stat-head { display: flex; align-items: center; gap: 10px; color: var(--ph-text-muted); }
      .chip { width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: var(--chip-bg); color: var(--chip-fg); flex: none; }
      .chip mat-icon { font-size: 19px; width: 19px; height: 19px; }
      .stat-label { font-size: 13px; font-weight: 550; }
      .stat-value { font-size: 28px; font-weight: 700; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; position: relative; }
      .stat-hint { font-size: 12px; color: var(--ph-text-subtle); position: relative; }
      @media (max-width: 640px) {
        .stat { padding: 14px; gap: 8px; }
        .stat::after { display: none; }
        .stat-head { flex-direction: column; align-items: flex-start; gap: 8px; }
        .stat-value { font-size: 22px; }
      }
      .tone-primary { --chip-bg: var(--ph-primary-soft); --chip-fg: var(--ph-primary); }
      .tone-ok { --chip-bg: var(--ph-success-soft); --chip-fg: var(--ph-success); }
      .tone-warn { --chip-bg: var(--ph-warning-soft); --chip-fg: var(--ph-warning); }
      .tone-bad { --chip-bg: var(--ph-danger-soft); --chip-fg: var(--ph-danger); }
      .tone-info { --chip-bg: var(--ph-info-soft); --chip-fg: var(--ph-info); }
    `,
  ],
})
export class StatCard implements OnChanges {
  @Input({ required: true }) label = '';
  @Input({ required: true }) value: string | number = '';
  @Input() hint = '';
  @Input() icon = '';
  @Input() tone: 'primary' | 'ok' | 'warn' | 'bad' | 'info' = 'primary';
  /** Formats animated numbers (for example, paise to rupees). Strings are shown as given. */
  @Input() format: (n: number) => string = (n) => n.toLocaleString('en-IN');

  readonly display = signal('');
  readonly finalText = signal('');

  // Runs after all inputs are set, so `format` is always applied regardless of binding order.
  ngOnChanges(changes: SimpleChanges) {
    if (!changes['value'] && !changes['format']) return;
    const v = this.value;
    if (typeof v === 'number') {
      this.finalText.set(this.format(v));
      animateNumber(v, (n) => this.display.set(this.format(n)));
    } else {
      this.finalText.set(v);
      this.display.set(v);
    }
  }
}

/** Loading skeleton, empty state, error state with retry. Pages wrap their content in this. */
@Component({
  selector: 'ph-state',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatProgressSpinnerModule],
  template: `
    @switch (state) {
      @case ('loading') {
        <div class="skeleton" role="status" aria-live="polite" [attr.aria-label]="loadingLabel">
          <div class="bar w60"></div>
          <div class="bar"></div>
          <div class="bar w80"></div>
          <div class="bar"></div>
          <span class="sr-only">{{ loadingLabel }}</span>
        </div>
      }
      @case ('error') {
        <div class="state error" role="alert">
          <mat-icon aria-hidden="true">error</mat-icon>
          <div>
            <strong>{{ title || 'We could not load this information.' }}</strong>
            <p class="muted">{{ message || 'Check your connection and try again.' }}</p>
          </div>
          @if (retry) {
            <button mat-stroked-button type="button" (click)="retry.emit()">Try again</button>
          }
        </div>
      }
      @case ('empty') {
        <div class="state empty">
          <mat-icon aria-hidden="true">{{ icon || 'inbox' }}</mat-icon>
          <div>
            <strong>{{ title || 'Nothing here yet' }}</strong>
            @if (message) {
              <p class="muted">{{ message }}</p>
            }
          </div>
          <ng-content select="[empty-action]"></ng-content>
        </div>
      }
      @default {
        <ng-content></ng-content>
      }
    }
  `,
  styles: [
    `
      .skeleton { display: grid; gap: 12px; padding: 20px; }
      .bar { height: 14px; border-radius: 6px; background: linear-gradient(90deg, #eef0f4 25%, #f8f9fb 37%, #eef0f4 63%); background-size: 400% 100%; animation: shimmer 1.4s ease infinite; }
      .w60 { width: 60%; } .w80 { width: 80%; }
      @keyframes shimmer { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }
      .state { display: flex; gap: 14px; align-items: center; padding: 28px 20px; border-radius: 12px; border: 1px dashed var(--ph-border); background: var(--ph-surface); flex-wrap: wrap; }
      .state mat-icon { font-size: 28px; width: 28px; height: 28px; color: var(--ph-text-muted); }
      .state p { margin: 4px 0 0; }
      .error { border-style: solid; border-color: #fecdca; background: var(--ph-danger-soft); }
      .error mat-icon { color: var(--ph-danger); }
      .muted { color: var(--ph-text-muted); }
      .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    `,
  ],
})
export class StateView {
  @Input() state: 'loading' | 'error' | 'empty' | 'ready' = 'ready';
  @Input() title = '';
  @Input() message = '';
  @Input() icon = '';
  @Input() loadingLabel = 'Loading';
  @Output() retry = new EventEmitter<void>();
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  requireReason?: boolean;
  reasonLabel?: string;
}

/** Confirmation dialog for destructive or irreversible actions. Resolves to true only on explicit confirm. */
@Component({
  selector: 'ph-confirm-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content>
      <p>{{ data.message }}</p>
      @if (data.requireReason) {
        <label class="reason">
          <span>{{ data.reasonLabel || 'Reason' }}</span>
          <textarea rows="3" [value]="reason" (input)="reason = $any($event.target).value" aria-required="true"></textarea>
        </label>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" [mat-dialog-close]="false">Cancel</button>
      <button
        mat-flat-button
        type="button"
        [color]="data.destructive ? 'warn' : 'primary'"
        [disabled]="data.requireReason && reason.trim().length < 3"
        (click)="confirm()"
      >
        {{ data.confirmLabel || 'Confirm' }}
      </button>
    </mat-dialog-actions>
  `,
  styles: [`.reason { display: grid; gap: 6px; margin-top: 12px; font-weight: 500; } textarea { font: inherit; padding: 10px; border-radius: 8px; border: 1px solid var(--ph-border); }`],
})
export class ConfirmDialog {
  readonly data = inject<ConfirmOptions>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<ConfirmDialog, string | boolean>>(MatDialogRef);
  reason = '';

  confirm() {
    this.ref.close(this.data.requireReason ? this.reason.trim() : true);
  }
}

/** Opens the confirmation dialog. Resolves to false (cancelled), true, or the entered reason. */
export async function confirmAction(dialog: MatDialog, options: ConfirmOptions): Promise<boolean | string> {
  const ref = dialog.open<ConfirmDialog, ConfirmOptions, string | boolean>(ConfirmDialog, {
    data: options,
    autoFocus: 'first-tabbable',
    width: 'min(440px, 92vw)',
  });
  const result = await firstValueFrom(ref.afterClosed() as Observable<string | boolean | undefined>);
  return result ?? false;
}
