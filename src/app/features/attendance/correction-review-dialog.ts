import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

export interface ReviewResult {
  comment: string;
}

export interface ReasonDialogData {
  name: string;
  title?: string;
  label?: string;
  confirmLabel?: string;
}

/**
 * Collects a required written reason, used when rejecting a request or asking for a cancellation.
 * The reason is stored with the decision so the other person can see it.
 */
@Component({
  selector: 'ph-reason-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>{{ data.title || 'Reject correction for ' + data.name }}</h2>
    <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
      <mat-dialog-content>
        <mat-form-field appearance="outline">
          <mat-label>{{ data.label || 'Reason for the reviewer' }}</mat-label>
          <textarea matInput rows="3" formControlName="comment" required></textarea>
          @if (form.controls.comment.invalid && form.controls.comment.touched) {
            <mat-error>Add a reason (at least 3 characters).</mat-error>
          }
        </mat-form-field>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" [mat-dialog-close]="null">Cancel</button>
        <button mat-flat-button color="warn" type="submit">{{ data.confirmLabel || 'Reject request' }}</button>
      </mat-dialog-actions>
    </form>
  `,
})
export class CorrectionReviewDialog {
  readonly data = inject<ReasonDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<CorrectionReviewDialog, ReviewResult>>(MatDialogRef);
  private readonly fb = inject(FormBuilder);
  readonly form = this.fb.nonNullable.group({ comment: ['', [Validators.required, Validators.minLength(3)]] });

  submit() {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    this.ref.close({ comment: this.form.getRawValue().comment.trim() });
  }
}
