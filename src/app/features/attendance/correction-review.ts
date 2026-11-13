import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { Api } from '../../core/api';
import { Notify } from '../../core/notify';
import { StateView, confirmAction } from '../../shared/ui';
import { formatDate } from '../../shared/format';
import { type Correction, type LoadState, clock } from './attendance.models';
import { CorrectionReviewDialog, type ReasonDialogData, type ReviewResult } from './correction-review-dialog';

/** Pending attendance corrections from the reviewer's scope (direct reports for managers, everyone for HR). */
@Component({
  selector: 'ph-correction-review',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, StateView],
  template: `
    <section class="card" aria-labelledby="review-title">
      <h2 id="review-title" class="card-title">Corrections waiting for review</h2>
      <ph-state [state]="state()" (retry)="load()" title="Review queue could not be loaded">
        <div class="table-wrap">
          <table class="data">
            <caption class="sr-only">Pending correction requests from your team</caption>
            <thead><tr><th scope="col">Employee</th><th scope="col">Date</th><th scope="col">Requested</th><th scope="col">Reason</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
            <tbody>
              @for (c of pending(); track c.id) {
                <tr>
                  <td>{{ c.employee.name }} <div class="muted small">{{ c.employee.employeeCode }}</div></td>
                  <td class="nowrap">{{ formatDate(c.workDate) }}</td>
                  <td class="nowrap">{{ clock(c.requestedCheckIn) }} – {{ clock(c.requestedCheckOut) }}</td>
                  <td>{{ c.reason }}</td>
                  <td class="actions">
                    <button mat-stroked-button type="button" [disabled]="busy()" (click)="review(c, 'APPROVE')">Approve<span class="sr-only"> correction for {{ c.employee.name }}</span></button>
                    <button mat-button type="button" color="warn" [disabled]="busy()" (click)="review(c, 'REJECT')">Reject<span class="sr-only"> correction for {{ c.employee.name }}</span></button>
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="5" class="muted">Nothing waiting for review.</td></tr>
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
      .nowrap { white-space: nowrap; }
      .actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
    `,
  ],
})
export class CorrectionReview implements OnInit {
  private readonly api = inject(Api);
  private readonly notify = inject(Notify);
  private readonly dialog = inject(MatDialog);

  readonly formatDate = formatDate;
  readonly clock = clock;
  readonly pending = signal<Correction[]>([]);
  readonly state = signal<LoadState>('loading');
  readonly busy = signal(false);

  ngOnInit() {
    void this.load();
  }

  async load() {
    this.state.set('loading');
    try {
      this.pending.set((await this.api.get<{ items: Correction[] }>('/attendance/corrections', { status: 'PENDING' })).items);
      this.state.set('ready');
    } catch {
      this.state.set('error');
    }
  }

  async review(c: Correction, decision: 'APPROVE' | 'REJECT') {
    let comment: string | undefined;
    if (decision === 'REJECT') {
      const result = await firstValueFrom(
        this.dialog
          .open<CorrectionReviewDialog, ReasonDialogData, ReviewResult>(CorrectionReviewDialog, { data: { name: c.employee.name }, width: 'min(460px, 94vw)' })
          .afterClosed(),
      );
      if (!result) return;
      comment = result.comment;
    } else {
      const ok = await confirmAction(this.dialog, {
        title: `Approve correction for ${c.employee.name}?`,
        message: 'The attendance record for that day will be updated and the change is written to the audit log.',
        confirmLabel: 'Approve',
      });
      if (!ok) return;
    }
    this.busy.set(true);
    const done = await this.notify.run(
      () => this.api.post(`/attendance/corrections/${c.id}/review`, { decision, comment }),
      decision === 'APPROVE' ? 'Correction approved.' : 'Correction rejected.',
    );
    this.busy.set(false);
    if (done !== undefined) await this.load();
  }
}
