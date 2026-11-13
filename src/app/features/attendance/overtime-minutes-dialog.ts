import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { formatMinutes } from '../../shared/format';

export interface OvertimeMinutesData {
  name: string;
  date: string;
  overtimeMinutes: number;
}

export interface OvertimeMinutesResult {
  minutes: number;
  comment: string;
}

/** Approve part of a day's overtime, for example when only an agreed hour should be paid. */
@Component({
  selector: 'ph-overtime-minutes-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>Approve part of the overtime</h2>
    <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
      <mat-dialog-content>
        <p class="lead">{{ data.name }} worked {{ total }} of overtime on {{ data.date }}.</p>
        <mat-form-field appearance="outline">
          <mat-label>Minutes to pay</mat-label>
          <input matInput type="number" inputmode="numeric" formControlName="minutes" [max]="data.overtimeMinutes" min="1" required />
          <mat-hint>Between 1 and {{ data.overtimeMinutes }}</mat-hint>
          @if (form.controls.minutes.invalid && form.controls.minutes.touched) { <mat-error>Enter between 1 and {{ data.overtimeMinutes }} minutes.</mat-error> }
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Note for {{ data.name }} (optional)</mat-label>
          <input matInput formControlName="comment" maxlength="500" />
        </mat-form-field>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" [mat-dialog-close]="null">Cancel</button>
        <button mat-flat-button color="primary" type="submit">Approve minutes</button>
      </mat-dialog-actions>
    </form>
  `,
  styles: [`.lead { margin: 0 0 14px; } mat-form-field { width: 100%; }`],
})
export class OvertimeMinutesDialog {
  readonly data = inject<OvertimeMinutesData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<OvertimeMinutesDialog, OvertimeMinutesResult>>(MatDialogRef);
  readonly total = formatMinutes(this.data.overtimeMinutes);
  readonly form = inject(FormBuilder).nonNullable.group({
    minutes: [Math.min(60, this.data.overtimeMinutes), [Validators.required, Validators.min(1), Validators.max(this.data.overtimeMinutes)]],
    comment: [''],
  });

  submit() {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    const v = this.form.getRawValue();
    this.ref.close({ minutes: Math.round(Number(v.minutes)), comment: v.comment.trim() });
  }
}
