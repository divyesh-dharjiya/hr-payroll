import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Api, ApiError } from '../../core/api';
import { Notify, applyFieldErrors } from '../../core/notify';
import { StateView, StatusBadge } from '../../shared/ui';
import { formatDate, todayYmd } from '../../shared/format';
import { type Correction, type LoadState, clock, reviewLabel, reviewTone } from './attendance.models';

/**
 * Request a correction for a missed or wrong punch, and see earlier requests. Times are company wall-clock times
 * (the server reads them in the organization timezone), so the viewer's own timezone does not shift them.
 */
@Component({
  selector: 'ph-my-corrections',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, StateView, StatusBadge],
  template: `
    <section class="card" aria-labelledby="corr-title">
      <h2 id="corr-title" class="card-title">Attendance corrections</h2>
      <p class="muted small intro">Forgot to punch, or punched at the wrong time? Ask for a correction within 31 days. With both times, the day becomes one session; with one time, only the first punch-in or last punch-out changes.</p>
      <form [formGroup]="form" (ngSubmit)="submit()" novalidate class="correction" aria-label="Request a correction">
        <mat-form-field appearance="outline">
          <mat-label>Date</mat-label>
          <input matInput type="date" formControlName="workDate" [min]="minDate" [max]="today" required />
          @if (form.controls.workDate.hasError('server')) { <mat-error>{{ form.controls.workDate.getError('server') }}</mat-error> }
          @else if (form.controls.workDate.invalid && form.controls.workDate.touched) { <mat-error>Choose a date in the last 31 days.</mat-error> }
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Check-in time</mat-label>
          <input matInput type="time" formControlName="checkIn" />
          @if (form.controls.checkIn.hasError('server')) { <mat-error>{{ form.controls.checkIn.getError('server') }}</mat-error> }
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Check-out time</mat-label>
          <input matInput type="time" formControlName="checkOut" />
          @if (form.controls.checkOut.hasError('server')) { <mat-error>{{ form.controls.checkOut.getError('server') }}</mat-error> }
          @else { <mat-hint>Earlier than check-in means the next day</mat-hint> }
        </mat-form-field>
        <mat-form-field appearance="outline" class="reason">
          <mat-label>Reason</mat-label>
          <input matInput formControlName="reason" maxlength="500" required />
          @if (form.controls.reason.invalid && form.controls.reason.touched) { <mat-error>Explain the correction (at least 5 characters).</mat-error> }
        </mat-form-field>
        @if (needsTime()) { <p class="field-error" role="alert">Enter a check-in or a check-out time.</p> }
        <button mat-flat-button color="primary" type="submit" [disabled]="saving()">{{ saving() ? 'Sending…' : 'Request correction' }}</button>
      </form>
      <ph-state [state]="state()" (retry)="load()" title="Corrections could not be loaded">
        <div class="table-wrap">
          <table class="data">
            <caption class="sr-only">Your attendance correction requests</caption>
            <thead><tr><th scope="col">Date</th><th scope="col">Requested</th><th scope="col">Reason</th><th scope="col">Status</th></tr></thead>
            <tbody>
              @for (c of items(); track c.id) {
                <tr>
                  <td class="nowrap">{{ formatDate(c.workDate) }}</td>
                  <td class="nowrap">{{ clock(c.requestedCheckIn) }} – {{ clock(c.requestedCheckOut) }}</td>
                  <td>{{ c.reason }}@if (c.reviewComment) { <div class="muted small">Reviewer: {{ c.reviewComment }}</div> }</td>
                  <td><ph-status-badge [label]="reviewLabel(c.status)" [tone]="reviewTone(c.status)" /></td>
                </tr>
              } @empty {
                <tr><td colspan="4" class="muted">No correction requests yet.</td></tr>
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
      .intro { margin: 0 0 14px; }
      .nowrap { white-space: nowrap; }
      .correction { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 0 12px; align-items: start; margin-bottom: 16px; }
      .correction .reason { grid-column: span 2; }
      .correction button { margin-top: 8px; }
      .field-error { grid-column: 1 / -1; color: var(--ph-danger); font-size: 13px; margin: 0 0 8px; }
      @media (max-width: 640px) { .correction .reason { grid-column: auto; } }
    `,
  ],
})
export class MyCorrections implements OnInit {
  private readonly api = inject(Api);
  private readonly notify = inject(Notify);
  private readonly fb = inject(FormBuilder);

  readonly today = todayYmd();
  readonly minDate = shiftDays(this.today, -31);
  readonly formatDate = formatDate;
  readonly clock = clock;
  readonly reviewLabel = reviewLabel;
  readonly reviewTone = reviewTone;
  readonly items = signal<Correction[]>([]);
  readonly state = signal<LoadState>('loading');
  readonly saving = signal(false);
  readonly needsTime = signal(false);

  readonly form = this.fb.nonNullable.group({
    workDate: [this.today, [Validators.required]],
    checkIn: [''],
    checkOut: [''],
    reason: ['', [Validators.required, Validators.minLength(5)]],
  });

  ngOnInit() {
    void this.load();
  }

  async load() {
    this.state.set('loading');
    try {
      this.items.set((await this.api.get<{ items: Correction[] }>('/attendance/corrections', { mine: true })).items);
      this.state.set('ready');
    } catch {
      this.state.set('error');
    }
  }

  async submit() {
    this.form.markAllAsTouched();
    const v = this.form.getRawValue();
    this.needsTime.set(!v.checkIn && !v.checkOut);
    if (this.form.invalid || this.needsTime()) return;
    // A check-out earlier than the check-in belongs to the next day (overnight shift).
    const outDate = v.checkIn && v.checkOut && v.checkOut <= v.checkIn ? shiftDays(v.workDate, 1) : v.workDate;
    const body = {
      workDate: v.workDate,
      reason: v.reason,
      requestedCheckIn: v.checkIn ? `${v.workDate}T${v.checkIn}` : undefined,
      requestedCheckOut: v.checkOut ? `${outDate}T${v.checkOut}` : undefined,
    };
    this.saving.set(true);
    try {
      await this.api.post('/attendance/corrections', body);
      this.notify.success('Correction request sent for approval.');
      this.form.reset({ workDate: this.today, checkIn: '', checkOut: '', reason: '' });
      await this.load();
    } catch (err) {
      // Field messages sit next to their inputs; the toast carries the summary.
      applyFieldErrors({ get: (f: string) => this.form.get(f === 'requestedCheckIn' ? 'checkIn' : f === 'requestedCheckOut' ? 'checkOut' : f) }, err);
      this.notify.error(err instanceof ApiError ? err.message : 'Could not send the request.');
    } finally {
      this.saving.set(false);
    }
  }
}

function shiftDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
