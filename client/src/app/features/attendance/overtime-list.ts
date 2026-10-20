import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { Api } from '../../core/api';
import { Notify } from '../../core/notify';
import { StateView, StatusBadge, confirmAction } from '../../shared/ui';
import { formatDate, formatMinutes } from '../../shared/format';
import { type LoadState, type OvertimeItem, type ReviewStatus, clock, reviewLabel, reviewTone } from './attendance.models';
import { CorrectionReviewDialog, type ReasonDialogData, type ReviewResult } from './correction-review-dialog';
import { OvertimeMinutesDialog, type OvertimeMinutesData, type OvertimeMinutesResult } from './overtime-minutes-dialog';

/**
 * Overtime claims. In "review" mode a manager (direct reports) or HR approves all or part of each day, rejects it
 * with a reason, or approves several days at once. In "mine" mode an employee sees the status of their own claims.
 * Only approved minutes are paid in payroll.
 */
@Component({
  selector: 'ph-overtime-list',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatButtonToggleModule, MatCheckboxModule, StateView, StatusBadge],
  template: `
    <section class="card" [attr.aria-labelledby]="headingId()">
      <div class="head">
        <div>
          <h2 [id]="headingId()" class="card-title">{{ mode() === 'review' ? 'Overtime to approve' : 'My overtime' }}</h2>
          <p class="muted small">{{ mode() === 'review'
            ? 'Days with 30 minutes or more beyond the shift. Only approved minutes are paid, at the company overtime rate.'
            : 'Overtime of 30 minutes or more goes to your manager. Approved minutes are paid with your salary.' }}</p>
        </div>
        <mat-button-toggle-group [value]="filter()" (change)="setFilter($event.value)" aria-label="Filter overtime by status" hideSingleSelectionIndicator>
          <mat-button-toggle value="PENDING">Pending</mat-button-toggle>
          <mat-button-toggle value="APPROVED">Approved</mat-button-toggle>
          <mat-button-toggle value="REJECTED">Rejected</mat-button-toggle>
        </mat-button-toggle-group>
      </div>

      @if (mode() === 'review' && filter() === 'PENDING' && reviewable().length > 1) {
        <div class="bulk" role="region" aria-label="Bulk actions">
          <mat-checkbox [checked]="allSelected()" [indeterminate]="someSelected()" (change)="toggleAll($event.checked)">Select all</mat-checkbox>
          <span class="muted small" aria-live="polite">{{ selected().size }} selected</span>
          <span class="spacer"></span>
          <button mat-stroked-button type="button" color="warn" [disabled]="!selected().size || busy()" (click)="reject(selectedIds())">Reject selected</button>
          <button mat-flat-button color="primary" type="button" [disabled]="!selected().size || busy()" (click)="approve(selectedIds())">Approve selected</button>
        </div>
      }

      <ph-state [state]="state()" (retry)="load()" title="Overtime could not be loaded">
        <div class="table-wrap">
          <table class="data">
            <caption class="sr-only">{{ mode() === 'review' ? 'Overtime claims to review' : 'Your overtime claims' }}</caption>
            <thead>
              <tr>
                @if (selectable()) { <th scope="col" class="check"><span class="sr-only">Select</span></th> }
                @if (mode() === 'review') { <th scope="col">Employee</th> }
                <th scope="col">Date</th>
                <th scope="col">In – out</th>
                <th scope="col" class="num">Worked</th>
                <th scope="col" class="num">Overtime</th>
                <th scope="col">Status</th>
                @if (selectable()) { <th scope="col"><span class="sr-only">Actions</span></th> }
              </tr>
            </thead>
            <tbody>
              @for (o of items(); track o.id) {
                <tr>
                  @if (selectable()) {
                    <td class="check">
                      @if (!o.isOwn) {
                        <mat-checkbox [checked]="selected().has(o.id)" (change)="toggle(o.id, $event.checked)" [aria-label]="'Select overtime of ' + o.employee.name + ' on ' + formatDate(o.workDate)" />
                      }
                    </td>
                  }
                  @if (mode() === 'review') { <td>{{ o.employee.name }} <div class="muted small">{{ o.employee.employeeCode }}</div></td> }
                  <td class="nowrap">{{ formatDate(o.workDate) }}</td>
                  <td class="nowrap">{{ clock(o.checkInAt) }} – {{ clock(o.checkOutAt) }}</td>
                  <td class="num">{{ minutes(o.workedMinutes) }}</td>
                  <td class="num"><strong>{{ minutes(o.overtimeMinutes) }}</strong></td>
                  <td>
                    <ph-status-badge [label]="statusLabel(o)" [tone]="reviewTone(o.status)" />
                    @if (o.comment) { <div class="muted small">{{ o.comment }}</div> }
                  </td>
                  @if (selectable()) {
                    <td class="actions">
                      @if (o.isOwn) {
                        <span class="muted small">Your own: another reviewer decides</span>
                      } @else {
                        <button mat-stroked-button type="button" [disabled]="busy()" (click)="approve([o.id])">Approve<span class="sr-only"> {{ o.employee.name }}, {{ formatDate(o.workDate) }}</span></button>
                        <button mat-button type="button" [disabled]="busy()" (click)="approvePart(o)">Part…<span class="sr-only"> approve part for {{ o.employee.name }}</span></button>
                        <button mat-button type="button" color="warn" [disabled]="busy()" (click)="reject([o.id])">Reject<span class="sr-only"> {{ o.employee.name }}, {{ formatDate(o.workDate) }}</span></button>
                      }
                    </td>
                  }
                </tr>
              } @empty {
                <tr><td [attr.colspan]="columns()" class="muted">{{ emptyText() }}</td></tr>
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
      .head { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; justify-content: space-between; margin-bottom: 12px; }
      .head p { margin: 4px 0 0; max-width: 60ch; }
      .bulk { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 8px 12px; margin-bottom: 12px; border: 1px solid var(--ph-border); border-radius: 12px; background: var(--ph-surface-muted); }
      .spacer { flex: 1; }
      .check { width: 44px; }
      .nowrap { white-space: nowrap; }
      .num { text-align: right; white-space: nowrap; }
      .actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
    `,
  ],
})
export class OvertimeList implements OnInit {
  private readonly api = inject(Api);
  private readonly notify = inject(Notify);
  private readonly dialog = inject(MatDialog);

  readonly mode = input<'review' | 'mine'>('review');

  readonly formatDate = formatDate;
  readonly minutes = formatMinutes;
  readonly clock = clock;
  readonly reviewTone = reviewTone;
  readonly filter = signal<ReviewStatus>('PENDING');
  readonly items = signal<OvertimeItem[]>([]);
  readonly state = signal<LoadState>('loading');
  readonly busy = signal(false);
  readonly selected = signal<Set<string>>(new Set());

  readonly headingId = computed(() => `overtime-${this.mode()}`);
  readonly selectedIds = computed(() => [...this.selected()]);
  readonly selectable = computed(() => this.mode() === 'review' && this.filter() === 'PENDING');
  readonly reviewable = computed(() => this.items().filter((o) => !o.isOwn));
  readonly allSelected = computed(() => this.reviewable().length > 0 && this.reviewable().every((o) => this.selected().has(o.id)));
  readonly someSelected = computed(() => this.selected().size > 0 && !this.allSelected());
  readonly columns = computed(() => 5 + (this.mode() === 'review' ? 1 : 0) + (this.selectable() ? 2 : 0));
  readonly emptyText = computed(() =>
    this.filter() === 'PENDING' ? (this.mode() === 'review' ? 'No overtime is waiting for a decision.' : 'No overtime waiting for approval.') : `No ${reviewLabel(this.filter()).toLowerCase()} overtime yet.`,
  );

  ngOnInit() {
    void this.load();
  }

  setFilter(value: ReviewStatus) {
    this.filter.set(value);
    void this.load();
  }

  async load() {
    this.state.set('loading');
    this.selected.set(new Set());
    try {
      const params = { status: this.filter(), ...(this.mode() === 'mine' ? { mine: 'true' } : {}) };
      this.items.set((await this.api.get<{ items: OvertimeItem[] }>('/attendance/overtime', params)).items);
      this.state.set('ready');
    } catch {
      this.state.set('error');
    }
  }

  statusLabel(o: OvertimeItem) {
    if (o.status === 'APPROVED' && o.approvedMinutes < o.overtimeMinutes) return `Approved ${formatMinutes(o.approvedMinutes)}`;
    return reviewLabel(o.status);
  }

  toggle(id: string, on: boolean) {
    const next = new Set(this.selected());
    if (on) next.add(id);
    else next.delete(id);
    this.selected.set(next);
  }

  toggleAll(on: boolean) {
    this.selected.set(on ? new Set(this.reviewable().map((o) => o.id)) : new Set());
  }

  async approve(ids: string[]) {
    if (ids.length > 1) {
      const ok = await confirmAction(this.dialog, {
        title: `Approve overtime for ${ids.length} days?`,
        message: 'All overtime on the selected days will be paid in the next payroll run for those months.',
        confirmLabel: 'Approve all',
      });
      if (!ok) return;
    }
    await this.send({ ids, decision: 'APPROVE' }, ids.length > 1 ? `Overtime approved for ${ids.length} days.` : 'Overtime approved.');
  }

  async approvePart(o: OvertimeItem) {
    const result = await firstValueFrom(
      this.dialog
        .open<OvertimeMinutesDialog, OvertimeMinutesData, OvertimeMinutesResult>(OvertimeMinutesDialog, {
          data: { name: o.employee.name, date: formatDate(o.workDate), overtimeMinutes: o.overtimeMinutes },
          width: 'min(440px, 94vw)',
        })
        .afterClosed(),
    );
    if (!result) return;
    await this.send({ ids: [o.id], decision: 'APPROVE', minutes: result.minutes, comment: result.comment || undefined }, `Approved ${formatMinutes(result.minutes)} of overtime.`);
  }

  async reject(ids: string[]) {
    const result = await firstValueFrom(
      this.dialog
        .open<CorrectionReviewDialog, ReasonDialogData, ReviewResult>(CorrectionReviewDialog, {
          data: { name: '', title: ids.length > 1 ? `Reject overtime for ${ids.length} days?` : 'Reject this overtime?', label: 'Reason (shared with the employee)', confirmLabel: 'Reject overtime' },
          width: 'min(460px, 94vw)',
        })
        .afterClosed(),
    );
    if (!result) return;
    await this.send({ ids, decision: 'REJECT', comment: result.comment }, ids.length > 1 ? `Overtime rejected for ${ids.length} days.` : 'Overtime rejected.');
  }

  private async send(body: { ids: string[]; decision: 'APPROVE' | 'REJECT'; minutes?: number; comment?: string }, success: string) {
    this.busy.set(true);
    const done = await this.notify.run(() => this.api.post('/attendance/overtime/review', body), success);
    this.busy.set(false);
    if (done !== undefined) await this.load();
  }
}
